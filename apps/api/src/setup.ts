import { Body, CanActivate, Controller, ExecutionContext, Get, HttpCode, Injectable, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { pool, redis } from './db';
import { apiError } from './errors';
import { audit, currentUser, readCredentials, type User } from './auth';
import { getAuth } from './better-auth';
import { rememberPanelAddress } from './chat-delivery';
import { can, ensureRoles } from './permissions';
import { newToken, rateLimit, sha256 } from './security';
import { agentStatus, pendingRequests, queueRequest, settings as hostSettings } from './maintenance';
import { domainChecks, isLoopback, monitoringChecks, networkErrorCode, parseDomain, parsePublicUrl, serviceChecks, systemChecks, type Check } from './checks';

const bootstrapMinutes = 60;
const setupCookie = 'lvm_setup';
// Steps the wizard persists. 'admin' is derived from setup_state; 'summary' is the finish action.
const steps = ['language', 'checks', 'access', 'domain', 'services', 'vmware', 'discovery', 'pools', 'monitoring'] as const;
type Step = (typeof steps)[number];
const required: Step[] = ['language', 'checks', 'access', 'services'];
// Steps whose features arrive in later phases: they can only be skipped for now.
const notYetAvailable: Step[] = ['pools'];

// Called from the CLI on the server only: whoever can run it already controls the host.
export async function issueBootstrapToken() {
  const token = newToken();
  const { rowCount } = await pool.query(
    "UPDATE setup_state SET bootstrap_token_hash = $1, bootstrap_expires_at = now() + make_interval(mins => $2) WHERE admin_created_at IS NULL",
    [sha256(token), bootstrapMinutes]);
  return rowCount ? { token, expiresInMinutes: bootstrapMinutes } : null;
}

// The first admin: the setup slot is claimed under a row lock (one winner even with concurrent requests),
// then better-auth creates the account. If that fails the claim is undone so setup can be retried.
// check runs inside the lock and throws to refuse (e.g. a wrong bootstrap token).
async function createFirstAdmin(email: string, password: string, locale: 'tr' | 'en', check: (s: { bootstrap_token_hash: Buffer | null; fresh: boolean }) => void, completeSetup: boolean) {
  await ensureRoles(); // better-auth checks that the "admin" role exists
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [s] } = await client.query('SELECT bootstrap_token_hash, bootstrap_expires_at > now() AS fresh, admin_created_at FROM setup_state FOR UPDATE');
    if (s.admin_created_at) { await client.query('ROLLBACK'); return null; }
    check(s);
    await client.query(`UPDATE setup_state SET admin_created_at = now(), bootstrap_token_hash = NULL, bootstrap_expires_at = NULL${completeSetup ? ', completed_at = now()' : ''}`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  try {
    const { user } = await getAuth().api.createUser({ body: { email, password, name: '', role: 'admin', data: { locale } } });
    return user.id;
  } catch (err) {
    await pool.query('UPDATE setup_state SET admin_created_at = NULL, completed_at = NULL');
    throw err;
  }
}

// Unattended install (CLI on the server): creates the first admin with a generated password and closes
// the wizard. Returns null when an admin already exists; accounts are never replaced.
export async function provisionAdmin(email: string, locale: 'tr' | 'en') {
  const password = randomBytes(18).toString('base64url');
  const creds = readCredentials({ email, password });
  const id = await createFirstAdmin(creds.email, password, locale, () => undefined, true);
  if (!id) return null;
  await pool.query("INSERT INTO audit_events (actor_id, action, outcome, metadata) VALUES ($1, 'setup.admin_created', 'success', '{\"via\":\"installer\"}')", [id]);
  return { email: creds.email, password };
}

// CLI recovery for a lost password (no e-mail needed): a new generated password, all sessions signed out.
// Two-factor stays as it was; add --disable-2fa when the authenticator is lost too.
export async function resetPassword(email: string, disable2fa: boolean) {
  const { rows: [u] } = await pool.query('SELECT id FROM users WHERE lower(email) = lower($1)', [email.trim()]);
  if (!u) return null;
  const password = randomBytes(18).toString('base64url');
  const ctx = await getAuth().$context;
  if (!(await ctx.internalAdapter.findCredentialAccount(u.id))) return null;
  await ctx.internalAdapter.updatePassword(u.id, await ctx.password.hash(password));
  await ctx.internalAdapter.deleteUserSessions(u.id);
  if (disable2fa) {
    await pool.query('DELETE FROM auth_two_factors WHERE user_id = $1', [u.id]);
    await pool.query('UPDATE users SET two_factor_enabled = false WHERE id = $1', [u.id]);
  }
  await pool.query("INSERT INTO audit_events (actor_id, action, outcome, metadata) VALUES ($1, 'auth.password_reset_cli', 'success', $2)", [u.id, { via: 'cli', disable2fa }]);
  return { password };
}

// CLI recovery: lets an existing admin run the wizard again. It never touches accounts or data.
export async function reopenSetup() {
  const { rowCount } = await pool.query('UPDATE setup_state SET completed_at = NULL WHERE completed_at IS NOT NULL');
  await pool.query("INSERT INTO audit_events (action, outcome, metadata) VALUES ('setup.reopened', 'success', '{\"via\":\"cli\"}')");
  return rowCount === 1;
}

async function tokenValid(token: unknown) {
  const { rows: [s] } = await pool.query('SELECT bootstrap_token_hash, bootstrap_expires_at > now() AS fresh FROM setup_state');
  return typeof token === 'string' && !!s.bootstrap_token_hash && s.fresh && timingSafeEqual(sha256(token), s.bootstrap_token_hash);
}

// Before the first admin exists the bootstrap token (kept in an HttpOnly cookie) authorizes setup;
// afterwards only an admin session does. Once setup is completed every guarded endpoint is closed.
@Injectable()
export class SetupGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: User }>();
    const { rows: [s] } = await pool.query('SELECT admin_created_at, completed_at FROM setup_state');
    if (s.completed_at) throw apiError(409, 'SETUP_CLOSED', 'Setup is complete');
    if (!s.admin_created_at) {
      if (await tokenValid(req.cookies[setupCookie])) return true;
      throw apiError(401, 'BOOTSTRAP_REQUIRED', 'Setup token required');
    }
    const user = await currentUser(req);
    if (!user) throw apiError(401, 'UNAUTHENTICATED', 'Sign in required');
    if (!can(user.permissions, 'settings.manage')) throw apiError(403, 'FORBIDDEN', 'Permission required');
    req.user = user;
    return true;
  }
}

async function probeAccess(origin: string): Promise<Check> {
  if (isLoopback(origin)) return { id: 'access', ok: false, code: 'LOOPBACK_NOT_VERIFIABLE' };
  const nonce = randomBytes(16).toString('hex');
  await redis.set(`setup:probe:${nonce}`, '1', 'EX', 60);
  try {
    const res = await fetch(`${origin}/api/setup/probe/${nonce}`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { id: 'access', ok: false, code: 'HTTP_ERROR', detail: { status: res.status } };
    const body = await res.json().catch(() => null);
    return body?.nonce === nonce ? { id: 'access', ok: true, code: 'OK' } : { id: 'access', ok: false, code: 'WRONG_TARGET' };
  } catch (err) {
    return { id: 'access', ok: false, code: networkErrorCode(err) };
  } finally {
    await redis.del(`setup:probe:${nonce}`);
  }
}

const allOk = (checks: Check[]) => checks.every((c) => c.ok);

@Controller('setup')
export class SetupController {
  @Get('status')
  async status() {
    const { rows: [s] } = await pool.query('SELECT admin_created_at, completed_at FROM setup_state');
    return { adminCreated: !!s.admin_created_at, completed: !!s.completed_at };
  }

  // Answers our own reachability probe; reveals nothing but whether this nonce was just issued here.
  @Get('probe/:nonce')
  async probe(@Param('nonce') nonce: string) {
    if (!/^[0-9a-f]{32}$/.test(nonce) || !(await redis.exists(`setup:probe:${nonce}`))) throw apiError(404, 'NOT_FOUND', 'Unknown probe');
    return { nonce };
  }

  @Post('session') @HttpCode(204)
  async session(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Body() body: unknown) {
    await rateLimit(`setup:ip:${req.ip}`, 10, 900);
    const { rows: [s] } = await pool.query('SELECT admin_created_at FROM setup_state');
    if (s.admin_created_at) throw apiError(409, 'SETUP_CLOSED', 'Setup admin already exists');
    const token = (body as { token?: unknown })?.token;
    if (!(await tokenValid(token))) {
      await audit(req, 'setup.session', 'denied', null);
      throw apiError(403, 'BOOTSTRAP_TOKEN_INVALID', 'Bootstrap token invalid or expired');
    }
    reply.setCookie(setupCookie, token as string, { path: '/', httpOnly: true, sameSite: 'strict', secure: req.protocol === 'https', maxAge: bootstrapMinutes * 60 });
    await audit(req, 'setup.session', 'success', null);
  }

  @Get('progress') @UseGuards(SetupGuard)
  async progress() {
    const [{ rows }, { rows: [s] }] = await Promise.all([
      pool.query('SELECT step, status, data, updated_at FROM setup_progress'),
      pool.query('SELECT admin_created_at FROM setup_state'),
    ]);
    return { steps: Object.fromEntries(rows.map((r) => [r.step, { status: r.status, data: r.data, updatedAt: r.updated_at }])), adminCreated: !!s.admin_created_at };
  }

  @Post('checks') @HttpCode(200) @UseGuards(SetupGuard)
  async checks() { return { checks: await systemChecks() }; }

  @Post('test/services') @HttpCode(200) @UseGuards(SetupGuard)
  async testServices() { return { checks: await serviceChecks() }; }

  @Post('test/monitoring') @HttpCode(200) @UseGuards(SetupGuard)
  async testMonitoring() { return { checks: await monitoringChecks() }; }

  // Starts or stops the monitoring stack through the host agent, so nobody types commands on the server.
  // The wizard then polls test/monitoring until the components answer (Loki needs a minute after a start).
  @Post('monitoring') @HttpCode(202) @UseGuards(SetupGuard)
  async monitoring(@Req() req: FastifyRequest & { user?: User }, @Body() body: unknown) {
    const enabled = (body as { enabled?: unknown })?.enabled === true;
    if (hostSettings().agent !== 'on' || pendingRequests() < 0) throw apiError(409, 'MAINTENANCE_AGENT_MISSING', 'The host agent is not installed (sudo sh scripts/install.sh agent on)');
    const status = agentStatus();
    if (pendingRequests() > 0 || (status?.state === 'running' && Date.now() - Date.parse(status.startedAt) < 3 * 3600_000)) throw apiError(409, 'MAINTENANCE_BUSY', 'Another maintenance task is queued or running');
    const id = queueRequest({ action: 'monitoring', switch: enabled ? 'on' : 'off', by: req.user?.id ?? '' });
    await audit(req, 'setup.monitoring', 'success', req.user?.id ?? null, { id, enabled });
    return { id };
  }

  @Post('test/access') @HttpCode(200) @UseGuards(SetupGuard)
  async testAccess(@Req() req: FastifyRequest, @Body() body: unknown) {
    await rateLimit(`setup:probe:${req.ip}`, 30, 900);
    const origin = parsePublicUrl((body as { publicUrl?: unknown })?.publicUrl);
    if (!origin) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { publicUrl: 'INVALID_URL' });
    return { publicUrl: origin, checks: [await probeAccess(origin)] };
  }

  @Post('test/domain') @HttpCode(200) @UseGuards(SetupGuard)
  async testDomain(@Req() req: FastifyRequest, @Body() body: unknown) {
    await rateLimit(`setup:probe:${req.ip}`, 30, 900);
    const domain = parseDomain((body as { domain?: unknown })?.domain);
    if (!domain) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { domain: 'INVALID_DOMAIN' });
    return { domain, checks: await domainChecks(domain, probeAccess) };
  }

  // Server-side validation per step; a step can only be marked done when its own checks pass now.
  @Put('steps/:step') @UseGuards(SetupGuard)
  async saveStep(@Req() req: FastifyRequest & { user?: User }, @Param('step') step: string, @Body() body: unknown) {
    if (!steps.includes(step as Step)) throw apiError(404, 'NOT_FOUND', 'Unknown step');
    const { status, data } = (body ?? {}) as { status?: unknown; data?: Record<string, unknown> };
    if (status !== 'completed' && status !== 'skipped') throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { status: 'INVALID_VALUE' });
    if (status === 'skipped' && required.includes(step as Step)) throw apiError(400, 'STEP_REQUIRED', 'This step cannot be skipped');
    if (status === 'completed' && notYetAvailable.includes(step as Step)) throw apiError(400, 'STEP_NOT_AVAILABLE', 'Not available in this version');

    let saved: Record<string, unknown> = {};
    if (status === 'completed') {
      if (step === 'language') {
        if (data?.locale !== 'tr' && data?.locale !== 'en') throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { locale: 'INVALID_VALUE' });
        saved = { locale: data.locale };
      } else if (step === 'checks' || step === 'services') {
        const checks = step === 'checks' ? await systemChecks() : await serviceChecks();
        if (!allOk(checks)) throw apiError(409, 'CHECKS_FAILED', 'Checks are not passing');
        saved = { checks };
      } else if (step === 'access') {
        const origin = parsePublicUrl(data?.publicUrl);
        if (!origin) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { publicUrl: 'INVALID_URL' });
        // An unverifiable address (NAT hairpin, loopback) is still saved, flagged as unverified.
        const check = await probeAccess(origin);
        saved = { publicUrl: origin, verified: check.ok, code: check.code };
        await pool.query("UPDATE settings SET value = $1, updated_at = now() WHERE key = 'public_url'", [JSON.stringify(origin)]);
      } else if (step === 'domain') {
        const domain = parseDomain(data?.domain);
        if (!domain) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { domain: 'INVALID_DOMAIN' });
        const checks = await domainChecks(domain, probeAccess);
        if (!allOk(checks)) throw apiError(409, 'CHECKS_FAILED', 'Checks are not passing');
        saved = { domain, checks };
      } else if (step === 'vmware' || step === 'discovery') {
        // Connections are added through /admin/vmware; the step only records that one works.
        const { rows: [c] } = await pool.query(`SELECT count(*) FILTER (WHERE status = 'ok')::int AS ok,
          (SELECT count(*)::int FROM vmware_hosts) AS hosts FROM vmware_connections`);
        if (!c.ok) throw apiError(409, 'NO_VMWARE_CONNECTION', 'Add a working ESXi or vCenter connection first');
        if (step === 'discovery' && !c.hosts) throw apiError(409, 'CHECKS_FAILED', 'No hosts discovered');
        saved = { connections: c.ok, hosts: c.hosts };
      } else if (step === 'monitoring') {
        const enabled = data?.enabled === true;
        saved = enabled ? { enabled, checks: await monitoringChecks() } : { enabled };
      }
    }
    await pool.query(`INSERT INTO setup_progress (step, status, data) VALUES ($1, $2, $3)
      ON CONFLICT (step) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data, updated_at = now()`, [step, status, saved]);
    await audit(req, `setup.step.${step}`, 'success', req.user?.id ?? null, { status });
    return { step, status, data: saved };
  }

  @Post('complete') @HttpCode(200) @UseGuards(SetupGuard)
  async complete(@Req() req: FastifyRequest & { user?: User }, @Res({ passthrough: true }) reply: FastifyReply) {
    if (!req.user) throw apiError(409, 'ADMIN_REQUIRED', 'Create the admin account first');
    const { rows } = await pool.query('SELECT step FROM setup_progress WHERE step = ANY($1)', [required]);
    const missing = required.filter((s) => !rows.some((r) => r.step === s));
    if (missing.length) throw apiError(409, 'STEPS_INCOMPLETE', 'Required steps are missing', Object.fromEntries(missing.map((s) => [s, 'REQUIRED'])));
    await pool.query('UPDATE setup_state SET completed_at = now(), bootstrap_token_hash = NULL, bootstrap_expires_at = NULL');
    reply.clearCookie(setupCookie, { path: '/' });
    await audit(req, 'setup.completed', 'success', req.user.id);
    return { completed: true };
  }

  @Post('admin') @HttpCode(201)
  async createAdmin(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Body() body: unknown) {
    await rateLimit(`setup:ip:${req.ip}`, 10, 900);
    const token = (body as { token?: unknown })?.token ?? req.cookies[setupCookie];
    const { email, password } = readCredentials(body);
    const locale = (body as { locale?: string }).locale === 'tr' ? 'tr' : 'en';
    let id: string | null;
    try {
      id = await createFirstAdmin(email, password, locale, (s) => {
        if (typeof token !== 'string' || !s.bootstrap_token_hash || !s.fresh || !timingSafeEqual(sha256(token), s.bootstrap_token_hash)) {
          throw apiError(403, 'BOOTSTRAP_TOKEN_INVALID', 'Bootstrap token invalid or expired');
        }
      }, false);
    } catch (err) {
      if ((err as { getResponse?: () => { code?: string } }).getResponse?.().code === 'BOOTSTRAP_TOKEN_INVALID') await audit(req, 'setup.admin_created', 'denied', null);
      throw err;
    }
    if (!id) throw apiError(409, 'SETUP_CLOSED', 'Setup admin already exists');
    reply.clearCookie(setupCookie, { path: '/' });
    // Sign the new admin in through better-auth so the wizard continues with a normal session.
    const signIn = await getAuth().api.signInEmail({ body: { email, password }, headers: fromNodeHeaders(req.headers), returnHeaders: true });
    const cookies = signIn.headers.getSetCookie();
    if (cookies.length) reply.header('set-cookie', cookies);
    await audit(req, 'setup.admin_created', 'success', id);
    // Until the access step names the panel's address, the one the wizard was opened on stands for it (mail links).
    await rememberPanelAddress(`${req.protocol}://${req.host}`);
    return { id, email, role: 'admin', locale };
  }
}
