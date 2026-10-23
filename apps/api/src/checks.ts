import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promises as dns } from 'node:dns';
import { connect } from 'node:tls';
import { pool, redis } from './db';

// Every result code the wizard can show; the web check script requires a translation for each.
export const checkCodes = ['OK', 'UNREACHABLE', 'MIGRATIONS_PENDING', 'NO_HEARTBEAT', 'HTTP_ERROR', 'TIMEOUT', 'DNS_FAILED', 'CONNECTION_REFUSED', 'TLS_ERROR', 'WRONG_TARGET', 'LOOPBACK_NOT_VERIFIABLE', 'NO_ADDRESS_RECORDS', 'REDIRECT_HTTPS', 'CERT_STAGING'] as const;
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

// Plain host name: lowercase labels, at least one dot, no scheme, port or path.
export function parseDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase();
  return /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) && host.length <= 253 ? host : null;
}

// Reads the certificate the name serves on 443, verified against the system CAs.
function tlsCheck(host: string): Promise<Check> {
  return new Promise((resolve) => {
    // rejectUnauthorized: false only so the certificate can be inspected; trust is decided by socket.authorized.
    const socket = connect({ host, port: 443, servername: host, timeout: 5000, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate();
      const issuer = [cert.issuer?.O, cert.issuer?.CN].filter(Boolean).join(' / ');
      const detail = { issuer, validTo: cert.valid_to ?? '' };
      socket.end();
      if (socket.authorized) resolve({ id: 'https', ok: true, code: 'OK', detail });
      else resolve({ id: 'https', ok: false, code: /STAGING/i.test(issuer) ? 'CERT_STAGING' : 'TLS_ERROR', detail: { ...detail, reason: String(socket.authorizationError ?? '') } });
    });
    socket.on('timeout', () => { socket.destroy(); resolve({ id: 'https', ok: false, code: 'TIMEOUT' }); });
    socket.on('error', (err) => resolve({ id: 'https', ok: false, code: networkErrorCode({ cause: err }) }));
  });
}

// DNS, HTTP and HTTPS are reported separately: one passing says nothing about the others.
export async function domainChecks(host: string, probe: (origin: string) => Promise<Check>): Promise<Check[]> {
  const [a, aaaa] = await Promise.allSettled([dns.resolve4(host), dns.resolve6(host)]);
  const v4 = a.status === 'fulfilled' ? a.value : [];
  const v6 = aaaa.status === 'fulfilled' ? aaaa.value : [];
  const notFound = [a, aaaa].every((r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'ENOTFOUND');
  const dnsResult: Check = v4.length || v6.length
    ? { id: 'dns', ok: v4.length > 0, code: v4.length ? 'OK' : 'NO_ADDRESS_RECORDS', detail: { a: v4.join(', '), aaaa: v6.join(', ') } }
    : { id: 'dns', ok: false, code: notFound ? 'DNS_FAILED' : 'NO_ADDRESS_RECORDS' };
  if (!dnsResult.ok) return [dnsResult];

  const http = await fetch(`http://${host}/`, { redirect: 'manual', signal: AbortSignal.timeout(5000) }).then((r): Check => {
    const location = r.headers.get('location') ?? '';
    if (r.status >= 300 && r.status < 400 && location.startsWith(`https://${host}`)) return { id: 'http', ok: true, code: 'REDIRECT_HTTPS' };
    return r.ok ? { id: 'http', ok: true, code: 'OK' } : { id: 'http', ok: false, code: 'HTTP_ERROR', detail: { status: r.status } };
  }, (err): Check => ({ id: 'http', ok: false, code: networkErrorCode(err) }));

  const tls = await tlsCheck(host);
  // A trusted certificate must also belong to this installation, not to some other server on that name.
  const https = tls.ok ? { ...(await probe(`https://${host}`)), id: 'https', detail: tls.detail } : tls;
  return [dnsResult, http, https];
}
