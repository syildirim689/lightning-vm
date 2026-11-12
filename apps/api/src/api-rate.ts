// Requests made with API tokens: the rate limit per token and minute (with its headers) and the request log.
// Kept apart from api-access.ts so that auth.ts can use it without importing the guards.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool, redis } from './db';
import { apiError } from './errors';
import { logEvent } from './log';
import { getSettings } from './settings-store';

type RateState = { limit: number; remaining: number; reset: number };
type TokenRequest = FastifyRequest & { sessionId?: string; user?: { id: string }; apiRate?: RateState; apiToken?: { id: string; name: string } };

// Counted per token and minute in Redis. Over the limit: 429 with Retry-After. Redis down: not counted (fail open),
// since the session check itself already needs the database and a limit is not a security boundary here.
export async function countRequest(req: FastifyRequest, tokenId: string, limit: number) {
  if (!limit) return;
  const minute = Math.floor(Date.now() / 60_000);
  const key = `rl:api:${tokenId}:${minute}`;
  const n = await redis.multi().incr(key).expire(key, 90).exec().then((r) => Number(r?.[0]?.[1] ?? 0)).catch(() => 0);
  const reset = (minute + 1) * 60;
  (req as TokenRequest).apiRate = { limit, remaining: Math.max(0, limit - n), reset };
  if (n > limit) throw apiError(429, 'RATE_LIMITED', 'Too many requests with this API token', undefined, { retryAfter: reset - Math.floor(Date.now() / 1000) });
}

// Rate headers on every token answer; the request log after it.
export function registerApiHooks(fastify: FastifyInstance) {
  fastify.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply) => {
    const r = (req as TokenRequest).apiRate;
    if (!r) return;
    reply.header('X-RateLimit-Limit', r.limit).header('X-RateLimit-Remaining', r.remaining).header('X-RateLimit-Reset', r.reset);
    if (reply.statusCode === 429) reply.header('Retry-After', Math.max(1, r.reset - Math.floor(Date.now() / 1000)));
  });
  fastify.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    const t = (req as TokenRequest).apiToken;
    if (!t) return;
    const s = await getSettings('api').catch(() => null);
    if (!s?.log) return;
    await pool.query(`INSERT INTO api_request_log (token_id, token_name, user_id, method, route, path, status, duration_ms, ip) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::inet)`,
      [t.id, t.name, (req as TokenRequest).user?.id ?? null, req.method, req.routeOptions?.url ?? '?', req.url.split('?')[0].slice(0, 300), reply.statusCode,
        Math.round(reply.elapsedTime), req.ip]).catch(() => logEvent('warn', 'api_log_failed'));
  });
}

// Every hour: the log keeps the days the administrator chose.
export function startApiLogJanitor() {
  const run = async () => {
    const s = await getSettings('api').catch(() => null);
    await pool.query("DELETE FROM api_request_log WHERE created_at < now() - make_interval(days => $1)", [s?.logDays ?? 14]).catch(() => undefined);
  };
  setTimeout(run, 120_000).unref();
  return setInterval(run, 3_600_000).unref();
}

