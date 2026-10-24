// Pure helpers of rdns.ts (no database, so unit tests can load them): reverse names and the default PTR.
import { isIP } from 'node:net';

export const hostname = /^(?=.{1,253}\.?$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]\.?$/i;

// 192.0.2.10 -> 10.2.0.192.in-addr.arpa.; IPv6 -> 32 nibbles under ip6.arpa.
export function reverseName(ip: string) {
  if (isIP(ip) === 4) return `${ip.split('.').reverse().join('.')}.in-addr.arpa.`;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const parts = (s: string) => (s ? s.split(':') : []);
  const h = parts(head), t = parts(tail);
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t].map((g) => g.padStart(4, '0'));
  return `${groups.join('').split('').reverse().join('.')}.ip6.arpa.`;
}

// Template variables: {ip}, {ip-dashed} (dots and colons become dashes), {name} (the server name).
export function renderPtr(template: string, ip: string, name: string) {
  const out = template.replaceAll('{ip-dashed}', ip.replace(/[.:]+/g, '-').replace(/^-|-$/g, '')).replaceAll('{ip}', ip).replaceAll('{name}', name).toLowerCase();
  return out ? (out.endsWith('.') ? out : `${out}.`) : '';
}
