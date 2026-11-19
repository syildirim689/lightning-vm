import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

// Environment read once and validated: a typo in .env fails at start with the variable's name,
// not later with a confusing runtime error.
const schema = z.object({
  NODE_ENV: z.string().default('production'),
  // Set by scripts/install.sh from the access mode: '1' when browsers reach the panel over HTTPS.
  PANEL_TLS: z.enum(['0', '1']).default('0'),
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  MASTER_KEY_FILE: z.string().default('/run/secrets/master_key'),
  SMTP_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  MAIL_FROM: z.string().optional().or(z.literal('').transform(() => undefined)),
  TURNSTILE_SITE_KEY: z.string().optional().or(z.literal('').transform(() => undefined)),
  TURNSTILE_SECRET_KEY: z.string().optional().or(z.literal('').transform(() => undefined)),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),
  // A personal API token of a directory (LDAP) or single sign-on account works only while the account's source
  // confirmed it within this many days (auth.ts, tokenSession; ldap.ts, tokenAsleep). 0 turns the rule off.
  DIRECTORY_TOKEN_DAYS: z.coerce.number().int().min(0).max(3650).default(30),
});

export const config = schema.parse(process.env);

// better-auth signs cookies with this. Derived from the master key so no new secret file is needed;
// an explicit BETTER_AUTH_SECRET wins.
export function authSecret() {
  if (config.BETTER_AUTH_SECRET) return config.BETTER_AUTH_SECRET;
  try {
    const key = readFileSync(config.MASTER_KEY_FILE, 'utf8').trim();
    return createHmac('sha256', key).update('lightning-vm/better-auth/v1').digest('base64url');
  } catch {
    if (config.NODE_ENV === 'test') return 'test-only-better-auth-secret-0123456789abcdef';
    throw new Error(`better-auth secret unavailable: set BETTER_AUTH_SECRET or provide ${config.MASTER_KEY_FILE}`);
  }
}

export const mailEnabled = () => !!config.SMTP_URL && !!config.MAIL_FROM;
export const captchaEnabled = () => !!config.TURNSTILE_SECRET_KEY && !!config.TURNSTILE_SITE_KEY;
