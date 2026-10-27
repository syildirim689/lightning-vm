// Session management: better-auth owns sign-up, sign-in, sign-out, sessions, password reset, passkeys,
// two-factor (TOTP, codes by SMS/e-mail, backup codes), phone numbers and the admin user-management API.
// Users stay in the existing "users" table; better-auth's tables are auth_* (migrations 007, 008).
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { admin, emailOTP, genericOAuth, lastLoginMethod, magicLink, oneTap, phoneNumber, twoFactor, username } from 'better-auth/plugins';
import { isPasswordCompromised } from 'better-auth/plugins/haveibeenpwned';
import MailChecker from 'mailchecker';
import { passkey } from '@better-auth/passkey';
import { authSecret, config } from './config';
import { pool, redis } from './db';
import { logEvent } from './log';
import { otpText, sendOtpMail, sendPasswordReset, sendSignInLink } from './mail';
import { publishLive, type LiveKind } from './live-bus';
import { notify } from './notify';
import { adminEndpointPermission, betterAuthRoles, can, covers, effectivePermissions, ensureRoles, limitsOf, permissionsOf } from './permissions';
import { ipAllowed } from './role-limits';
import { deviceOf } from './device';
import { directorySignIn, refuseForDirectory } from './directory-signin';
import { hashPassword, sha256, verifyPassword } from './security';
import { activeCaptcha, getSettings, mailReady, mailUse, verifyCaptcha, type OidcSettings, type SignInSettings } from './settings-store';
import { socialProviders, socialIds } from './social-providers';
import { mayLink, providerId as ssoProviderId, ssoProvider, ssoSignedIn } from './sso';
import { sendSms, smsUse } from './sms';

// Browser consoles opened with any of these sessions are closed (the gateway matches sha256 of the token).
async function closeConsoles(userId: string) {
  const { rows } = await pool.query('SELECT token FROM auth_sessions WHERE user_id = $1', [userId]);
  await Promise.all(rows.map((r) => redis.publish('console:revoke', JSON.stringify({ authHash: sha256(r.token).toString('hex') })).catch(() => undefined)));
}

// Admin user-management calls that change an account, audited as admin.user.<action>.
const adminActions: Record<string, string> = { '/admin/create-user': 'create', '/admin/ban-user': 'ban', '/admin/unban-user': 'unban',
  '/admin/set-user-password': 'set_password', '/admin/remove-user': 'remove', '/admin/revoke-user-session': 'revoke_session', '/admin/revoke-user-sessions': 'revoke_sessions',
  '/admin/impersonate-user': 'impersonate', '/admin/stop-impersonating': 'stop_impersonating', '/admin/update-user': 'update' };
// Calls that act on another account: that account's permissions must lie within the caller's.
const targetsAccount = new Set(['/admin/ban-user', '/admin/unban-user', '/admin/set-user-password', '/admin/remove-user', '/admin/revoke-user-session',
  '/admin/revoke-user-sessions', '/admin/impersonate-user', '/admin/update-user']);
// Forms a captcha can protect, and the setting that turns it on for each.
const captchaPaths: Record<string, 'signIn' | 'signUp' | 'passwordReset'> = { '/sign-in/email': 'signIn', '/sign-up/email': 'signUp', '/request-password-reset': 'passwordReset',
  '/email-otp/send-verification-otp': 'signIn', '/sign-in/magic-link': 'signIn', '/sign-in/username': 'signIn' };
// Where a new password arrives (checked against known leaks when the admin turns that on), and its field.
const passwordFields: Record<string, string> = { '/sign-up/email': 'password', '/change-password': 'newPassword', '/reset-password': 'newPassword',
  '/admin/create-user': 'password', '/admin/set-user-password': 'newPassword' };
// Ways in that end in a session without a password form: the role's address limits are checked as the session is made.
const linkPaths = (p: string) => p.startsWith('/callback/') || p === '/one-tap/callback' || p === '/magic-link/verify';

const auditAuth = (actorId: string | null, action: string, outcome: 'success' | 'failure' | 'denied', ip: string | null, metadata: object = {}) =>
  pool.query('INSERT INTO audit_events (actor_id, action, outcome, ip, metadata) VALUES ($1, $2, $3, $4, $5)', [actorId, action, outcome, ip, metadata])
    .catch(() => logEvent('error', 'audit_failed', { action }));

// Same fixed-window counter as security.ts rateLimit, in better-auth's error type. Fails closed.
async function limit(key: string, max: number, windowSeconds: number) {
  const res = await redis.multi().incr(`rl:${key}`).expire(`rl:${key}`, windowSeconds, 'NX').exec().catch(() => null);
  if (!res) throw new APIError('SERVICE_UNAVAILABLE', { code: 'DEPENDENCY_UNAVAILABLE', message: 'Rate limiter unavailable' });
  if (Number(res[0]?.[1]) > max) throw new APIError('TOO_MANY_REQUESTS', { code: 'RATE_LIMITED', message: 'Too many attempts' });
}

// Whether a sign-in comes from a known place: the same browser and system, or the same network (/24, IPv6 /48),
// in a successful sign-in of the last 90 days. null: no earlier sign-in at all (nothing to compare with).
async function seenBefore(userId: string, device: string, ip: string | null) {
  const { rows: [r] } = await pool.query(`SELECT count(*)::int AS n,
      count(*) FILTER (WHERE metadata->>'device' = $2 OR ($3::inet IS NOT NULL AND ip IS NOT NULL AND family(ip) = family($3::inet)
        AND network(set_masklen(ip, CASE family(ip) WHEN 4 THEN 24 ELSE 48 END)) = network(set_masklen($3::inet, CASE family($3::inet) WHEN 4 THEN 24 ELSE 48 END))))::int AS known
    FROM audit_events WHERE actor_id = $1 AND action = 'auth.login' AND outcome = 'success' AND created_at > now() - interval '90 days'`, [userId, device, ip]).catch(() => ({ rows: [{ n: 0, known: 0 }] }));
  return r.n === 0 ? null : r.known > 0;
}

// The sign-in methods the admin turned on (Settings → Sign-in methods), and the checks on new passwords and addresses.
async function checkMethods(path: string, headers: Headers, body: Record<string, unknown>) {
  const ip = headers.get('x-lvm-client-ip') ?? '';
  if (path === '/sign-in/magic-link') {
    if (!signIn?.magicLink || !(await mailReady())) throw new APIError('FORBIDDEN', { code: 'MAGIC_LINK_DISABLED', message: 'Sign-in links are off' });
    const email = String(body.email ?? '').trim().toLowerCase();
    if (email) {
      await limit(`login:email:${email}`, 10, 900);
      // Directory and single sign-on accounts sign in where their password lives.
      const { rows: [u] } = await pool.query('SELECT role, auth_source FROM users WHERE lower(email) = $1', [email]);
      if (u && u.auth_source !== 'local' && u.auth_source !== 'social') throw new APIError('FORBIDDEN', { code: 'PASSWORD_MANAGED_BY_DIRECTORY', message: 'Sign in with your directory account' });
      await ensureRoles();
      if (u && !ipAllowed(limitsOf(u.role).allowedIps, ip)) throw new APIError('FORBIDDEN', { code: 'IP_NOT_ALLOWED', message: 'Not allowed from this address' });
    }
  }
  if (path === '/sign-in/username') {
    if (!signIn?.username) throw new APIError('FORBIDDEN', { code: 'USERNAME_SIGN_IN_DISABLED', message: 'Sign-in with a user name is off' });
    const name = String(body.username ?? '').trim().toLowerCase();
    if (name) {
      await limit(`login:user:${name}`, 10, 900);
      // Only panel passwords: a directory account would otherwise skip the directory.
      const { rows: [u] } = await pool.query('SELECT role, auth_source FROM users WHERE username = $1', [name]);
      if (u && u.auth_source !== 'local') throw new APIError('UNAUTHORIZED', { code: 'INVALID_USERNAME_OR_PASSWORD', message: 'Invalid username or password' });
      await ensureRoles();
      if (u && !ipAllowed(limitsOf(u.role).allowedIps, ip)) throw new APIError('FORBIDDEN', { code: 'IP_NOT_ALLOWED', message: 'Not allowed from this address' });
    }
  }
  if (path === '/update-user' && body.username !== undefined && !signIn?.username) throw new APIError('FORBIDDEN', { code: 'USERNAME_SIGN_IN_DISABLED', message: 'User names are off' });
  // Throwaway e-mail domains cannot open accounts (mailchecker's list).
  if (path === '/sign-up/email' && signIn?.blockDisposable && typeof body.email === 'string' && !MailChecker.isValid(body.email.trim()))
    throw new APIError('BAD_REQUEST', { code: 'DISPOSABLE_EMAIL', message: 'Use a permanent e-mail address' });
  // A new password that appears in known leaks is refused. Only the first 5 characters of its SHA-1 leave the
  // server (k-anonymity); if the service cannot be reached the password is accepted rather than blocking sign-up.
  const field = passwordFields[path];
  if (field && signIn?.pwnedPasswords && typeof body[field] === 'string' && body[field]) {
    const leaked = await isPasswordCompromised(body[field] as string).catch(() => { logEvent('error', 'pwned_check_failed'); return false; });
    if (leaked) throw new APIError('BAD_REQUEST', { code: 'PASSWORD_COMPROMISED', message: 'This password appears in known data breaches; choose another' });
  }
}

const forbidden = (code = 'FORBIDDEN') => new APIError('FORBIDDEN', { code, message: 'Permission required' });

// The staff permission check for better-auth's /admin/* endpoints. Deny by default.
async function checkAdminEndpoint(path: string, headers: Headers, body: Record<string, unknown>) {
  if (!(path in adminEndpointPermission)) throw forbidden();
  const need = adminEndpointPermission[path];
  if (!need) return;
  const s = await getAuth().api.getSession({ headers });
  if (!s) throw new APIError('UNAUTHORIZED', { code: 'UNAUTHENTICATED', message: 'Sign in required' });
  const mine = await permissionsOf(s.user.id, (s.user as { role?: string }).role ?? null);
  if (!can(mine, need)) throw forbidden();
  const target = String(body.userId ?? '');
  if (target && targetsAccount.has(path)) {
    // An admin cannot lock themselves out (ban, removal) or sign in as themselves.
    if (target === s.user.id && path !== '/admin/update-user' && path !== '/admin/revoke-user-session') throw new APIError('BAD_REQUEST', { code: 'CANNOT_CHANGE_OWN_ACCOUNT', message: 'Not on your own account' });
    if (target !== s.user.id && !covers(mine, await permissionsOf(target))) throw forbidden('FORBIDDEN_TARGET');
  }
  // Roles change only through PUT /admin/users/:id/access (it checks escalation); never through these calls.
  if (path === '/admin/create-user' && !covers(mine, effectivePermissions(String(body.role ?? 'user'), []))) throw forbidden('FORBIDDEN_TARGET');
  if (path === '/admin/update-user') {
    const data = (body.data ?? {}) as Record<string, unknown>;
    if (Object.keys(data).some((k) => !['name', 'email', 'locale'].includes(k))) throw forbidden();
  }
  // Servers belong to their owner; they must be deleted (VMs included) before the account is.
  if (path === '/admin/remove-user') {
    const { rows: [n] } = await pool.query("SELECT count(*)::int AS n FROM servers WHERE owner_id = $1 AND state <> 'deleted'", [target]);
    if (n.n > 0) throw new APIError('CONFLICT', { code: 'USER_HAS_SERVERS', message: "Delete the user's servers first" });
  }
  if (target && ['/admin/ban-user', '/admin/revoke-user-sessions', '/admin/remove-user', '/admin/set-user-password'].includes(path)) await closeConsoles(target);
}

function createAuth() {
  return betterAuth({
    appName: 'Lightning VM',
    database: pool,
    secret: authSecret(),
    // No baseURL: the browser's origin (from the request, which Fastify resolves through TRUSTED_PROXIES)
    // is used per request, so a domain change needs no restart. Passkey rpID follows it the same way.
    basePath: '/api/auth',
    user: {
      modelName: 'users',
      fields: { emailVerified: 'email_verified', createdAt: 'created_at', updatedAt: 'updated_at' },
      additionalFields: {
        locale: { type: ['tr', 'en'], required: false, defaultValue: 'en', input: true },
        authSource: { type: 'string', required: false, defaultValue: 'local', input: false, fieldName: 'auth_source' },
        timeZone: { type: 'string', required: false, input: false, fieldName: 'time_zone' },
        disabledAt: { type: 'date', required: false, input: false, fieldName: 'disabled_at' },
      },
      changeEmail: { enabled: false },
    },
    session: {
      modelName: 'auth_sessions',
      expiresIn: config.SESSION_TTL_HOURS * 3600,
      updateAge: 3600,
      fields: { userId: 'user_id', expiresAt: 'expires_at', ipAddress: 'ip_address', userAgent: 'user_agent', createdAt: 'created_at', updatedAt: 'updated_at' },
    },
    account: {
      // A provider that reports someone's address never gets that account by itself; linking is done on purpose,
      // signed in, from Account → Security (linkSocial). Single sign-on accounts are kept apart too (sso.ts).
      accountLinking: { enabled: true, disableImplicitLinking: true, allowDifferentEmails: false },
      // Providers' access and refresh tokens are stored encrypted (AES-256-GCM with the auth secret).
      encryptOAuthTokens: true,
      modelName: 'auth_accounts',
      fields: { userId: 'user_id', accountId: 'account_id', providerId: 'provider_id', accessToken: 'access_token', refreshToken: 'refresh_token', idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at', refreshTokenExpiresAt: 'refresh_token_expires_at', createdAt: 'created_at', updatedAt: 'updated_at' },
    },
    // Social sign-in (Settings → Sign-in methods): built from the settings each time better-auth is set up.
    socialProviders: signIn ? socialProviders(signIn, registrationOpen) : {},
    // A user name's availability is not public (it would tell who has an account).
    disabledPaths: ['/is-username-available'],
    verification: { modelName: 'auth_verifications', fields: { expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at' } },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 256,
      // The existing scrypt format (security.ts) stays, so accounts from before the move keep working.
      password: { hash: hashPassword, verify: ({ hash, password }) => verifyPassword(password, hash) },
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        if (!(await mailUse('passwordReset'))) throw new APIError('NOT_IMPLEMENTED', { code: 'MAIL_NOT_CONFIGURED', message: 'Mail is not configured' });
        await sendPasswordReset(user.email, (user as { locale?: string }).locale, url);
      },
      onPasswordReset: async ({ user }) => { await notify('auth.password_changed', [user.id], {}); },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: { '/sign-in/email': { window: 900, max: 30 }, '/sign-in/social': { window: 300, max: 30 }, '/sign-up/email': { window: 3600, max: 5 }, '/request-password-reset': { window: 3600, max: 5 },
        '/two-factor/send-otp': { window: 600, max: 5 }, '/phone-number/send-otp': { window: 600, max: 5 } },
      customStorage: {
        consume: async (key, rule) => {
          const k = `rl:ba:${key}`;
          const res = await redis.multi().incr(k).expire(k, rule.window, 'NX').exec().catch(() => null);
          if (!res) return { allowed: false, retryAfter: 5 }; // fail closed, like security.ts
          return Number(res[0]?.[1]) <= rule.max ? { allowed: true, retryAfter: null } : { allowed: false, retryAfter: rule.window };
        },
      },
    },
    advanced: {
      cookiePrefix: 'lvm',
      // Secure cookies are fixed at start; the installer knows whether the panel is served over HTTPS.
      useSecureCookies: config.PANEL_TLS === '1',
      // Fastify's req.ip honours TRUSTED_PROXIES; the route copies it here and overwrites any client value.
      ipAddress: { ipAddressHeaders: ['x-lvm-client-ip'] },
      database: { generateId: 'uuid' },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!ctx.request) return; // server-side calls (setup, CLI) are not gated
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        if (ctx.path.startsWith('/admin/')) await checkAdminEndpoint(ctx.path, ctx.request.headers, body);
        await checkMethods(ctx.path, ctx.request.headers, body);
        // Directory accounts sign in against the directory (and are created or brought up to date there).
        if (ctx.path === '/sign-in/email') await directorySignIn(ctx, body);
        await refuseForDirectory(ctx.path, ctx.request.headers, body);
        // A role may only be used from its addresses: said at sign-in, not after.
        if ((ctx.path === '/sign-in/email' || ctx.path === '/sign-in/email-otp' || ctx.path === '/email-otp/send-verification-otp') && typeof body.email === 'string') {
          const { rows: [u] } = await pool.query('SELECT role FROM users WHERE email = $1', [body.email.trim().toLowerCase()]);
          await ensureRoles();
          if (u && !ipAllowed(limitsOf(u.role).allowedIps, ctx.request.headers.get('x-lvm-client-ip') ?? '')) throw new APIError('FORBIDDEN', { code: 'IP_NOT_ALLOWED', message: 'Not allowed from this address' });
        }
        // Captcha, where the admin turned it on (Settings → Bot protection). The token comes in a header.
        const form = captchaPaths[ctx.path];
        if (form) {
          const c = await activeCaptcha();
          if (c && c.use[form]) {
            const token = ctx.request.headers.get('x-captcha-response');
            if (!token) throw new APIError('BAD_REQUEST', { code: 'CAPTCHA_REQUIRED', message: 'Captcha required' });
            const verdict = await verifyCaptcha(c.provider, c.secret(), token, ctx.request.headers.get('x-lvm-client-ip'), c.minScore);
            if (!verdict.ok) throw new APIError('FORBIDDEN', { code: 'CAPTCHA_FAILED', message: 'Captcha failed' });
          }
        }
        if (ctx.path === '/sign-up/email') {
          const { rows: [s] } = await pool.query("SELECT value FROM settings WHERE key = 'registration_open'");
          if (s?.value !== true) throw new APIError('FORBIDDEN', { code: 'REGISTRATION_CLOSED', message: 'Registration is closed' });
        }
        if (ctx.path === '/sign-in/email') {
          const email = String(body.email ?? '').toLowerCase();
          if (email) await limit(`login:email:${email}`, 10, 900);
        }
        // E-mail code sign-in: only when the admin turned it on, only for sign-in, never instead of two-factor.
        if (ctx.path.startsWith('/email-otp/') || ctx.path === '/sign-in/email-otp') {
          const email = String(body.email ?? '').toLowerCase();
          if (!(await getSettings('security')).emailCodeSignIn || !(await mailUse('twoFactor'))) throw new APIError('FORBIDDEN', { code: 'EMAIL_CODE_SIGN_IN_DISABLED', message: 'Sign-in with an e-mail code is off' });
          if (ctx.path !== '/sign-in/email-otp' && (ctx.path !== '/email-otp/send-verification-otp' || body.type !== 'sign-in')) throw new APIError('FORBIDDEN', { code: 'EMAIL_CODE_SIGN_IN_DISABLED', message: 'Only sign-in codes' });
          if (email) await limit(`login:email:${email}`, 10, 900);
          if (ctx.path === '/sign-in/email-otp') {
            const { rows: [u] } = await pool.query('SELECT two_factor_enabled FROM users WHERE lower(email) = $1', [email]);
            if (u?.two_factor_enabled) throw new APIError('FORBIDDEN', { code: 'TWO_FACTOR_USE_PASSWORD', message: 'Accounts with two-factor sign in with their password' });
          }
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (!ctx.request) return;
        const ip = ctx.request.headers.get('x-lvm-client-ip');
        const failed = ctx.context.returned instanceof Error;
        if (ctx.path in adminActions) {
          if (failed) return;
          const actor = (ctx.context.session as { user?: { id: string } } | null)?.user?.id ?? null;
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const target = (body.userId as string | undefined) ?? ((ctx.context.returned as { user?: { id?: string } } | undefined)?.user?.id ?? null);
          const extra = ctx.path === '/admin/ban-user' ? { reason: body.banReason ?? null, expiresIn: body.banExpiresIn ?? null } : {};
          // A password set by an administrator ends every session of that account.
          if (ctx.path === '/admin/set-user-password' && target) await ctx.context.internalAdapter.deleteUserSessions(target);
          await auditAuth(actor, `admin.user.${adminActions[ctx.path]}`, 'success', ip, { target, ...extra });
          const live: Record<string, LiveKind> = { '/admin/ban-user': 'ban', '/admin/unban-user': 'unban', '/admin/set-user-password': 'password', '/admin/remove-user': 'removed',
            '/admin/revoke-user-session': 'sessions', '/admin/revoke-user-sessions': 'sessions', '/admin/update-user': 'account' };
          if (target && live[ctx.path]) await publishLive(target, live[ctx.path]);
          return;
        }
        if (ctx.path === '/unlink-account' && !failed) {
          const uid = (ctx.context.session as { user?: { id: string } } | null)?.user?.id;
          if (uid) await auditAuth(uid, 'auth.account_unlinked', 'success', ip, { account: String((ctx.body as { accountId?: unknown })?.accountId ?? '') });
          return;
        }
        if (['/two-factor/enable', '/two-factor/disable'].includes(ctx.path) && !failed) {
          const uid = (ctx.context.session as { user?: { id: string } } | null)?.user?.id;
          if (uid) {
            const enabled = ctx.path === '/two-factor/enable';
            await auditAuth(uid, enabled ? 'auth.two_factor_enabled' : 'auth.two_factor_disabled', 'success', ip);
            await notify('auth.two_factor_changed', [uid], { enabled });
            await publishLive(uid, 'account');
          }
          return;
        }
        if (ctx.path === '/change-password' && !failed) {
          const uid = (ctx.context.session as { user?: { id: string } } | null)?.user?.id;
          if (uid) { await notify('auth.password_changed', [uid], {}); await publishLive(uid, 'password'); }
          return;
        }
        if (ctx.path !== '/sign-in/email' && ctx.path !== '/sign-up/email' && ctx.path !== '/sign-in/passkey' && ctx.path !== '/sign-in/email-otp' && !ctx.path.startsWith('/two-factor/verify-')
          && !linkPaths(ctx.path) && ctx.path !== '/sign-in/username') return;
        const created = ctx.context.newSession;
        // A password sign-in that still needs the second factor is neither a success nor a failure yet.
        if (!created && (ctx.context.returned as { twoFactorRedirect?: boolean } | undefined)?.twoFactorRedirect) return;
        const action = ctx.path === '/sign-up/email' ? 'auth.register' : 'auth.login';
        const provider = String((ctx.params as { id?: string } | undefined)?.id ?? '');
        const method = ctx.path.startsWith('/callback/') ? (provider === ssoProviderId ? 'sso' : provider || 'social') : ctx.path === '/one-tap/callback' ? 'google-one-tap'
          : ctx.path === '/magic-link/verify' ? 'magic-link' : ctx.path === '/sign-in/username' ? 'username' : ctx.path === '/sign-in/passkey' ? 'passkey' : ctx.path === '/sign-in/email-otp' ? 'email-code' : ctx.path.startsWith('/two-factor/') ? 'password+2fa' : 'password';
        const agent = ctx.request.headers.get('user-agent') ?? '';
        const device = deviceOf(agent);
        // Asked before this sign-in is recorded: has this person signed in from this device or network before?
        const seen = created && action === 'auth.login' ? await seenBefore(created.user.id, device, ip) : null;
        await auditAuth(created?.user.id ?? null, action, created ? 'success' : 'failure', ip,
          created ? { method, device } : { email: String((ctx.body as { email?: unknown })?.email ?? '').toLowerCase() });
        if (!created) return;
        if (action === 'auth.register') await notify('admin.user_registered', 'staff:users.view', { email: created.user.email });
        else await notify(seen === false ? 'auth.new_device' : 'auth.sign_in', [created.user.id], { ip: ip ?? '', agent, method, device });
      }),
    },
    databaseHooks: {
      // A single sign-on account never attaches to an existing panel or directory account (sso.ts).
      account: { create: {
        before: async (account) => { if (account.providerId === ssoProviderId && !(await mayLink(account.userId))) return false; },
        // A provider linked to an account (also the first one of an account it created): recorded, and the person told.
        after: async (account, ctx) => {
          if (account.providerId === 'credential') return;
          await auditAuth(account.userId, 'auth.account_linked', 'success', ctx?.request?.headers.get('x-lvm-client-ip') ?? null, { provider: account.providerId });
          await notify('auth.account_linked', [account.userId], { provider: account.providerId });
        },
      } },
      // An account made by a social provider is marked as such (two-factor is then the provider's, see auth.ts).
      user: { create: { before: async (user, ctx) => {
        const id = String((ctx?.params as { id?: string } | undefined)?.id ?? '');
        if ((ctx?.path.startsWith('/callback/') && (socialIds as string[]).includes(id)) || ctx?.path === '/one-tap/callback') return { data: { ...user, authSource: 'social' } };
      } } },
      session: {
        create: {
          // A disabled or banned account gets no new session (its old ones were revoked when it was disabled).
          before: async (session, ctx) => {
            const user = await ctx?.context.internalAdapter.findUserById(session.userId) as { disabledAt?: Date | null; banned?: boolean } | null;
            if (user?.disabledAt || user?.banned) return false;
            const via = String((ctx?.params as { id?: string } | undefined)?.id ?? '');
            if (sso && ctx?.path.startsWith('/callback/') && via === ssoProviderId && !(await ssoSignedIn(sso, session.userId, ctx.request?.headers.get('x-lvm-client-ip') ?? ''))) return false;
            // Social, One Tap and e-mail link sign-ins: the role's address limits apply as for a password.
            if (ctx && linkPaths(ctx.path) && via !== ssoProviderId) {
              const { rows: [u] } = await pool.query('SELECT role FROM users WHERE id = $1', [session.userId]);
              await ensureRoles();
              if (u && !ipAllowed(limitsOf(u.role).allowedIps, ctx.request?.headers.get('x-lvm-client-ip') ?? '')) return false;
            }
          },
        },
        delete: {
          // Every way a session ends (sign-out, revoke, password reset) also closes its browser consoles.
          after: async (session) => {
            await redis.publish('console:revoke', JSON.stringify({ authHash: sha256(session.token).toString('hex') })).catch(() => undefined);
          },
        },
      },
    },
    plugins: [
      // User management: list, create, ban with reason and expiry, password, sessions, impersonation, removal.
      // Roles come from the roles table (permissions.ts); the permission check itself is checkAdminEndpoint.
      admin({ roles: betterAuthRoles, defaultRole: 'user', impersonationSessionDuration: 3600,
        schema: { user: { fields: { banReason: 'ban_reason', banExpires: 'ban_expires' } }, session: { fields: { impersonatedBy: 'impersonated_by' } } } }),
      // TOTP (any authenticator app), one-time codes by SMS or e-mail, backup codes; repeated wrong codes lock verification.
      twoFactor({ issuer: 'Lightning VM', accountLockout: { enabled: true, maxFailedAttempts: 10, durationSeconds: 900 },
        otpOptions: {
          period: 5 * 60,
          sendOTP: async ({ user, otp }) => {
            const u = user as typeof user & { phoneNumber?: string | null; phoneNumberVerified?: boolean; locale?: string };
            if (u.phoneNumber && u.phoneNumberVerified && (await smsUse('twoFactor'))) {
              await sendSms(u.phoneNumber, otpText(u.locale, (await getSettings('branding')).name, otp));
            } else if (await mailUse('twoFactor')) {
              await sendOtpMail(u.email, u.locale, otp);
            } else {
              throw new APIError('NOT_IMPLEMENTED', { code: 'OTP_CHANNEL_UNAVAILABLE', message: 'No SMS or e-mail configured for codes' });
            }
          },
        },
        schema: { user: { fields: { twoFactorEnabled: 'two_factor_enabled' } }, twoFactor: { modelName: 'auth_two_factors',
          fields: { backupCodes: 'backup_codes', userId: 'user_id', failedVerificationCount: 'failed_verification_count', lockedUntil: 'locked_until' } } } }),
      // A verified phone number receives SMS codes and SMS notifications; verifying it needs SMS settings.
      phoneNumber({
        sendOTP: async ({ phoneNumber: to, code }, ctx) => {
          if (!(await smsUse('phoneVerification'))) throw new APIError('NOT_IMPLEMENTED', { code: 'SMS_NOT_CONFIGURED', message: 'SMS is not configured' });
          const locale = (ctx?.context.session?.user as { locale?: string } | undefined)?.locale;
          await sendSms(to, otpText(locale, (await getSettings('branding')).name, code));
        },
        phoneNumberValidator: (n) => /^\+[1-9]\d{7,14}$/.test(n),
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 5,
        schema: { user: { fields: { phoneNumber: 'phone_number', phoneNumberVerified: 'phone_number_verified' } } },
      }),
      // One-time code by e-mail instead of the password (Settings → Sign-in security). No sign-up through it.
      emailOTP({
        disableSignUp: true, otpLength: 6, expiresIn: 300, allowedAttempts: 5,
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (type !== 'sign-in') return;
          const { rows: [u] } = await pool.query('SELECT locale FROM users WHERE lower(email) = lower($1)', [email]);
          if (u) await sendOtpMail(email, u.locale, otp); // unknown addresses get nothing, and the answer is the same
        },
      }),
      // A one-time sign-in link by e-mail (Settings → Sign-in methods); existing accounts only, the token stored hashed.
      magicLink({
        disableSignUp: true, expiresIn: 600, storeToken: 'hashed',
        sendMagicLink: async ({ email, url }) => {
          const { rows: [u] } = await pool.query('SELECT locale FROM users WHERE lower(email) = lower($1)', [email]);
          if (u) await sendSignInLink(email, u.locale, url); // unknown addresses get nothing, and the answer is the same
        },
      }),
      // Sign-in with a user name instead of the e-mail address (when the admin allows it; set in Account → Profile).
      username({ displayUsername: false, minUsernameLength: 3, maxUsernameLength: 30, usernameValidator: (v) => /^[a-z0-9][a-z0-9._-]{2,29}$/i.test(v) }),
      // Google One Tap, with the Google provider's client.
      ...(signIn?.oneTap && signIn.providers.google?.enabled && signIn.providers.google.clientId ? [oneTap({ clientId: signIn.providers.google.clientId, disableSignup: !(signIn.socialSignUp && registrationOpen) })] : []),
      lastLoginMethod({ storeInDatabase: true, schema: { user: { lastLoginMethod: 'last_login_method' } } }),
      // Single sign-on (Settings → Directory → Single sign-on); no provider while it is off.
      genericOAuth({ config: sso?.enabled ? [ssoProvider(sso)] : [] }),
      passkey({
        rpName: 'Lightning VM',
        schema: { passkey: { modelName: 'auth_passkeys', fields: { publicKey: 'public_key', userId: 'user_id', credentialID: 'credential_id', deviceType: 'device_type', backedUp: 'backed_up', createdAt: 'created_at' } } },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
let instance: Auth | undefined;
// The single sign-on provider is part of better-auth's setup: a changed setting builds a new instance.
let sso: OidcSettings | null = null;
let signIn: SignInSettings | null = null;
let registrationOpen = false;
export async function reloadAuth() {
  sso = (await getSettings('directory')).oidc;
  signIn = await getSettings('signIn');
  registrationOpen = (await pool.query("SELECT value FROM settings WHERE key = 'registration_open'")).rows[0]?.value === true;
  instance = undefined;
}
// Built on first use: better-auth validates the schema once and caches it, so this must happen after migrations.
export const getAuth = () => (instance ??= createAuth());
