import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pool, redis } from './db';

// Every result code the wizard can show; the web check script requires a translation for each.
export const checkCodes = ['OK', 'UNREACHABLE', 'MIGRATIONS_PENDING', 'NO_HEARTBEAT', 'HTTP_ERROR', 'TIMEOUT', 'DNS_FAILED', 'CONNECTION_REFUSED', 'TLS_ERROR', 'WRONG_TARGET', 'LOOPBACK_NOT_VERIFIABLE'] as const;
export type CheckCode = (typeof checkCodes)[number];
export type Check = { id: string; ok: boolean; code: CheckCode; detail?: Record<string, string | number> };

const failed = (id: string, code: CheckCode): Check => ({ id, ok: false, code });

// Checks the API can verify itself from inside its container. Host checks (OS, disk, ports) are done by install.sh.
export async function serviceChecks(): Promise<Check[]> {
  const postgres = pool.query("SELECT current_setting('server_version') AS v")
    .then((r): Check => ({ id: 'postgres', ok: true, code: 'OK', detail: { version: r.rows[0].v } }), () => failed('postgres', 'UNREACHABLE'));
  const redisCheck = redis.info('server').then((info): Check => {
    const version = /redis_version:(\S+)/.exec(info)?.[1] ?? 'unknown';
    return { id: 'redis', ok: true, code: 'OK', detail: { version } };
  }, () => failed('redis', 'UNREACHABLE'));
  return Promise.all([postgres, redisCheck]);
}

export async function systemChecks(): Promise<Check[]> {
  const services = await serviceChecks();
  const migrations = pool.query('SELECT count(*)::int AS n FROM schema_migrations').then((r): Check => {
    const files = readdirSync(join(__dirname, '..', 'migrations')).filter((f) => f.endsWith('.sql')).length;
    const pending = files - r.rows[0].n;
    return { id: 'migrations', ok: pending === 0, code: pending === 0 ? 'OK' : 'MIGRATIONS_PENDING', detail: { applied: r.rows[0].n, pending } };
  }, () => failed('migrations', 'UNREACHABLE'));
  const worker = pool.query("SELECT bool_or(last_seen > now() - interval '90 seconds') AS fresh FROM worker_heartbeats").then(
    (r): Check => r.rows[0].fresh ? { id: 'worker', ok: true, code: 'OK' } : failed('worker', 'NO_HEARTBEAT'),
    () => failed('worker', 'UNREACHABLE'));
  return [...services, ...await Promise.all([migrations, worker])];
}

// Each optional observability component is probed on the internal network.
export async function monitoringChecks(): Promise<Check[]> {
  const targets = { prometheus: 'http://prometheus:9090/-/ready', grafana: 'http://grafana:3000/api/health', loki: 'http://loki:3100/ready' };
  return Promise.all(Object.entries(targets).map(([id, url]) => fetch(url, { signal: AbortSignal.timeout(3000) })
    .then((r): Check => r.ok ? { id, ok: true, code: 'OK' } : failed(id, 'HTTP_ERROR'), (e) => failed(id, networkErrorCode(e)))));
}

const tlsCodes = /CERT|SELF_SIGNED|TLS|SSL|UNABLE_TO_VERIFY/;
export function networkErrorCode(err: unknown): CheckCode {
  const e = err as { name?: string; cause?: { code?: string; name?: string } };
  const code = e.cause?.code ?? '';
  if (e.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'TIMEOUT';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS_FAILED';
  if (code === 'ECONNREFUSED') return 'CONNECTION_REFUSED';
  if (tlsCodes.test(code)) return 'TLS_ERROR';
  return 'UNREACHABLE';
}

// Normalizes a user-entered panel address to an origin; returns null when it is not a plain http(s) origin.
export function parsePublicUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 255) return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

export const isLoopback = (origin: string) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(new URL(origin).hostname);
