// Limits a role puts on its members, besides permissions: quotas, counts, rates, sign-in rules. Pure, so the
// rules are unit-tested; permissions.ts applies them to a user's roles.
import { BlockList, isIP } from 'node:net';

export type RoleLimits = {
  maxServers?: number; maxVcpu?: number; maxMemoryMb?: number; maxDiskGb?: number;   // quotas (a user's or project's own quota still wins)
  maxSnapshots?: number; maxFirewalls?: number; maxSshKeys?: number;                  // counts
  operationsPerHour?: number;                                                          // server operations started per hour
  sessionHours?: number;                                                               // a session ends this long after sign-in
  require2fa?: boolean;                                                                // members must use two-factor
  allowedLocations?: string[];                                                         // locations they may order in
  allowedIps?: string[];                                                               // addresses or CIDR blocks they may use the panel from
};
export const numericLimits = { maxServers: [0, 10_000], maxVcpu: [0, 100_000], maxMemoryMb: [0, 1 << 30], maxDiskGb: [0, 1 << 30], maxSnapshots: [0, 32],
  maxFirewalls: [0, 1000], maxSshKeys: [0, 1000], operationsPerHour: [1, 10_000], sessionHours: [1, 720] } as const;
type Numeric = keyof typeof numericLimits;

// A user with several roles gets the most generous of them: a value is limited only if every role limits it
// (numbers: the highest; lists: all entries together), while two-factor is required if any role requires it.
export function combineLimits(list: RoleLimits[]): RoleLimits {
  if (!list.length) return {};
  const out: RoleLimits = {};
  for (const k of Object.keys(numericLimits) as Numeric[]) {
    if (list.every((l) => typeof l[k] === 'number')) out[k] = Math.max(...list.map((l) => l[k] as number));
  }
  for (const k of ['allowedLocations', 'allowedIps'] as const) {
    if (list.every((l) => l[k]?.length)) out[k] = [...new Set(list.flatMap((l) => l[k]!))];
  }
  if (list.some((l) => l.require2fa)) out.require2fa = true;
  return out;
}

const cidr = (v: string): [string, number, 'ipv4' | 'ipv6'] | null => {
  const [ip, bits] = v.trim().split('/');
  const fam = isIP(ip);
  if (!fam) return null;
  const max = fam === 4 ? 32 : 128;
  const n = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) : -1;
  return n >= 0 && n <= max ? [ip, n, fam === 4 ? 'ipv4' : 'ipv6'] : null;
};
export const validCidr = (v: string) => !!cidr(v);

// IPv4-mapped IPv6 (::ffff:1.2.3.4, as Node often reports IPv4 clients) is checked as IPv4.
export function ipAllowed(list: string[] | undefined, ip: string) {
  if (!list?.length) return true;
  const b = new BlockList();
  for (const c of list.map(cidr)) if (c) b.addSubnet(c[0], c[1], c[2]);
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  const addr = v4 ?? ip;
  const fam = isIP(addr);
  return fam ? b.check(addr, fam === 4 ? 'ipv4' : 'ipv6') : false;
}

// The admin's form → stored limits. Empty means "no limit"; returns field errors instead of throwing.
export function readLimits(input: unknown, knownLocation: (id: string) => boolean): { limits: RoleLimits; fields: Record<string, string> } {
  const v = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const limits: RoleLimits = {}, fields: Record<string, string> = {};
  for (const [k, [min, max]] of Object.entries(numericLimits) as [Numeric, readonly [number, number]][]) {
    if (v[k] === undefined || v[k] === null || v[k] === '') continue;
    const n = Number(v[k]);
    if (!Number.isInteger(n) || n < min || n > max) fields[`limits.${k}`] = 'OUT_OF_RANGE'; else limits[k] = n;
  }
  if (v.require2fa === true) limits.require2fa = true;
  const list = (x: unknown) => (Array.isArray(x) ? [...new Set(x.map((s) => String(s).trim()).filter(Boolean))] : []);
  const locations = list(v.allowedLocations);
  if (locations.some((id) => !knownLocation(id))) fields['limits.allowedLocations'] = 'INVALID_VALUE'; else if (locations.length) limits.allowedLocations = locations;
  const ips = list(v.allowedIps);
  if (ips.length > 100 || ips.some((x) => !validCidr(x))) fields['limits.allowedIps'] = 'INVALID_ADDRESS'; else if (ips.length) limits.allowedIps = ips;
  return { limits, fields };
}
