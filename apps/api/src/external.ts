// For outside billing systems (the WHMCS and WISECP modules in integrations/): with a staff API token they order,
// suspend, resize and remove servers for their own customers. A customer is found by e-mail, or created (they set a
// password with "forgot password"). These servers are billed by that system, never by the panel's own billing: the
// integration acts for the billing system, so the customer's role and the customer switches do not limit it, and the
// owner cannot resize such a server or add disks to it in the panel (servers.ts refuseBilledElsewhere).
// `reference` (the service id there) makes every create idempotent and finds the server again.
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { audit, type AuthedRequest } from './auth';
import { getAuth } from './better-auth';
import { pool } from './db';
import { apiError } from './errors';
import { permissionsOf, splitRoles } from './permissions';
import { Can, PermissionGuard } from './rbac';
import { fingerprint, sshKeyPattern } from './smart-rules';
import { ServersController, startOperation } from './servers';

type Input = Record<string, unknown>;
const servers = new ServersController();
const refOk = (v: unknown) => typeof v === 'string' && /^[\w-]{1,60}$/.test(v);

// The customer as a request of their own, so quotas, keys and ownership are theirs.
async function asOwner(req: AuthedRequest, ownerId: string): Promise<AuthedRequest> {
  const { rows: [u] } = await pool.query('SELECT id, email, name, role, locale FROM users WHERE id = $1', [ownerId]);
  if (!u) throw apiError(404, 'NOT_FOUND', 'Unknown customer');
  return Object.assign(Object.create(req), { user: { id: u.id, email: u.email, name: u.name ?? '', roles: splitRoles(u.role), permissions: await permissionsOf(u.id, u.role),
    locale: u.locale === 'tr' ? 'tr' : 'en', timeZone: null, username: null, impersonatedBy: null, twoFactorEnabled: false, phoneNumber: null, phoneNumberVerified: false },
    externalBilling: true });
}

async function byReference(source: string, reference: string) {
  const { rows: [s] } = await pool.query("SELECT * FROM servers WHERE external_source = $1 AND external_ref = $2 AND state <> 'deleted'", [source, reference]);
  if (!s) throw apiError(404, 'NOT_FOUND', 'Unknown service');
  return s;
}

@Controller('admin/external/:source') @UseGuards(PermissionGuard)
export class ExternalController {
  // The customer by e-mail; created when new (a random password they never see). An existing account gets the order's
  // server, its console and its root password, so an e-mail match alone is not enough: with open registration or as a
  // reseller anyone can hold an account for a buyer's address before their first order. Matched are the account this
  // system created itself, and one whose owner proved the address (e-mail code or link, a provider's verified address, or
  // staff) and that is neither a reseller's customer, a reseller, nor another billing system's. Anything else is for the
  // administrator to resolve (verify, rename or remove the account in the panel), not for the order to guess.
  @Post('customers') @HttpCode(200) @Can('servers.manage_all', 'users.manage')
  async customer(@Req() req: AuthedRequest, @Param('source') source: string, @Body() body: Input) {
    if (!refOk(source)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { reference: 'INVALID_VALUE' });
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { email: 'INVALID_EMAIL' });
    const { rows: [u] } = await pool.query(`SELECT id, external_source = $2 AS own, external_source IS NULL AND email_verified AND reseller_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM resellers r WHERE r.user_id = users.id) AS proven FROM users WHERE email = $1`, [email, source]);
    if (u?.own || u?.proven) return { id: u.id, created: false };
    if (u) {
      await audit(req, 'external.customer_conflict', 'failure', req.user.id, { target: u.id, source });
      throw apiError(409, 'CUSTOMER_NEEDS_REVIEW', 'An account with this e-mail exists, but its address was never proven or it belongs to a reseller or another billing system; resolve it in the panel');
    }
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
    const { user } = await getAuth().api.createUser({ body: { email, password: randomBytes(24).toString('base64url'), name, role: 'user', data: { locale: body?.locale === 'tr' ? 'tr' : 'en' } } });
    await pool.query('UPDATE users SET email_verified = true, external_source = $2 WHERE id = $1', [user.id, source]);
    await audit(req, 'external.customer_created', 'success', req.user.id, { target: user.id, source });
    return { id: user.id, created: true };
  }

  // Orders a server for the customer. sshKey: a public key added to their keys (or the ids of keys they have).
  @Post('servers') @HttpCode(202) @Can('servers.manage_all')
  async create(@Req() req: AuthedRequest, @Param('source') source: string, @Body() body: Input) {
    if (!refOk(source) || !refOk(body?.reference)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { reference: 'INVALID_VALUE' });
    const { rows: [done] } = await pool.query('SELECT id FROM servers WHERE external_source = $1 AND external_ref = $2 AND state <> \'deleted\'', [source, body.reference]);
    if (done) return { serverId: done.id, existed: true };
    const ownerId = String(body?.customerId ?? '');
    const owner = await asOwner(req, ownerId);
    let sshKeyIds = Array.isArray(body?.sshKeyIds) ? body.sshKeyIds.map(String) : [];
    if (typeof body?.sshKey === 'string' && body.sshKey.trim()) {
      const key = body.sshKey.trim();
      if (!sshKeyPattern.test(key)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid key', { sshKey: 'INVALID_SSH_KEY' });
      const fp = fingerprint(key);
      const { rows: [k] } = await pool.query(`INSERT INTO ssh_keys (owner_id, name, public_key, fingerprint) VALUES ($1, $2, $3, $4)
        ON CONFLICT (owner_id, fingerprint) DO UPDATE SET name = ssh_keys.name RETURNING id`, [ownerId, `${source} ${String(body.reference)}`.slice(0, 60), key, fp]);
      sshKeyIds = [k.id];
    }
    const out = await servers.create(owner, `ext-${source}-${String(body.reference)}`.slice(0, 100), { ...body, sshKeyIds });
    await pool.query('UPDATE servers SET external_source = $2, external_ref = $3 WHERE id = $1', [out.serverId, source, body.reference]);
    await audit(req, 'external.server_created', 'success', req.user.id, { serverId: out.serverId, source, reference: body.reference });
    return out;
  }

  @Get('servers/:reference') @Can('servers.view_all')
  async get(@Param('source') source: string, @Param('reference') reference: string) {
    const s = await byReference(source, reference);
    const { rows: [ip] } = await pool.query("SELECT host(address) AS a FROM ip_allocations WHERE server_id = $1 AND kind = 'primary'", [s.id]);
    const { rows: [op] } = await pool.query('SELECT kind, status, step, error_code AS "errorCode" FROM operations WHERE server_id = $1 ORDER BY created_at DESC LIMIT 1', [s.id]);
    return { serverId: s.id, name: s.name, state: s.state, powerState: s.power_state, suspended: s.billing_hold, address: ip?.a ?? null, vcpu: s.vcpu, memoryMb: s.memory_mb, diskGb: s.disk_gb, lastOperation: op ?? null };
  }

  // Suspended for non-payment there: stopped and held like the panel's own billing does; unsuspend starts it again.
  @Post('servers/:reference/:action') @HttpCode(202) @Can('servers.manage_all')
  async act(@Req() req: AuthedRequest, @Param('source') source: string, @Param('reference') reference: string, @Param('action') action: string, @Body() body: Input) {
    const s = await byReference(source, reference);
    const key = `ext-${source}-${reference}-${action}-${Date.now()}`;
    if (action === 'suspend' || action === 'unsuspend') {
      await pool.query('UPDATE servers SET billing_hold = $2, updated_at = now() WHERE id = $1', [s.id, action === 'suspend']);
      const kind = action === 'suspend' ? (s.power_state === 'poweredOn' ? 'power_off' : null) : (s.power_state !== 'poweredOn' ? 'power_on' : null);
      // A power-off that cannot start now (another operation is open) is remembered and issued by the billing run.
      const operation = kind && s.state === 'ready' ? await startOperation(req, s, kind, key, key).catch(async () => {
        if (kind === 'power_off') await pool.query('UPDATE servers SET hold_power_off = true WHERE id = $1 AND billing_hold', [s.id]);
        return null;
      }) : null;
      await audit(req, `external.${action}`, 'success', req.user.id, { serverId: s.id, source, reference });
      return { serverId: s.id, suspended: action === 'suspend', operation };
    }
    if (['power_on', 'shutdown', 'power_off', 'reset'].includes(action)) {
      if (s.state !== 'ready' || !s.vm_moref) throw apiError(409, 'INVALID_SERVER_STATE', 'Not possible in this state');
      return { serverId: s.id, operation: await startOperation(req, s, action as 'reset', key, key) };
    }
    if (action === 'resize') return servers.resize(await asOwner(req, s.owner_id), key, s.id, body);
    throw apiError(404, 'NOT_FOUND', 'Unknown action');
  }

  @Delete('servers/:reference') @HttpCode(202) @Can('servers.manage_all')
  async remove(@Req() req: AuthedRequest, @Param('source') source: string, @Param('reference') reference: string) {
    const s = await byReference(source, reference);
    await pool.query('UPDATE servers SET locked = false WHERE id = $1', [s.id]); // the billing system decided; a lock is the customer's own guard
    // Now, without the deletion grace period: the customer could take the server back in it, and nobody would bill it.
    const out = await servers.remove(req, `ext-${source}-${reference}-delete`, s.id, { confirm: s.name, now: true });
    await audit(req, 'external.server_removed', 'success', req.user.id, { serverId: s.id, source, reference });
    return out;
  }
}
