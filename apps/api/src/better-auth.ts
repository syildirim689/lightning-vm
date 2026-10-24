// Session management: better-auth owns sign-up, sign-in, sign-out, sessions, password reset and passkeys.
// Users stay in the existing "users" table; better-auth's tables are auth_* (migration 007).
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { admin, captcha } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { authSecret, captchaEnabled, config, mailEnabled } from './config';
import { pool, redis } from './db';
import { logEvent } from './log';
import { sendPasswordReset } from './mail';
import { hashPassword, sha256, verifyPassword } from './security';

const auditAuth = (actorId: string | null, action: string, outcome: 'success' | 'failure' | 'denied', ip: string | null, metadata: object = {}) =>
  pool.query('INSERT INTO audit_events (actor_id, action, outcome, ip, metadata) VALUES ($1, $2, $3, $4, $5)', [actorId, action, outcome, ip, metadata])
    .catch(() => logEvent('error', 'audit_failed', { action }));

// Same fixed-window counter as security.ts rateLimit, in better-auth's error type. Fails closed.
async function limit(key: string, max: number, windowSeconds: number) {
  const res = await redis.multi().incr(`rl:${key}`).expire(`rl:${key}`, windowSeconds, 'NX').exec().catch(() => null);
  if (!res) throw new APIError('SERVICE_UNAVAILABLE', { code: 'DEPENDENCY_UNAVAILABLE', message: 'Rate limiter unavailable' });
  if (Number(res[0]?.[1]) > max) throw new APIError('TOO_MANY_REQUESTS', { code: 'RATE_LIMITED', message: 'Too many attempts' });
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
        disabledAt: { type: 'date', required: false, input: false, fieldName: 'disabled_at' },
      },
    },
    session: {
      modelName: 'auth_sessions',
      expiresIn: config.SESSION_TTL_HOURS * 3600,
      updateAge: 3600,
      fields: { userId: 'user_id', expiresAt: 'expires_at', ipAddress: 'ip_address', userAgent: 'user_agent', createdAt: 'created_at', updatedAt: 'updated_at' },
    },
    account: {
      modelName: 'auth_accounts',
      fields: { userId: 'user_id', accountId: 'account_id', providerId: 'provider_id', accessToken: 'access_token', refreshToken: 'refresh_token', idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at', refreshTokenExpiresAt: 'refresh_token_expires_at', createdAt: 'created_at', updatedAt: 'updated_at' },
    },
    verification: { modelName: 'auth_verifications', fields: { expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at' } },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 256,
      // The existing scrypt format (security.ts) stays, so accounts from before the move keep working.
      password: { hash: hashPassword, verify: ({ hash, password }) => verifyPassword(password, hash) },
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        if (!mailEnabled()) throw new APIError('NOT_IMPLEMENTED', { code: 'MAIL_NOT_CONFIGURED', message: 'Mail is not configured' });
        await sendPasswordReset(user.email, (user as { locale?: string }).locale, url);
      },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: { '/sign-in/email': { window: 900, max: 30 }, '/sign-up/email': { window: 3600, max: 5 }, '/request-password-reset': { window: 3600, max: 5 } },
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
        if (ctx.path === '/sign-up/email') {
          const { rows: [s] } = await pool.query("SELECT value FROM settings WHERE key = 'registration_open'");
          if (s?.value !== true) throw new APIError('FORBIDDEN', { code: 'REGISTRATION_CLOSED', message: 'Registration is closed' });
        }
        if (ctx.path === '/sign-in/email') {
          const email = String((ctx.body as { email?: unknown })?.email ?? '').toLowerCase();
          if (email) await limit(`login:email:${email}`, 10, 900);
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (!ctx.request || (ctx.path !== '/sign-in/email' && ctx.path !== '/sign-up/email' && ctx.path !== '/sign-in/passkey')) return;
        const ip = ctx.request?.headers.get('x-lvm-client-ip') ?? null;
        const created = ctx.context.newSession;
        const action = ctx.path === '/sign-up/email' ? 'auth.register' : 'auth.login';
        await auditAuth(created?.user.id ?? null, action, created ? 'success' : 'failure', ip,
          created ? { method: ctx.path === '/sign-in/passkey' ? 'passkey' : 'password' } : { email: String((ctx.body as { email?: unknown })?.email ?? '').toLowerCase() });
      }),
    },
    databaseHooks: {
      session: {
        create: {
          // A disabled account gets no new session (its old ones were revoked when it was disabled).
          before: async (session, ctx) => {
            const user = await ctx?.context.internalAdapter.findUserById(session.userId) as { disabledAt?: Date | null; banned?: boolean } | null;
            if (user?.disabledAt || user?.banned) return false;
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
      admin({ schema: { user: { fields: { banReason: 'ban_reason', banExpires: 'ban_expires' } }, session: { fields: { impersonatedBy: 'impersonated_by' } } } }),
      passkey({
        rpName: 'Lightning VM',
        schema: { passkey: { modelName: 'auth_passkeys', fields: { publicKey: 'public_key', userId: 'user_id', credentialID: 'credential_id', deviceType: 'device_type', backedUp: 'backed_up', createdAt: 'created_at' } } },
      }),
      ...(captchaEnabled() ? [captcha({ provider: 'cloudflare-turnstile', secretKey: config.TURNSTILE_SECRET_KEY!, endpoints: ['/sign-up/email', '/sign-in/email', '/request-password-reset'] })] : []),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
let instance: Auth | undefined;
// Built on first use: better-auth validates the schema once and caches it, so this must happen after migrations.
export const getAuth = () => (instance ??= createAuth());
