// Checks for this server's own settings (Admin → System → Server), the same as the host agent's in
// scripts/install.sh: the panel answers early; the agent decides.
import { validTimeZone } from './time-zone';

const label = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
export const validHostname = (v: string) => v.length <= 253 && new RegExp(`^${label}(\\.${label})*$`).test(v);
const ip = (v: string) => /^(\d{1,3}\.){3}\d{1,3}$/.test(v) ? v.split('.').every((n) => Number(n) <= 255) : /^[0-9a-fA-F:]{2,39}$/.test(v) && v.includes(':');

// A list of up to 4 time servers (names or addresses) or DNS servers (addresses), as "a,b"; "default" resets it.
export function readList(v: unknown, kind: 'ntp' | 'dns'): string | null {
  if (typeof v !== 'string') return null;
  if (v.trim() === 'default') return 'default';
  const items = v.split(/[\s,]+/).filter(Boolean);
  if (!items.length || items.length > 4 || items.some((x) => !(ip(x) || (kind === 'ntp' && validHostname(x.toLowerCase()))))) return null;
  return items.map((x) => (ip(x) ? x : x.toLowerCase())).join(',');
}

export type HostChange = { hostname?: string; timezone?: string; ntp?: string; dns?: string };
// Only the fields that were sent; field codes for the form. An empty change is a "refresh the details" request.
export function readHostChange(body: Record<string, unknown>): { change: HostChange; fields: Record<string, string> } {
  const change: HostChange = {}, fields: Record<string, string> = {};
  if (body.hostname !== undefined && body.hostname !== '') {
    const h = String(body.hostname).trim().toLowerCase();
    if (validHostname(h)) change.hostname = h; else fields.hostname = 'INVALID_HOSTNAME';
  }
  if (body.timezone !== undefined && body.timezone !== '') { const z = validTimeZone(body.timezone); if (z) change.timezone = z; else fields.timezone = 'INVALID_VALUE'; }
  for (const k of ['ntp', 'dns'] as const) if (body[k] !== undefined && body[k] !== '') { const l = readList(body[k], k); if (l) change[k] = l; else fields[k] = 'INVALID_VALUE'; }
  return { change, fields };
}
