// Formats of the values people type: what each accepts, how it is tidied when the field is left (so "AA-BB-CC…"
// becomes "aa:bb:cc…" and " 10.0.0.1 " becomes "10.0.0.1"), how the keyboard should look and an example.
// The API checks the same things; these give the answer while typing instead of after saving.
// Pure functions (run with: node --test lib/*.test.ts).

export type Format = 'ipv4' | 'ip' | 'cidr' | 'ipOrCidr' | 'privateCidr' | 'ipv6Prefix' | 'mac' | 'hostname' | 'fqdn' | 'domain' | 'serverName' | 'email' | 'port' | 'portRange' | 'url' | 'vlan'
  | 'tag' | 'sshKey' | 'money' | 'hostOrIp' | 'tckn' | 'vkn' | 'iban' | 'phone' | 'integer' | 'decimal';

const ipv4Re = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
export const isIPv4 = (s: string) => ipv4Re.test(s);

export function isIPv6(s: string): boolean {
  if (!/^[0-9a-f:.]+$/i.test(s) || !s.includes(':')) return false;
  // An embedded IPv4 tail counts as two groups.
  let x = s;
  const tail = x.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) { if (!isIPv4(tail[1])) return false; x = `${x.slice(0, -tail[1].length)}0:0`; }
  const halves = x.split('::');
  if (halves.length > 2) return false;
  const groups = (h: string) => (h === '' ? [] : h.split(':'));
  const [a, b] = [groups(halves[0]), halves.length === 2 ? groups(halves[1]) : []];
  if ([...a, ...b].some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return false;
  return halves.length === 2 ? a.length + b.length <= 7 : a.length === 8;
}
export const isIP = (s: string) => isIPv4(s) || isIPv6(s);

export function isCIDR(s: string): boolean {
  const [ip, len, extra] = s.split('/');
  if (extra !== undefined || len === undefined || !/^\d{1,3}$/.test(len)) return false;
  return isIPv4(ip) ? +len <= 32 : isIPv6(ip) ? +len <= 128 : false;
}

// MAC addresses in any common spelling: aa:bb:cc:dd:ee:ff, AA-BB-CC-DD-EE-FF, aabb.ccdd.eeff, aabbccddeeff.
export function normalizeMac(s: string): string {
  const hex = s.trim().replace(/[\s:.-]/g, '').toLowerCase();
  return /^[0-9a-f]{12}$/.test(hex) ? hex.match(/../g)!.join(':') : s.trim();
}
export const isMac = (s: string) => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(normalizeMac(s));

// Host names (RFC 1123 labels), domains (at least two labels) and the panel's server names (one lowercase label).
const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;
export const isHostname = (s: string) => s.length <= 253 && s.replace(/\.$/, '').split('.').every((l) => label.test(l));
// A full name for reverse DNS (as the API checks it): two or more labels, the last starting with a letter.
export const isFqdn = (s: string) => /^(?=.{1,253}\.?$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]\.?$/i.test(s);
// The panel's own domain: letters only in the last label, 2–63 of them.
export const isDomain = (s: string) => /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s);
export const isServerName = (s: string) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s);
// What a typed server name most likely meant: "Web Server_1" → "web-server-1".
export const suggestServerName = (s: string) => s.trim().toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i')
  .replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/, '');

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
export const isPort = (s: string) => /^\d{1,5}$/.test(s) && +s >= 1 && +s <= 65535;
export function isPortRange(s: string): boolean {
  const [a, b, extra] = s.split('-');
  if (extra !== undefined) return false;
  return b === undefined ? isPort(a) : isPort(a) && isPort(b) && +a <= +b;
}
export function isUrl(s: string): boolean {
  try { const u = new URL(s); return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname; } catch { return false; }
}
export const isVlan = (s: string) => /^\d{1,4}$/.test(s) && +s >= 0 && +s <= 4094;
// Private networks for customer LANs: RFC 1918, /16 to /28.
export function isPrivateCidr(s: string): boolean {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m || !isIPv4(s.split('/')[0])) return false;
  const [a, b, len] = [+m[1], +m[2], +m[5]];
  return len >= 16 && len <= 28 && (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
}
export const isIPv6Prefix = (s: string) => { const [ip, len] = s.split('/'); return isIPv6(ip ?? '') && /^\d{2}$/.test(len ?? '') && +len >= 48 && +len <= 64; };
// Server tags: a letter or digit first, then also space . _ -, up to 24.
export const isTag = (s: string) => /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,23}$/u.test(s);
export const isSshKey = (s: string) => /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) ([A-Za-z0-9+/]+={0,2})( [^\r\n]{0,200})?$/.test(s);
// Amounts: digits with a dot or comma and up to four decimals ("9,90" and "9.90" mean the same).
export const isMoney = (s: string) => /^\d{1,10}([.,]\d{1,4})?$/.test(s);

// Turkish identity (TCKN, 11 digits) and tax (VKN, 10 digits) numbers with their check digits, as the API checks them.
export function isTckn(v: string): boolean {
  if (!/^[1-9]\d{10}$/.test(v)) return false;
  const d = [...v].map(Number);
  const odd = d[0] + d[2] + d[4] + d[6] + d[8], even = d[1] + d[3] + d[5] + d[7];
  return ((odd * 7 - even) % 10 + 10) % 10 === d[9] && d.slice(0, 10).reduce((a, b) => a + b, 0) % 10 === d[10];
}
export function isVkn(v: string): boolean {
  if (!/^\d{10}$/.test(v)) return false;
  const d = [...v].map(Number);
  let sum = 0;
  for (let i = 0; i < 9; i++) { const t = (d[i] + 9 - i) % 10; let r = (t * 2 ** (9 - i)) % 9; if (t !== 0 && r === 0) r = 9; sum += r; }
  return (10 - (sum % 10)) % 10 === d[9];
}
// IBAN: country, check digits and account, verified with the mod-97 rule; shown in groups of four.
export function isIban(v: string): boolean {
  const x = v.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(x)) return false;
  const n = (x.slice(4) + x.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let r = 0;
  for (const ch of n) r = (r * 10 + Number(ch)) % 97;
  return r === 1;
}
export const groupIban = (v: string) => v.replace(/\s/g, '').toUpperCase().replace(/(.{4})(?=.)/g, '$1 ');
// Phone numbers in international form (+905321234567); a Turkish 0532… number gets its +90.
export function normalizePhone(v: string): string {
  const d = v.replace(/[\s().-]/g, '');
  if (/^0\d{10}$/.test(d)) return `+90${d.slice(1)}`;
  if (/^00[1-9]\d{7,14}$/.test(d)) return `+${d.slice(2)}`;
  if (/^5\d{9}$/.test(d)) return `+90${d}`;
  return d || v.trim();
}
export const isPhone = (v: string) => /^\+[1-9]\d{7,14}$/.test(normalizePhone(v));

// Tidying when the field is left. Never changes the meaning; returns the input unchanged when it is not understood.
export function normalize(format: Format, raw: string): string {
  const s = raw.trim();
  switch (format) {
    case 'mac': return normalizeMac(s);
    case 'hostname': case 'domain': case 'email': return s.toLowerCase();
    case 'ip': case 'ipv4': case 'cidr': case 'ipOrCidr': return isIPv6(s.split('/')[0]) ? s.toLowerCase() : s.replace(/\s+/g, '');
    case 'portRange': return s.replace(/\s*[-–—:]\s*/, '-');
    case 'fqdn': case 'hostOrIp': return s.toLowerCase().replace(/\.$/, '');
    case 'sshKey': return s.replace(/\s+/g, ' ');
    case 'privateCidr': return s.replace(/\s+/g, '');
    case 'ipv6Prefix': return s.toLowerCase();
    case 'tckn': case 'vkn': return s.replace(/\s/g, '');
    case 'iban': return isIban(s) ? groupIban(s) : s;
    case 'phone': return normalizePhone(s);
    case 'integer': return s.replace(/[\s.]/g, '');
    case 'decimal': return s.replace(/\s/g, '').replace(/^(\d+),(\d+)$/, '$1.$2');
    case 'money': return s.replace(/\s/g, '').replace(/^(\d+),(\d{1,4})$/, '$1.$2');
    case 'url': return s && !/^[a-z]+:\/\//i.test(s) && /^[\w.-]+\.[a-z]{2,}/i.test(s) ? `https://${s}` : s;
    default: return s;
  }
}

export function isValid(format: Format, s: string): boolean {
  switch (format) {
    case 'ipv4': return isIPv4(s);
    case 'ip': return isIP(s);
    case 'cidr': return isCIDR(s);
    case 'ipOrCidr': return isIP(s) || isCIDR(s);
    case 'mac': return isMac(s);
    case 'hostname': return isHostname(s);
    case 'domain': return isDomain(s);
    case 'serverName': return isServerName(s);
    case 'email': return isEmail(s);
    case 'port': return isPort(s);
    case 'portRange': return isPortRange(s);
    case 'url': return isUrl(s);
    case 'vlan': return isVlan(s);
    case 'privateCidr': return isPrivateCidr(s);
    case 'ipv6Prefix': return isIPv6Prefix(s);
    case 'fqdn': return isFqdn(s);
    case 'hostOrIp': return isIP(s) || isHostname(s);
    case 'tag': return isTag(s);
    case 'sshKey': return isSshKey(s);
    case 'money': return isMoney(s);
    case 'integer': return /^\d{1,9}$/.test(s);
    case 'decimal': return /^\d{1,9}([.,]\d{1,4})?$/.test(s);
    case 'tckn': return isTckn(s);
    case 'vkn': return isVkn(s);
    case 'iban': return isIban(s);
    case 'phone': return isPhone(s);
  }
}

// How each field should behave on a phone keyboard and in the browser.
export const inputProps: Record<Format, { inputMode?: 'text' | 'numeric' | 'decimal' | 'email' | 'url' | 'tel'; mono: boolean; example: string }> = {
  ipv4: { mono: true, example: '203.0.113.10' },
  ip: { mono: true, example: '203.0.113.10' },
  cidr: { mono: true, example: '203.0.113.0/24' },
  ipOrCidr: { mono: true, example: '203.0.113.10 · 198.51.100.0/24' },
  mac: { mono: true, example: '00:50:56:ab:cd:ef' },
  hostname: { mono: true, example: 'esxi01.example.com' },
  domain: { mono: true, example: 'example.com' },
  serverName: { mono: true, example: 'web-1' },
  email: { inputMode: 'email', mono: false, example: 'name@example.com' },
  port: { inputMode: 'numeric', mono: true, example: '443' },
  portRange: { inputMode: 'numeric', mono: true, example: '443 · 8000-8100' },
  url: { inputMode: 'url', mono: true, example: 'https://example.com' },
  vlan: { inputMode: 'numeric', mono: true, example: '100' },
  privateCidr: { mono: true, example: '10.10.0.0/24' },
  ipv6Prefix: { mono: true, example: '2001:db8:40::/64' },
  fqdn: { mono: true, example: 'mail.example.com' },
  hostOrIp: { mono: true, example: 'vcenter.example.com' },
  tag: { mono: false, example: 'production' },
  sshKey: { mono: true, example: 'ssh-ed25519 AAAAC3Nza… user@laptop' },
  money: { inputMode: 'decimal', mono: false, example: '9.90' },
  integer: { inputMode: 'numeric', mono: false, example: '7' },
  decimal: { inputMode: 'decimal', mono: false, example: '20' },
  tckn: { inputMode: 'numeric', mono: true, example: '10000000146' },
  vkn: { inputMode: 'numeric', mono: true, example: '1234567890' },
  iban: { mono: true, example: 'TR33 0006 1005 1978 6457 8413 26' },
  phone: { inputMode: 'tel', mono: false, example: '+90 532 123 45 67' },
};

// Several values in one box (pasted lists): split on commas, spaces, semicolons or new lines.
export const splitList = (s: string) => s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
