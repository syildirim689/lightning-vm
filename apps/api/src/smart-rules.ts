// Pure rules behind the smart features (no database, so unit tests need no Redis or Postgres):
import { createHash } from 'node:crypto';
// right-sizing from a server's CPU samples, a 0-100 health score, and this month's cost forecast.

export type CpuStats = { avg: number; p95: number; samples: number; days: number };
export type Advice = 'idle' | 'down' | 'up' | null;

// Recommends only with at least 3 days and 24 samples; the target is a p95 near 60% of the vCPUs.
export function sizing(vcpu: number, s: CpuStats | null): { advice: Advice; suggestedVcpu: number } {
  if (!s || s.days < 3 || s.samples < 24) return { advice: null, suggestedVcpu: vcpu };
  const target = Math.ceil((vcpu * s.p95) / 60);
  if (s.avg < 2 && s.p95 < 5) return { advice: 'idle', suggestedVcpu: 1 };
  if (vcpu > 1 && s.avg < 10 && s.p95 < 30) return { advice: 'down', suggestedVcpu: Math.max(1, Math.min(vcpu - 1, target)) };
  if (s.p95 > 85) return { advice: 'up', suggestedVcpu: Math.max(vcpu + 1, Math.min(vcpu * 2, target)) };
  return { advice: null, suggestedVcpu: vcpu };
}

export type HealthFacts = { state: string; powerState: string; abuseOpen: number; failedOps24h: number; cpuP95: number | null; advice: Advice };
export type Factor = { code: string; impact: number };

export function health(f: HealthFacts): { score: number; grade: 'good' | 'fair' | 'poor'; factors: Factor[] } {
  const factors: Factor[] = [];
  if (f.state === 'error' || f.state === 'missing') factors.push({ code: 'STATE_ERROR', impact: -60 });
  if (f.state === 'ready' && f.powerState !== 'poweredOn') factors.push({ code: 'POWERED_OFF', impact: -5 });
  if (f.abuseOpen) factors.push({ code: 'ABUSE_OPEN', impact: -Math.min(30, 15 * f.abuseOpen) });
  if (f.failedOps24h) factors.push({ code: 'OPS_FAILED', impact: -Math.min(20, 10 * f.failedOps24h) });
  if (f.cpuP95 !== null && f.cpuP95 > 90) factors.push({ code: 'CPU_SATURATED', impact: -15 });
  else if (f.advice === 'up') factors.push({ code: 'CPU_HIGH', impact: -8 });
  if (f.advice === 'idle') factors.push({ code: 'IDLE', impact: -5 });
  const score = Math.max(0, 100 + factors.reduce((a, x) => a + x.impact, 0));
  return { score, grade: score >= 85 ? 'good' : score >= 60 ? 'fair' : 'poor', factors };
}

// Monthly prices prorated by the part of this (UTC) month each item exists: so far and by month end.
export function monthCost(items: { price: number; createdAt: Date }[], now: Date) {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const len = end - start;
  let monthly = 0, accrued = 0, forecast = 0;
  for (const i of items) {
    const from = Math.max(start, i.createdAt.getTime());
    monthly += i.price;
    accrued += (i.price * Math.max(0, now.getTime() - from)) / len;
    forecast += (i.price * Math.max(0, end - from)) / len;
  }
  const r = (x: number) => Math.round(x * 100) / 100;
  return { monthly: r(monthly), accrued: r(accrued), forecast: r(forecast), daysLeft: Math.ceil((end - now.getTime()) / 86_400_000) };
}

// A server's tags (up to 10, letters/digits/space . _ -, 1-24 characters, case-insensitively unique) and notes.
export function cleanLabels(body: Record<string, unknown>): { tags: string[]; notes: string } | { fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  const raw = Array.isArray(body?.tags) ? body.tags : [];
  const tags = [...new Map(raw.map((t) => String(t).trim().replace(/\s+/g, ' ')).filter(Boolean).map((t) => [t.toLocaleLowerCase('tr'), t])).values()];
  if (!Array.isArray(body?.tags) && body?.tags !== undefined) fields.tags = 'INVALID_VALUE';
  else if (tags.length > 10) fields.tags = 'TOO_MANY';
  else if (tags.some((t) => !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,23}$/u.test(t))) fields.tags = 'INVALID_TAG';
  const notes = typeof body?.notes === 'string' ? body.notes.trim() : '';
  if (body?.notes !== undefined && typeof body.notes !== 'string') fields.notes = 'INVALID_VALUE';
  else if (notes.length > 2000) fields.notes = 'TOO_LONG';
  return Object.keys(fields).length ? { fields } : { tags, notes };
}

// A power schedule from the panel: start or shut down, ISO weekdays 1-7, "HH:MM" and an IANA time zone.
export function cleanSchedule(body: Record<string, unknown>) {
  const fields: Record<string, string> = {};
  const action = String(body?.action ?? '');
  if (!['power_on', 'shutdown'].includes(action)) fields.action = 'INVALID_VALUE';
  const days = Array.isArray(body?.days) ? [...new Set(body.days.map(Number))].sort() : [];
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) fields.days = 'REQUIRED';
  const time = String(body?.time ?? '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) fields.time = 'INVALID_VALUE';
  const timezone = String(body?.timezone ?? '');
  try { if (!timezone || timezone.length > 64) throw 0; new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { fields.timezone = 'INVALID_VALUE'; }
  const enabled = body?.enabled !== false;
  return Object.keys(fields).length ? { fields } : { action, days, time, timezone, enabled };
}

// OpenSSH public keys (type, base64 blob, optional comment) and their SHA256 fingerprint as ssh-keygen shows it.
export const sshKeyPattern = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) ([A-Za-z0-9+/]+={0,2})( [^\r\n]{0,200})?$/;
export const fingerprint = (blob: string) => 'SHA256:' + createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '');

// github.com/<user>.keys: one key per line; valid ones are kept (at most 20), with their fingerprints.
export function parseKeyList(text: string) {
  return text.split(/\r?\n/).map((l) => l.trim()).map((l) => ({ line: l, m: sshKeyPattern.exec(l) })).filter((x) => x.m).slice(0, 20)
    .map((x) => ({ publicKey: x.line, fingerprint: fingerprint(x.m![3]) }));
}

// Alertmanager webhook (version 4) to panel notices: one per alert, the rule's "Türkçe / English" summary split
// into both languages, resolved ones marked. At most 20 per call (a storm becomes a summary line, not 200 mails).
type AmAlert = { status?: string; labels?: Record<string, string>; annotations?: Record<string, string>; startsAt?: string; fingerprint?: string };
export function alertNotices(body: unknown) {
  const alerts = Array.isArray((body as { alerts?: unknown })?.alerts) ? (body as { alerts: AmAlert[] }).alerts : [];
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  return alerts.slice(0, 20).map((a) => {
    const name = clip(String(a.labels?.alertname ?? 'Alert'), 80);
    const summary = String(a.annotations?.summary ?? a.annotations?.description ?? '');
    const [tr, en] = summary.includes(' / ') ? summary.split(' / ', 2) : [summary, summary];
    const resolved = a.status === 'resolved';
    const severity = ['critical', 'warning', 'info'].includes(String(a.labels?.severity)) ? String(a.labels!.severity) : 'warning';
    return { key: clip(String(a.fingerprint ?? name), 64), name, severity, resolved,
      titleTr: `${resolved ? 'Çözüldü' : severity === 'critical' ? 'Kritik alarm' : 'Alarm'}: ${name}`, titleEn: `${resolved ? 'Resolved' : severity === 'critical' ? 'Critical alert' : 'Alert'}: ${name}`,
      bodyTr: clip(tr.trim() || name, 500), bodyEn: clip((en ?? tr).trim() || name, 500) };
  });
}
