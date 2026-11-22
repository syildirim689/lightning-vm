// Session management: better-auth owns sign-up, sign-in, sign-out, sessions, password reset, passkeys,
// two-factor (TOTP, codes by SMS/e-mail, backup codes), phone numbers and the admin user-management API.
// Users stay in the existing "users" table; better-auth's tables are auth_* (migrations 007, 008).
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { admin, emailOTP, genericOAuth, lastLoginMethod, magicLink, oneTap, phoneNumber, twoFactor, username } from 'better-auth/plugins';
import { isPasswordCompromised } from 'better-auth/plugins/haveibeenpwned';
import MailChecker from 'mailchecker';
import { passkey } from '@better-auth/passkey';
import { clearVerification, sendFirstVerification } from './address-check';
import { authSecret, config } from './config';
import { pool, redis } from './db';
import { logEvent } from './log';
import { otpText, sendOtpMail, sendPasswordReset, sendSignInLink } from './mail';
import { publishLive, type LiveKind } from './live-bus';
import { dropPush, notify } from './notify';
import { adminEndpointPermission, betterAuthRoles, can, covers, effectivePermissions, ensureRoles, limitsOf, permissionsOf, releaseTickets } from './permissions';
import { createUserRequest, ipAllowed } from './role-limits';
import { deviceOf } from './device';
import { revokeConsoles } from './console-revoke';
import { isIP } from 'node:net';
import { panelBase, rememberPanelAddress } from './chat-delivery';
import { privateAddress } from './chat-apps';
import { directoryAccepted, directorySignIn, refuseForDirectory } from './directory-signin';
import { hashPassword, sha256, verifyPassword } from './security';
import { activeCaptcha, getSettings, mailReady, mailUse, verifyCaptcha, type OidcSettings, type SignInSettings } from './settings-store';
import { socialProviders, socialIds } from './social-providers';
import { mayLink, providerId as ssoProviderId, ssoProvider, ssoSignedIn } from './sso';
import { sendSms, smsUse } from './sms';
import { relabelRegistration, relabelTotp } from './labels';

// Browser consoles and host terminals opened with any of these people's sessions are closed (the gateways match
// sha256 of the token; console-revoke.ts also leaves the marker that refuses a ticket not redeemed yet). Also called when someone's access shrinks (rbac.ts), so an open one does not outlive it.
export async function closeConsoles(userIds: string | string[]) {
  const { rows } = await pool.query('SELECT token FROM auth_sessions WHERE user_id = ANY($1::uuid[])', [[userIds].flat()]).catch(() => ({ rows: [] as { token: string }[] }));
  await Promise.all(rows.map((r) => revokeConsoles({ authHash: sha256(r.token).toString('hex') })));
}
// A session started as someone else belongs to that person (user_id) and only names the staff member who started
// it: it ends with that staff member's access (a demotion, a ban, removal, their sessions being ended), with what it
// had open. They start it again if they still may. auth.ts checks the same on every request of such a session.
export async function endImpersonations(staffIds: string | string[]) {
  const { rows } = await pool.query('DELETE FROM auth_sessions WHERE impersonated_by = ANY($1::text[]) RETURNING token', [[staffIds].flat()]).catch(() => ({ rows: [] as { token: string }[] }));
  await Promise.all(rows.map((r) => revokeConsoles({ authHash: sha256(r.token).toString('hex') })));
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
// better-auth's routes the panel uses (the web app's calls, the links it mails, the providers' callbacks); /admin/* has
// its own list (permissions.ts). Every other route its plugins bring answers 404: phone-number sign-in and password
// reset, e-mail change, account deletion, provider tokens... A plugin added later is closed until its route is listed.
const panelPaths = new Set(['/ok', '/error', '/get-session', '/list-sessions', '/sign-out', '/sign-up/email',
  '/sign-in/email', '/sign-in/username', '/sign-in/social', '/sign-in/magic-link', '/magic-link/verify', '/sign-in/email-otp', '/email-otp/send-verification-otp',
  '/callback/:id', '/one-tap/callback', '/request-password-reset', '/reset-password', '/reset-password/:token', '/change-password', '/update-user',
  '/list-accounts', '/link-social', '/unlink-account',
  '/two-factor/enable', '/two-factor/disable', '/two-factor/generate-backup-codes', '/two-factor/send-otp', '/two-factor/verify-otp', '/two-factor/verify-totp', '/two-factor/verify-backup-code',
  '/phone-number/send-otp', '/phone-number/verify',
  '/passkey/generate-register-options', '/passkey/verify-registration', '/passkey/generate-authenticate-options', '/passkey/verify-authentication', '/passkey/list-user-passkeys', '/passkey/delete-passkey',
  '/passkey/update-passkey']);
// What stays on an account after the session that did it: not for staff acting as someone (as with API tokens, developer.ts).
const lastingPaths = new Set(['/passkey/generate-register-options', '/passkey/verify-registration', '/passkey/update-passkey', '/link-social', '/change-password', '/phone-number/send-otp', '/phone-number/verify',
  '/two-factor/enable', '/two-factor/disable', '/two-factor/generate-backup-codes']);
// Where the browser is sent afterwards: a path on this panel, whatever host name the request came with.
const redirectFields = ['callbackURL', 'errorCallbackURL', 'newUserCallbackURL', 'redirectTo'];
const panelPath = (v: unknown) => typeof v === 'string' && v.length <= 2000 && /^\/(?![/\\])/.test(v);
const invalid = () => new APIError('BAD_REQUEST', { code: 'VALIDATION_FAILED', message: 'Invalid input' });
const phonePattern = /^\+[1-9]\d{7,14}$/;

// Request input ends up in audit details: no single text longer than this is stored (auth.ts has the same rule).
const short = (v: unknown) => (typeof v === 'string' && v.length > 300 ? v.slice(0, 300) : v);
const auditAuth = (actorId: string | null, action: string, outcome: 'success' | 'failure' | 'denied', ip: string | null, metadata: object = {}) =>
  pool.query('INSERT INTO audit_events (actor_id, action, outcome, ip, metadata) VALUES ($1, $2, $3, $4, $5)', [actorId, action, outcome, ip, Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, short(v)]))])
    .catch(() => logEvent('error', 'audit_failed', { action }));

// Links in mail point at the panel's own address (PANEL_PUBLIC_URL, the domain, else the address given in setup or
// first seen), never at the host name a request arrived with. No address known (first run, local only): the request's,
// when that is this machine or a private network; any other name could be the sender's own, so nothing is mailed
// (null) and the log says what to set.
export async function onPanelAddress(url: string) {
  const base = await panelBase().catch(() => null);
  try {
    const u = new URL(url);
    if (base) return new URL(u.pathname + u.search, base).toString();
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && privateAddress(host))) return url;
    logEvent('error', 'auth_mail_not_sent_panel_address_unknown', { host: host.slice(0, 100), fix: 'set PANEL_PUBLIC_URL in .env (or the address in setup)' });
  } catch { /* not a URL: nothing to mail */ }
  return null;
}

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
      const { rows: [u] } = await pool.query('SELECT role, auth_source, two_factor_enabled FROM users WHERE lower(email) = $1', [email]);
      if (u && u.auth_source !== 'local' && u.auth_source !== 'social') throw new APIError('FORBIDDEN', { code: 'PASSWORD_MANAGED_BY_DIRECTORY', message: 'Sign in with your directory account' });
      // As for the e-mail code: a link in a mailbox is never the way in for an account with two-factor.
      if (u?.two_factor_enabled) throw new APIError('FORBIDDEN', { code: 'TWO_FACTOR_USE_PASSWORD', message: 'Accounts with two-factor sign in with their password' });
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

// A sign-in link or an e-mail code that was accepted proves the mailbox. The panel never asks new accounts to verify
// their address, so whoever registered it first may not be its owner: the first time the owner proves it, the library
// deletes the account's password, linked providers and sessions on these two routes and marks the address verified.
// The panel then removes what the library does not know about and an earlier holder could still use (addressProven).
// Once only: afterwards the address is verified and nothing is removed again. Staff marking an address verified by
// hand (user-security.ts) is not the owner's proof and removes nothing.
// A password set through a mailed reset link is the same proof (it is how most people get into an account that
// "already exists" under their address), but the library only replaces the password and ends the sessions there:
// provenByReset does the rest.
const provesMailbox = (path: string | undefined) => path === '/magic-link/verify' || path === '/sign-in/email-otp';
const provenBy = (path: string) => (path === '/magic-link/verify' ? 'magic-link' : path === '/reset-password' ? 'password-reset' : 'email-code');
// The requests in which the library is marking an address proven (seen in the user update's before-hook, which has
// the change but not the account; the after-hook has the account).
const proving = new WeakSet<object>();
// What the library removed in such a request before it marked the address proven (counted as each row went: by the
// time the account is known, they are gone).
const revoked = new WeakMap<object, { accounts: number; sessions: number }>();
const countRevoked = (ctx: { path?: string } | null | undefined, what: 'accounts' | 'sessions') => {
  if (!ctx || !provesMailbox(ctx.path)) return;
  const n = revoked.get(ctx) ?? { accounts: 0, sessions: 0 };
  n[what]++;
  revoked.set(ctx, n);
};
async function addressProven(userId: string, path: string, ip: string | null, library = { accounts: 0, sessions: 0 }) {
  const gone = async (sql: string) => (await pool.query(sql, [userId]).catch(() => ({ rowCount: 0 }))).rowCount ?? 0;
  const removed = {
    apiTokens: await gone('DELETE FROM api_tokens WHERE user_id = $1'),
    passkeys: await gone('DELETE FROM auth_passkeys WHERE user_id = $1'),
    webhooks: await gone('DELETE FROM webhooks WHERE user_id = $1'),
    chatConnections: await gone('DELETE FROM chat_connections WHERE user_id = $1'),
    pushSubscriptions: await gone('DELETE FROM push_subscriptions WHERE user_id = $1'),
    // A two-factor secret and backup codes someone set up but never switched on. One that is on stays: a link or a
    // code is never the way in for an account with two factors (the session is refused below), so it is not the
    // way to take its second factor away either; staff reset that.
    twoFactor: await gone('DELETE FROM auth_two_factors t USING users u WHERE t.user_id = $1 AND u.id = t.user_id AND NOT coalesce(u.two_factor_enabled, false)'),
    // A phone number the earlier holder verified would keep receiving the account's codes and notices.
    phoneNumber: await gone('UPDATE users SET phone_number = NULL, phone_number_verified = false WHERE id = $1 AND phone_number IS NOT NULL'),
    // Saved SSH keys are what a new server or a reinstall is given: one of the earlier holder's would let them into it.
    sshKeys: await gone('DELETE FROM ssh_keys WHERE owner_id = $1'),
    // A password step answered before the proof and still waiting for its code would end in a session after it (the
    // account's two-factor may be the earlier holder's); a browser they marked as trusted would skip the code.
    pendingSignIns: await gone("DELETE FROM auth_verifications WHERE value = $1::text AND (identifier LIKE '2fa-%' OR identifier LIKE 'trust-device-%')"),
    // A card the earlier holder stored would be charged for what the owner orders, and by the automatic collection.
    savedCards: await gone('DELETE FROM saved_cards WHERE owner_id = $1'),
    // Where invoices and payment notices go besides the account's own address.
    billingContact: await gone('UPDATE billing_profiles SET email = NULL, phone = NULL, updated_at = now() WHERE user_id = $1 AND (email IS NOT NULL OR phone IS NOT NULL)'),
    // A server the earlier holder offered to another account, not accepted yet: the owner decides that again.
    transferOffers: await gone("UPDATE server_transfers SET status = 'cancelled', decided_at = now() WHERE from_id = $1 AND status = 'pending'"),
  };
  // What stays, because it is the account's and removing it cannot be undone: servers, images, balance, tickets, the
  // invoice details. The owner sees all of it in the panel. It may still have been set up by someone else (who can
  // know a root password or have a key inside a server), so it is written down for staff: in the audit event and, when
  // there are servers, images or a balance, as a note on the person.
  const { rows: [kept = {}] } = await pool.query(`SELECT (SELECT count(*)::int FROM servers WHERE owner_id = $1 AND state <> 'deleted') AS servers,
      (SELECT count(*)::int FROM os_images WHERE owner_id = $1) AS images, (SELECT count(*)::int FROM balance_entries WHERE owner_id = $1) AS "balanceEntries",
      (SELECT count(*)::int FROM tickets WHERE owner_id = $1) AS tickets, (SELECT count(*)::int FROM billing_profiles WHERE user_id = $1) AS "billingProfile",
      (SELECT count(*)::int FROM users WHERE id = $1 AND reseller_id IS NOT NULL) AS "resellerManaged"`, [userId]).catch(() => ({ rows: [] as Record<string, number>[] }));
  if (kept.servers || kept.images || kept.balanceEntries) {
    await pool.query('INSERT INTO staff_notes (user_id, body) VALUES ($1, $2)', [userId, `The e-mail address of this account was proven for the first time (${provenBy(path)}). `
      + `It already had ${kept.servers ?? 0} server(s), ${kept.images ?? 0} image(s) and ${kept.balanceEntries ?? 0} balance entries, which stay with it. Whoever set them up may not be the person `
      + 'who now holds the mailbox and may still know a password or have a key inside a server. Sign-in details, API tokens, SSH keys and saved cards from before were removed.']).catch(() => undefined);
  }
  // Consoles opened with the sessions the library just ended were closed as each one went (session.delete below);
  // this covers what is left.
  await closeConsoles(userId);
  await endImpersonations(userId);
  await clearVerification(userId); // a verification code still waiting has nothing left to verify
  await auditAuth(userId, 'auth.address_proven', 'success', ip, { method: provenBy(path), removed: { password: true, linkedAccounts: true, otherSessions: true, ...removed }, kept });
  await publishLive(userId, 'sessions');
  // The person is told what happened, when something of theirs is gone: an account nothing was set up on (one staff
  // made, signed in to for the first time) lost nothing.
  if (library.accounts + library.sessions + Object.values(removed).reduce((a, n) => a + n, 0) > 0) await notify('auth.credentials_reset', [userId], { method: provenBy(path) });
}
// The first proof by a reset link. The library has replaced the password and ended the sessions; the linked providers
// go here, as they do on the other two routes, and then everything addressProven removes. Only the request that
// turns the mark on goes further (two resets at once, or a link used at the same moment, do it once).
async function provenByReset(userId: string, ip: string | null) {
  const { rowCount } = await pool.query('UPDATE users SET email_verified = true, updated_at = now() WHERE id = $1 AND NOT email_verified', [userId]);
  if (!rowCount) return;
  const { rowCount: accounts } = await pool.query("DELETE FROM auth_accounts WHERE user_id = $1 AND provider_id <> 'credential'", [userId]).catch(() => ({ rowCount: 0 }));
  await addressProven(userId, '/reset-password', ip, { accounts: accounts ?? 0, sessions: 0 });
}
// Where the passkey plugin signs in (/sign-in/passkey is only the client's name for it).
const passkeySignIn = '/passkey/verify-authentication';
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
  let target = String(body.userId ?? '');
  // Ending one session names it by its token, not by the account: the account is looked up, so the check below applies.
  if (path === '/admin/revoke-user-session' && typeof body.sessionToken === 'string') {
    const { rows: [t] } = await pool.query('SELECT user_id FROM auth_sessions WHERE token = $1', [body.sessionToken]);
    target = t?.user_id ?? '';
  }
  if (target && targetsAccount.has(path)) {
    // An admin cannot lock themselves out (ban, removal) or sign in as themselves.
    if (target === s.user.id && path !== '/admin/update-user' && path !== '/admin/revoke-user-session') throw new APIError('BAD_REQUEST', { code: 'CANNOT_CHANGE_OWN_ACCOUNT', message: 'Not on your own account' });
    if (target !== s.user.id && !covers(mine, await permissionsOf(target))) throw forbidden('FORBIDDEN_TARGET');
  }
  // Roles change only through PUT /admin/users/:id/access (it checks escalation); never through these calls.
  // The role is checked where better-auth reads it (role, else data.role); data sets nothing else but the language.
  if (path === '/admin/create-user') {
    const asked = createUserRequest(body);
    if (asked.extra.length) throw forbidden();
    // The same minimum a person signing up has to meet (better-auth applies its own only there).
    if (typeof body.password !== 'string' || body.password.length < 12) throw new APIError('BAD_REQUEST', { code: 'PASSWORD_TOO_SHORT', message: 'Password too short' });
    if (!covers(mine, effectivePermissions(asked.role, []))) throw forbidden('FORBIDDEN_TARGET');
  }
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
  // Sessions this person started as others end with their own (one session ended by staff: it cannot be told which
  // of them started which, so all do).
  if (target && ['/admin/ban-user', '/admin/revoke-user-session', '/admin/revoke-user-sessions', '/admin/remove-user', '/admin/set-user-password'].includes(path)) await endImpersonations(target);
  // One session ended by staff: the account's push subscriptions go with it (which browser it was is not known).
  // Here, while the session still says whose it is; the other calls name the account and are handled afterwards.
  if (target && path === '/admin/revoke-user-session') await dropPush(target);
}

// What the person's authenticator app and passkey manager will show (labels.ts): the panel's own name from Settings →
// Branding instead of better-auth's fixed one, and the account by its e-mail address, also when the browser asked for
// the passkey's own name as the WebAuthn user name. Only the labels change; secrets, challenges and ids stay.
const labelPaths = new Set(['/two-factor/enable', '/two-factor/get-totp-uri', '/passkey/generate-register-options']);
const panelLabels = createAuthMiddleware(async (ctx) => {
  const r = ctx.context.returned as Record<string, unknown> | undefined;
  const user = (ctx.context.session as { user?: { email?: string; name?: string | null } } | null)?.user;
  if (!r || r instanceof Error || r instanceof Response || typeof r !== 'object' || !user?.email) return;
  const brand = (await getSettings('branding')).name;
  if (ctx.path === '/passkey/generate-register-options') return ctx.json(relabelRegistration(r, brand, { email: user.email, name: user.name }));
  if (typeof r.totpURI === 'string') return ctx.json({ ...r, totpURI: relabelTotp(r.totpURI, brand, user.email) });
});

// Sign-ins and registrations: recorded and announced once the session really exists. This runs as the last plugin's
// hook, after the two-factor plugin's: for an account with two-factor the password step ends with that plugin taking
// the session away again (better-auth runs the configured after-hook before the plugins', where it still exists).
const recordSignIn = createAuthMiddleware(async (ctx) => {
  if (!ctx.request) return;
  if (ctx.path !== '/sign-in/email' && ctx.path !== '/sign-up/email' && ctx.path !== passkeySignIn && ctx.path !== '/sign-in/email-otp' && !ctx.path.startsWith('/two-factor/verify-')
    && !linkPaths(ctx.path) && ctx.path !== '/sign-in/username') return;
  const ip = ctx.request.headers.get('x-lvm-client-ip');
  const created = ctx.context.newSession;
  const body = (ctx.body ?? {}) as { email?: unknown; username?: unknown };
  const agent = ctx.request.headers.get('user-agent') ?? '';
  const device = deviceOf(agent);
  // The right password of an account with two-factor: no session yet, so neither a sign-in nor a failure. Recorded as
  // what it is (it never counts as a known device, and nobody is told they signed in).
  if (!created && !(ctx.context.returned instanceof Error) && (ctx.path === '/sign-in/email' || ctx.path === '/sign-in/username')) {
    const { rows: [u] } = ctx.path === '/sign-in/email'
      ? await pool.query('SELECT id FROM users WHERE lower(email) = $1', [String(body.email ?? '').trim().toLowerCase()]).catch(() => ({ rows: [] }))
      : await pool.query('SELECT id FROM users WHERE username = $1', [String(body.username ?? '').trim().toLowerCase()]).catch(() => ({ rows: [] }));
    await auditAuth(u?.id ?? null, 'auth.password_step', 'success', ip, { method: ctx.path === '/sign-in/username' ? 'username' : 'password', device });
    return;
  }
  const action = ctx.path === '/sign-up/email' ? 'auth.register' : 'auth.login';
  const provider = String((ctx.params as { id?: string } | undefined)?.id ?? '');
  const method = ctx.path.startsWith('/callback/') ? (provider === ssoProviderId ? 'sso' : provider || 'social') : ctx.path === '/one-tap/callback' ? 'google-one-tap'
    : ctx.path === '/magic-link/verify' ? 'magic-link' : ctx.path === '/sign-in/username' ? 'username' : ctx.path === passkeySignIn ? 'passkey' : ctx.path === '/sign-in/email-otp' ? 'email-code' : ctx.path.startsWith('/two-factor/') ? 'password+2fa' : 'password';
  // Asked before this sign-in is recorded: has this person signed in from this device or network before?
  const seen = created && action === 'auth.login' ? await seenBefore(created.user.id, device, ip) : null;
  await auditAuth(created?.user.id ?? null, action, created ? 'success' : 'failure', ip,
    created ? { method, device } : { email: String(body.email ?? '').toLowerCase().slice(0, 254) });
  if (!created) return;
  if (action === 'auth.register') {
    await notify('admin.user_registered', 'staff:users.view', { email: created.user.email });
    // The address is asked to be verified straight away (when mail works; address-check.ts). Not awaited.
    if (!created.user.emailVerified) sendFirstVerification({ id: created.user.id, email: created.user.email, locale: (created.user as { locale?: string }).locale });
  }
  else await notify(seen === false ? 'auth.new_device' : 'auth.sign_in', [created.user.id], { ip: ip ?? '', agent, method, device });
  // An administrator signed in and the panel still knows no address of its own: this one is kept (chat-delivery.ts).
  if (action === 'auth.login' && String((created.user as { role?: string }).role ?? '').split(',').includes('admin') && !(await panelBase().catch(() => 'unknown'))) {
    try { await rememberPanelAddress(new URL(ctx.request.url).origin); } catch { /* no usable address */ }
  }
});

function createAuth() {
  return betterAuth({
    appName: 'Lightning VM',
    database: pool,
    secret: authSecret(),
    // No baseURL: the browser's origin (from the request, which Fastify resolves through TRUSTED_PROXIES)
    // is used per request, so a domain change needs no restart and the panel stays reachable under another name
    // (an SSH tunnel). Passkey rpID follows it the same way. What must not follow the request does not: links in
    // mail are put on the panel's own address (onPanelAddress) and redirect targets are paths (redirectFields).
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
        const link = await onPanelAddress(url);
        if (link) await sendPasswordReset(user.email, (user as { locale?: string }).locale, link);
      },
      // Every session ended with the old password: so do the browsers that still received its notifications.
      onPasswordReset: async ({ user }, request) => {
        await dropPush(user.id); await notify('auth.password_changed', [user.id], {});
        // The link was mailed to the address: for an account whose address nobody had proven, this is the proof.
        if (!user.emailVerified) await provenByReset(user.id, request?.headers.get('x-lvm-client-ip') ?? null);
      },
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
        const headers = ctx.request.headers;
        if (!ctx.path.startsWith('/admin/') && !panelPaths.has(ctx.path)) throw new APIError('NOT_FOUND', { code: 'NOT_FOUND', message: 'Not found' });
        // Who is being signed in: an address-sized text, before it becomes a limiter key, a query or an audit row.
        // A text and nothing else: a list or an object would be turned into one further down, at any length.
        for (const k of ['email', 'username', 'phoneNumber']) if (body[k] !== undefined && body[k] !== null && (typeof body[k] !== 'string' || (body[k] as string).length > 254)) throw invalid();
        const query = (ctx.query ?? {}) as Record<string, unknown>;
        for (const k of redirectFields) for (const v of [body[k], query[k]]) if (v !== undefined && v !== null && v !== '' && !panelPath(v)) throw invalid();
        // A provider's ID token posted here would sign in past the redirect flow (state, PKCE, nonce) and, for single
        // sign-on, past its role mapping and audit. The panel never sends one (One Tap has its own route).
        if ((ctx.path === '/sign-in/social' || ctx.path === '/link-social') && body.idToken !== undefined) throw forbidden();
        // The phone-number plugin is here to verify the number of the signed-in person, nothing else: a code is sent
        // to a session only, and a correct code never signs anyone in (without updatePhoneNumber it would).
        if (ctx.path === '/phone-number/verify' && body.updatePhoneNumber !== true) throw forbidden();
        if (lastingPaths.has(ctx.path)) {
          const s = await getAuth().api.getSession({ headers }).catch(() => null);
          if (!s && ctx.path === '/phone-number/send-otp') throw new APIError('UNAUTHORIZED', { code: 'UNAUTHENTICATED', message: 'Sign in required' });
          if ((s?.session as { impersonatedBy?: string | null } | undefined)?.impersonatedBy) throw new APIError('FORBIDDEN', { code: 'NOT_WHILE_IMPERSONATING', message: 'Not while acting as another user' });
          // Each code is a paid message to a number the caller names: a few a day per account and per number, whatever
          // address the requests come from (the library's own limit counts per client address only).
          if (s && ctx.path === '/phone-number/send-otp' && typeof body.phoneNumber === 'string' && phonePattern.test(body.phoneNumber)) {
            await limit(`otp:phone:user:${s.user.id}`, 5, 86_400);
            await limit(`otp:phone:to:${body.phoneNumber}`, 5, 86_400);
          }
        }
        // Two-factor codes by SMS or e-mail: per account, signed in (setting it up) or between the two sign-in steps
        // (the account is the one the pending-step cookie names).
        if (ctx.path === '/two-factor/send-otp') {
          let uid = (await getAuth().api.getSession({ headers }).catch(() => null))?.user.id as string | undefined;
          if (!uid) {
            const pending = await ctx.getSignedCookie(ctx.context.createAuthCookie('two_factor').name, ctx.context.secret).catch(() => null);
            if (pending) uid = (await ctx.context.internalAdapter.findVerificationValue(pending).catch(() => null))?.value;
          }
          if (uid) await limit(`otp:2fa:${uid}`, 8, 3600);
        }
        if (ctx.path.startsWith('/admin/')) await checkAdminEndpoint(ctx.path, headers, body);
        await checkMethods(ctx.path, headers, body);
        await refuseForDirectory(ctx.path, headers, body);
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        // A role may only be used from its addresses: said at sign-in, not after.
        if ((ctx.path === '/sign-in/email' || ctx.path === '/sign-in/email-otp' || ctx.path === '/email-otp/send-verification-otp') && email) {
          const { rows: [u] } = await pool.query('SELECT role FROM users WHERE email = $1', [email]);
          await ensureRoles();
          if (u && !ipAllowed(limitsOf(u.role).allowedIps, headers.get('x-lvm-client-ip') ?? '')) throw new APIError('FORBIDDEN', { code: 'IP_NOT_ALLOWED', message: 'Not allowed from this address' });
        }
        // Captcha, where the admin turned it on (Settings → Bot protection). The token comes in a header.
        const form = captchaPaths[ctx.path];
        if (form) {
          const c = await activeCaptcha();
          if (c && c.use[form]) {
            const token = headers.get('x-captcha-response');
            if (!token) throw new APIError('BAD_REQUEST', { code: 'CAPTCHA_REQUIRED', message: 'Captcha required' });
            const verdict = await verifyCaptcha(c.provider, c.secret(), token, headers.get('x-lvm-client-ip'), c.minScore);
            if (!verdict.ok) throw new APIError('FORBIDDEN', { code: 'CAPTCHA_FAILED', message: 'Captcha failed' });
          }
        }
        if (ctx.path === '/sign-up/email') {
          const { rows: [s] } = await pool.query("SELECT value FROM settings WHERE key = 'registration_open'");
          if (s?.value !== true) throw new APIError('FORBIDDEN', { code: 'REGISTRATION_CLOSED', message: 'Registration is closed' });
        }
        if (ctx.path === '/sign-in/email' && email) await limit(`login:email:${email}`, 10, 900);
        // Reset mail: a few an hour per mailbox, from however many addresses (counted whether or not the account exists).
        if (ctx.path === '/request-password-reset' && email) await limit(`reset:email:${email}`, 5, 3600);
        // E-mail code sign-in: only when the admin turned it on, only for sign-in, never instead of two-factor.
        if (ctx.path.startsWith('/email-otp/') || ctx.path === '/sign-in/email-otp') {
          if (!(await getSettings('security')).emailCodeSignIn || !(await mailUse('twoFactor'))) throw new APIError('FORBIDDEN', { code: 'EMAIL_CODE_SIGN_IN_DISABLED', message: 'Sign-in with an e-mail code is off' });
          if (ctx.path !== '/sign-in/email-otp' && (ctx.path !== '/email-otp/send-verification-otp' || body.type !== 'sign-in')) throw new APIError('FORBIDDEN', { code: 'EMAIL_CODE_SIGN_IN_DISABLED', message: 'Only sign-in codes' });
          if (email) await limit(`login:email:${email}`, 10, 900);
          const { rows: [u] } = await pool.query('SELECT two_factor_enabled, auth_source FROM users WHERE lower(email) = $1', [email]);
          // Directory and single sign-on accounts sign in where their password lives (the rule that holds is the one
          // where sessions are made, below; this is the answer the form can show).
          if (u?.auth_source === 'ldap' || u?.auth_source === 'oidc') throw new APIError('FORBIDDEN', { code: 'PASSWORD_MANAGED_BY_DIRECTORY', message: 'Sign in with your directory account' });
          if (ctx.path === '/sign-in/email-otp' && u?.two_factor_enabled) throw new APIError('FORBIDDEN', { code: 'TWO_FACTOR_USE_PASSWORD', message: 'Accounts with two-factor sign in with their password' });
        }
        // Directory accounts sign in against the directory (and are created or brought up to date there). Last: the
        // address rule, the captcha and the per-address limit above come before any password reaches the directory.
        if (ctx.path === '/sign-in/email') await directorySignIn(ctx, body);
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
          // An account staff make in Admin → Users cannot have been registered by a stranger first: there is no earlier
          // holder whose things the first proof would have to remove, so its address counts as proven from the start
          // (as the setup administrator's does, setup.ts). Not the accounts a reseller or a billing system opens:
          // those are made without a request and never come through here.
          if (ctx.path === '/admin/create-user' && target) await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [target]).catch(() => undefined);
          const live: Record<string, LiveKind> = { '/admin/ban-user': 'ban', '/admin/unban-user': 'unban', '/admin/set-user-password': 'password', '/admin/remove-user': 'removed',
            '/admin/revoke-user-session': 'sessions', '/admin/revoke-user-sessions': 'sessions', '/admin/update-user': 'account' };
          if (target && live[ctx.path]) await publishLive(target, live[ctx.path]);
          // Sessions ended by staff: the browsers that were signed in stop receiving the account's notifications too.
          if (target && ['/admin/ban-user', '/admin/revoke-user-sessions', '/admin/set-user-password'].includes(ctx.path)) await dropPush(target);
          // A banned account handles no tickets: the ones it held go back to the team.
          if (target && ctx.path === '/admin/ban-user') await releaseTickets([target]);
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
            // The host terminal needs two-factor: one that is open in another of this person's sessions ends with it.
            if (!enabled) await closeConsoles(uid);
            await notify('auth.two_factor_changed', [uid], { enabled });
            await publishLive(uid, 'account');
          }
          return;
        }
        if (ctx.path === '/change-password' && !failed) {
          const uid = (ctx.context.session as { user?: { id: string } } | null)?.user?.id;
          if (uid) {
            // "Sign out other devices": the browsers signed out stop receiving the account's notifications as well.
            if ((ctx.body as { revokeOtherSessions?: unknown } | undefined)?.revokeOtherSessions === true) await dropPush(uid);
            await notify('auth.password_changed', [uid], {}); await publishLive(uid, 'password');
          }
          return;
        }
        // A passkey signs in later without the password: adding or removing one is recorded, and adding one announced.
        if ((ctx.path === '/passkey/verify-registration' || ctx.path === '/passkey/delete-passkey') && !failed) {
          const uid = (ctx.context.session as { user?: { id: string } } | null)?.user?.id;
          if (!uid) return;
          const added = ctx.path === '/passkey/verify-registration';
          await auditAuth(uid, added ? 'auth.passkey_added' : 'auth.passkey_removed', 'success', ip);
          if (added) await notify('auth.account_linked', [uid], { provider: 'Passkey' });
          return;
        }
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
      // The password and linked providers the library removes when the address is first proven (addressProven).
      }, delete: { before: async (_account, ctx) => { countRevoked(ctx, 'accounts'); } } },
      // An account made by a social provider is marked as such (two-factor is then the provider's, see auth.ts).
      user: { create: { before: async (user, ctx) => {
        const id = String((ctx?.params as { id?: string } | undefined)?.id ?? '');
        if ((ctx?.path.startsWith('/callback/') && (socialIds as string[]).includes(id)) || ctx?.path === '/one-tap/callback') return { data: { ...user, authSource: 'social' } };
      } },
      // The owner's first proof of the address (see provesMailbox): the library has just removed the password, the
      // linked providers and the sessions, and marks the address verified with this update.
      update: {
        before: async (data, ctx) => { if (ctx && provesMailbox(ctx.path) && (data as { emailVerified?: boolean }).emailVerified === true) proving.add(ctx); },
        after: async (user, ctx) => { if (ctx && proving.delete(ctx)) await addressProven(user.id, ctx.path, ctx.request?.headers.get('x-lvm-client-ip') ?? null, revoked.get(ctx)); },
      } },
      session: {
        create: {
          // A disabled or banned account gets no new session (its old ones were revoked when it was disabled).
          before: async (session, ctx) => {
            const user = await ctx?.context.internalAdapter.findUserById(session.userId) as { disabledAt?: Date | null; banned?: boolean; authSource?: string; twoFactorEnabled?: boolean } | null;
            if (user?.disabledAt || user?.banned) return false;
            const via = String((ctx?.params as { id?: string } | undefined)?.id ?? '');
            // A two-factor change swaps the caller's session for a new one, checked against the cached hash only.
            // For a directory account the new one keeps the age of the one it replaces, so the swap is not a way
            // round asking the directory again (auth.ts ends such a session SESSION_TTL_HOURS after it was made).
            const swapped = (ctx?.context.session as { session?: { createdAt?: Date | string } } | null | undefined)?.session?.createdAt;
            // Here every way in ends, whatever route or plugin it came through (the panel's own server-side calls
            // have no request). A directory account gets a session only when the directory accepted this very
            // sign-in, a single sign-on account only from its provider's callback: never from a cached password
            // hash, a code by SMS or mail, a passkey or a linked account. What may follow such a sign-in still
            // works: its second step and two-factor changes, and staff acting as the person.
            if (ctx?.request && ctx.path !== '/admin/impersonate-user') {
              if (user?.authSource === 'ldap' && !ctx.path.startsWith('/two-factor/') && !(ctx.path === '/sign-in/email' && directoryAccepted.has(ctx.request))) return false;
              if (user?.authSource === 'oidc' && !(ctx.path.startsWith('/callback/') && via === ssoProviderId)) return false;
              // A link or a code in a mailbox is one factor: never the way in for an account that has two.
              if (user?.twoFactorEnabled && (ctx.path === '/magic-link/verify' || ctx.path === '/sign-in/email-otp')) return false;
            }
            if (sso && ctx?.path.startsWith('/callback/') && via === ssoProviderId && !(await ssoSignedIn(sso, session.userId, ctx.request?.headers.get('x-lvm-client-ip') ?? ''))) return false;
            // Social, One Tap and e-mail link sign-ins: the role's address limits apply as for a password.
            if (ctx && linkPaths(ctx.path) && via !== ssoProviderId) {
              const { rows: [u] } = await pool.query('SELECT role FROM users WHERE id = $1', [session.userId]);
              await ensureRoles();
              if (u && !ipAllowed(limitsOf(u.role).allowedIps, ctx.request?.headers.get('x-lvm-client-ip') ?? '')) return false;
            }
            if (user?.authSource === 'ldap' && ctx?.request && ctx.path.startsWith('/two-factor/') && swapped) return { data: { createdAt: new Date(swapped) } };
          },
        },
        delete: {
          before: async (_session, ctx) => { countRevoked(ctx, 'sessions'); },
          // Every way a session ends (sign-out, revoke, password reset) also closes its browser consoles.
          after: async (session) => {
            await revokeConsoles({ authHash: sha256(session.token).toString('hex') });
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
        phoneNumberValidator: (n) => phonePattern.test(n),
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
          const link = u ? await onPanelAddress(url) : null;
          if (link) await sendSignInLink(email, u.locale, link); // unknown addresses get nothing, and the answer is the same
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
      { id: 'panel-labels', hooks: { after: [{ matcher: (ctx) => labelPaths.has(ctx.path ?? ''), handler: panelLabels }] } },
      // Last, so its hook sees what the others left (see recordSignIn).
      { id: 'sign-in-record', hooks: { after: [{ matcher: () => true, handler: recordSignIn }] } },
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
