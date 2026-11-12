// What a network scan covers, from what an admin types: single addresses, CIDR blocks, ranges and
// wildcards, separated by new lines, commas or spaces. The same file is in apps/web/lib (live count
// under the field); the API checks again with this copy.
//   10.0.0.5            one address
//   10.0.0.0/24         a block (network and broadcast addresses left out); /20 at most
//   10.0.0.10-10.0.0.60 or 10.0.0.10-60   a range
//   10.0.1.*            the whole /24
//   fd00::10            one IPv6 address (IPv6 blocks are too large to scan)
export const scanLimit = 4096;

export type TargetItem = { text: string; count: number; error?: 'INVALID_TARGET' | 'RANGE_TOO_LARGE' | 'IPV6_RANGE' };
export type Targets = { addresses: string[]; items: TargetItem[]; tooMany: boolean };

const v4 = (s: string): number | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p, i) => p > 255 || (m[i + 1].length > 1 && m[i + 1].startsWith('0')))) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
};
export const v4text = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const isV6 = (s: string) => {
  if (!s.includes(':') || !/^[0-9a-fA-F:.]+$/.test(s)) return false;
  try { return new URL(`http://[${s}]/`).hostname.length > 2; } catch { return false; }
};

function expand(text: string): { from: number; to: number } | { v6: string } | TargetItem['error'] {
  const wild = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\*$/.exec(text);
  if (wild) return expand(`${wild[1]}.0/24`);
  if (text.includes('/')) {
    const [ip, bits] = text.split('/');
    if (isV6(ip)) return 'IPV6_RANGE';
    const base = v4(ip);
    const n = /^\d{1,2}$/.test(bits) ? Number(bits) : NaN;
    if (base === null || !(n >= 0 && n <= 32)) return 'INVALID_TARGET';
    if (n < 20) return 'RANGE_TOO_LARGE';
    const size = 2 ** (32 - n);
    const net = base - (base % size);
    // Network and broadcast addresses are no hosts, except in /31 and /32.
    return n <= 30 ? { from: net + 1, to: net + size - 2 } : { from: net, to: net + size - 1 };
  }
  if (text.includes('-')) {
    const [a, b] = text.split('-');
    const from = v4(a);
    if (from === null) return 'INVALID_TARGET';
    const to = /^\d{1,3}$/.test(b) ? (Number(b) <= 255 ? (from - (from & 255)) + Number(b) : null) : v4(b);
    if (to === null || to < from) return 'INVALID_TARGET';
    if (to - from + 1 > scanLimit) return 'RANGE_TOO_LARGE';
    return { from, to };
  }
  if (isV6(text)) return { v6: text.toLowerCase() };
  const one = v4(text);
  return one === null ? 'INVALID_TARGET' : { from: one, to: one };
}

export function parseTargets(input: string): Targets {
  const seen = new Set<string>();
  const addresses: string[] = [];
  const items: TargetItem[] = [];
  let tooMany = false;
  for (const text of input.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)) {
    const r = expand(text);
    if (typeof r === 'string' || r === undefined) { items.push({ text, count: 0, error: r ?? 'INVALID_TARGET' }); continue; }
    let count = 0;
    const add = (a: string) => {
      count++;
      if (seen.has(a)) return;
      if (addresses.length >= scanLimit) { tooMany = true; return; }
      seen.add(a); addresses.push(a);
    };
    if ('v6' in r) add(r.v6);
    else for (let n = r.from; n <= r.to && !tooMany; n++) add(v4text(n));
    items.push({ text, count });
  }
  return { addresses, items, tooMany };
}

// The /24 an IPv4 address sits in ("10.1.2.0/24"); null for names and IPv6.
export function block24(host: string) {
  const n = v4(host);
  return n === null ? null : `${v4text(n - (n & 255))}/24`;
}
