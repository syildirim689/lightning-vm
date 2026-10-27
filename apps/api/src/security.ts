import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyRequest } from 'fastify';
import { redis } from './db';
import { apiError } from './errors';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
// OWASP scrypt baseline: N=2^17, r=8, p=1. Parameters are stored per hash so they can be raised later.
const N = 2 ** 17, r = 8, p = 1, keyLen = 32;
const maxmem = 256 * 1024 * 1024;

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password.normalize('NFKC'), salt, keyLen, { N, r, p, maxmem });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [alg, n, rr, pp, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, { N: +n, r: +rr, p: +pp, maxmem });
  return timingSafeEqual(actual, expected);
}

// Verifying against this keeps unknown-email logins as slow as wrong-password logins.
export const dummyHash = hashPassword(randomBytes(16).toString('hex'));

export const newToken = () => randomBytes(32).toString('base64url');
export const sha256 = (value: string) => createHash('sha256').update(value).digest();

// Fixed-window counter in Redis. Fails closed: no Redis, no attempt.
export async function rateLimit(key: string, max: number, windowSeconds: number) {
  const count = await redis.multi().incr(`rl:${key}`).expire(`rl:${key}`, windowSeconds, 'NX').exec()
    .then((res) => Number(res?.[0]?.[1]), () => { throw apiError(503, 'DEPENDENCY_UNAVAILABLE', 'Rate limiter unavailable'); });
  if (count > max) throw apiError(429, 'RATE_LIMITED', 'Too many attempts');
}

// Rejects cross-site state changes: a custom header forces a CORS preflight we never allow,
// and a present Origin must match the Host the browser used.
export function csrfRejected(req: FastifyRequest) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return false;
  // Alertmanager's webhook: no cookies, internal network only (alerts.ts); it cannot send the CSRF header.
  if (req.url === '/internal/alerts' && !req.headers.cookie) return false;
  // Payment providers post results here (billing.ts verifies each with the provider; no session is used).
  if (req.url.startsWith('/billing/callback/')) return false;
  // An API token (developer.ts) is sent by a program, not a browser: a page cannot add this header across sites.
  if (!req.headers.cookie && /^Bearer lvm_/.test(req.headers.authorization ?? '')) return false;
  if (req.headers['x-lightning-csrf'] !== '1') return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host !== req.headers.host; } catch { return true; }
}

// The same signed-in browser sending the same state change again while the first is running (a double click, a
// second tab, an impatient retry) gets 409 instead of a second server, firewall, schedule or payment. Once the first
// answer is sent the same request may run again (a deliberate retry). Endpoints with an
// Idempotency-Key already return the first result, and sign-in, internal and read-marking calls are left alone.
const dedupeFree = /^\/(auth\/|internal\/|notifications\/read)/;
export function duplicateKey(req: FastifyRequest) {
  if (req.method !== 'POST' || !req.headers.cookie || req.headers['idempotency-key'] || dedupeFree.test(req.url)) return null;
  return `dup:${createHash('sha256').update(`${req.headers.cookie}\n${req.url}\n${JSON.stringify(req.body ?? null)}`).digest('base64url')}`;
}
// True when this request may run (Redis down: it runs, as before this guard).
export const claimRequest = (key: string) => redis.set(key, '1', 'EX', 120, 'NX').then((r) => r === 'OK', () => true);
export const releaseRequest = (key: string) => redis.del(key).catch(() => undefined);
