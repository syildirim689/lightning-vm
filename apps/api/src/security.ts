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
  if (req.headers['x-lightning-csrf'] !== '1') return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host !== req.headers.host; } catch { return true; }
}
