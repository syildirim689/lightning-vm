// Names the panel proposes for things that are about to be created (a passkey, an API token, a snapshot, a firewall…),
// so a form can be sent as it opens and what is listed later still says what it is. Plain functions, no React and no
// translations of their own: the words come from messages (namespace Proposals) and are passed in, so a proposal is
// always in the panel's language. Every proposal is a value the person may change; it never renames anything that
// exists. docs/proposals.md lists where each one is used.

// ---------------------------------------------------------------------------------------------------------------
// Uniqueness and limits

const fold = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr');

// `base`, or `base 2`, `base 3`… (`sep` between them) when the person already has one by that name (case and spacing
// ignored). The result is never longer than `max`: the base is shortened, the number is kept. `numbered` always adds
// a number, starting at 1 ("ubuntu-1"), as host names do.
export function uniqueName(base: string, taken: Iterable<string | null | undefined>, { max = 60, sep = ' ', numbered = false }: { max?: number; sep?: string; numbered?: boolean } = {}): string {
  const clean = base.trim().replace(/\s+/g, ' ');
  const used = new Set<string>();
  for (const x of taken) if (x) used.add(fold(x));
  const fit = (suffix: string) => `${cut(clean, max - suffix.length).replace(/[\s\-·.:_(]+$/u, '')}${suffix}`;
  if (!numbered && !clean) return '';
  if (!numbered && !used.has(fold(cut(clean, max)))) return cut(clean, max);
  for (let n = numbered ? 1 : 2; n < 10_000; n++) {
    const candidate = fit(`${clean ? sep : ''}${n}`);
    if (!used.has(fold(candidate))) return candidate;
  }
  return cut(clean, max);
}

// At most `max` characters, never splitting a surrogate pair, without a trailing space.
export function cut(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, Math.max(0, max)).join('').trimEnd();
}

// The first line of a text, as a name: spaces tidied, cut to `max` at a word where it can be.
export function firstLine(text: string, max = 60): string {
  const line = (text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '').replace(/\s+/g, ' ');
  if (Array.from(line).length <= max) return line;
  const short = cut(line, max - 1);
  const space = short.lastIndexOf(' ');
  return `${space > max / 2 ? short.slice(0, space) : short}…`;
}

// A host name (RFC 1123 label, as the API checks it): lower case a-z, 0-9 and hyphens, letters with marks (ş, ö, ı)
// written plainly, at most `max` characters, never starting or ending with a hyphen. Empty when nothing is left.
export function hostLabel(text: string, max = 63): string {
  return text.replace(/[ıİ]/g, 'i').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, max).replace(/-+$/, '');
}

// A free host name from a base ("ubuntu" → "ubuntu-1", "ubuntu-2"…), within the 63 characters of a label.
export function hostName(base: string, taken: Iterable<string | null | undefined>, fallback = 'server'): string {
  return uniqueName(hostLabel(base, 40) || fallback, taken, { max: 63, sep: '-', numbered: true });
}

// The local date and time in a form that sorts as text: "2026-11-23 14:05". The same in every language.
export function stamp(at: Date = new Date(), timeZone?: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
export const day = (at: Date = new Date(), timeZone?: string) => stamp(at, timeZone).slice(0, 10);

// ---------------------------------------------------------------------------------------------------------------
// Browser and device, for a passkey's name. Read in the browser only; nothing of it is sent except the chosen name.

export type DeviceKind = 'desktop' | 'phone' | 'tablet';
export type Agent = { browser: string | null; os: string | null; kind: DeviceKind };
// What navigator.userAgentData tells (Chromium browsers): brands, platform and whether it is a phone.
export type AgentHints = { brands?: { brand: string; version?: string }[]; platform?: string; mobile?: boolean };

const browsers: [RegExp, string][] = [[/Edg(?:e|A|iOS)?\//, 'Edge'], [/OPR\/|Opera|OPT\//, 'Opera'], [/YaBrowser\//, 'Yandex'], [/SamsungBrowser\//, 'Samsung Internet'],
  [/Vivaldi\//, 'Vivaldi'], [/Firefox\/|FxiOS\//, 'Firefox'], [/CriOS\/|Chrome\//, 'Chrome'], [/Safari\//, 'Safari']];
const systems: [RegExp, string][] = [[/iPad/, 'iPadOS'], [/iPhone|iPod/, 'iOS'], [/Android/, 'Android'], [/Windows/, 'Windows'], [/CrOS/, 'ChromeOS'],
  [/Mac OS X|Macintosh/, 'macOS'], [/Linux|X11/, 'Linux']];
// Brands as userAgentData names them; "Not A;Brand" and plain Chromium are only there for compatibility.
const brands: [RegExp, string][] = [[/Edge/i, 'Edge'], [/Opera/i, 'Opera'], [/Brave/i, 'Brave'], [/Vivaldi/i, 'Vivaldi'], [/Yandex/i, 'Yandex'], [/Samsung/i, 'Samsung Internet'],
  [/Google Chrome/i, 'Chrome']];
const platforms: Record<string, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux', android: 'Android', 'chrome os': 'ChromeOS', 'chromium os': 'ChromeOS', chromeos: 'ChromeOS', ios: 'iOS' };

// `touch`: navigator.maxTouchPoints. An iPad asks for desktop pages with a Mac's user agent; touch gives it away.
export function readAgent(ua: string | null | undefined, hints?: AgentHints | null, touch = 0): Agent {
  const text = ua ?? '';
  const brand = hints?.brands?.map((b) => brands.find(([r]) => r.test(b.brand))?.[1]).find(Boolean)
    ?? (hints?.brands?.some((b) => /Chromium/i.test(b.brand)) && !browsers.some(([r]) => r.test(text)) ? 'Chromium' : undefined);
  const browser = brand ?? browsers.find(([r]) => r.test(text))?.[1] ?? null;
  const ipad = /Macintosh/.test(text) && touch > 1;
  const os = ipad ? 'iPadOS' : (hints?.platform && platforms[hints.platform.toLowerCase()]) || systems.find(([r]) => r.test(text))?.[1] || null;
  const kind: DeviceKind = ipad || /iPad|Tablet/.test(text) || (/Android/.test(text) && !/Mobile/.test(text) && hints?.mobile !== true) ? 'tablet'
    : hints?.mobile || /Mobi|iPhone|iPod|Android/.test(text) ? 'phone' : 'desktop';
  return { browser, os, kind };
}

export type PasskeyWords = { desktop: string; phone: string; tablet: string; browser: string; securityKey: string; otherPhone: string };
// How the authenticator was reached, as the WebAuthn response tells it: this device's own (platform), or another one
// (cross-platform) over USB/NFC/Bluetooth (a security key) or over "hybrid" (a phone that scanned a QR code).
export type Authenticator = { attachment?: string | null; transports?: string[] | null };

// "Chrome · Windows · Masaüstü"; a security key or a phone first ("Güvenlik anahtarı · Chrome · Windows"); an unknown
// browser is called that ("Tarayıcı · Masaüstü"). At most 60 characters, and free among the person's passkeys.
export function passkeyName(agent: Agent, w: PasskeyWords, taken: Iterable<string | null | undefined> = [], via?: Authenticator | null): string {
  const roaming = via?.attachment === 'cross-platform';
  const lead = roaming ? (via?.transports?.includes('hybrid') ? w.otherPhone : w.securityKey) : null;
  const parts = [lead, agent.browser ?? w.browser, agent.os, roaming ? null : w[agent.kind]].filter((x): x is string => !!x);
  return uniqueName(parts.join(' · '), taken, { max: 60 });
}

// The issuer and account an otpauth:// URI names ("Acme Cloud", "ayse@example.com"): the issuer parameter, else the
// part of the label before the colon.
export function totpLabel(uri: string): [string, string] {
  try {
    const u = new URL(uri);
    const label = decodeURIComponent(u.pathname.replace(/^\/+/, '').replace(/^totp\//i, ''));
    const at = label.indexOf(':');
    return [u.searchParams.get('issuer') ?? (at >= 0 ? label.slice(0, at) : ''), at >= 0 ? label.slice(at + 1) : label];
  } catch { return ['', '']; }
}

// ---------------------------------------------------------------------------------------------------------------
// SSH keys

const keyLine = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/]+={0,2})(?: ([^\r\n]{0,200}))?$/;
const shortType: Record<string, string> = { 'ssh-ed25519': 'ed25519', 'ssh-rsa': 'rsa', 'ecdsa-sha2-nistp256': 'ecdsa-256', 'ecdsa-sha2-nistp384': 'ecdsa-384', 'ecdsa-sha2-nistp521': 'ecdsa-521' };
export function parseKey(text: string): { type: string; blob: string; comment: string } | null {
  const m = keyLine.exec(text.trim().replace(/\s+/g, ' '));
  return m ? { type: m[1], blob: m[2], comment: (m[3] ?? '').trim() } : null;
}
// SHA256 of the key, as ssh-keygen -l prints it and the API stores it ("SHA256:…", no padding).
export async function keyFingerprint(blob: string): Promise<string> {
  const bytes = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `SHA256:${btoa(String.fromCharCode(...hash)).replace(/=+$/, '')}`;
}
// The key's own comment ("serhat@laptop"), else its type and the start of its fingerprint ("ed25519 SHA256:Ab3dE9xQ").
// Up to 100 characters, free among the person's keys. Undefined while the text is no key.
export function sshKeyName(text: string, fingerprint: string | null | undefined, taken: Iterable<string | null | undefined> = []): string | undefined {
  const k = parseKey(text);
  if (!k) return undefined;
  const base = k.comment || `${shortType[k.type] ?? k.type}${fingerprint ? ` ${fingerprint.slice(0, 15)}` : ''}`;
  return uniqueName(base, taken, { max: 100 });
}

// ---------------------------------------------------------------------------------------------------------------
// Other proposals

// A web address's host, for a webhook's description ("hooks.example.com"); empty while it is no address.
export function hostOf(url: string): string {
  try { const u = new URL(url.trim()); return /^https?:$/.test(u.protocol) ? u.hostname : ''; } catch { return ''; }
}

// A snapshot: the server and when ("web-1 2026-11-23 14:05"), within the API's 80 characters and its characters
// (letters and digits first, then letters, digits, spaces and . _ : ( ) -).
export function snapshotName(server: string, at: Date = new Date(), taken: Iterable<string | null | undefined> = []): string {
  const when = stamp(at);
  const who = server.replace(/[^\p{L}\p{N} ._:()-]+/gu, '-').replace(/^[^\p{L}\p{N}]+/u, '');
  return uniqueName(who ? `${cut(who, 80 - when.length - 1)} ${when}` : when, taken, { max: 80, sep: ' ' });
}

// A firewall rule by the service behind its port ("HTTPS", "PostgreSQL", "HTTP 8080"), else protocol and port
// ("TCP 8000-8100", "UDP"). The same in every language, as the one-click rules are named.
const tcpNames: Record<number, string> = { 21: 'FTP', 22: 'SSH', 25: 'SMTP', 53: 'DNS', 80: 'HTTP', 110: 'POP3', 143: 'IMAP', 443: 'HTTPS', 445: 'SMB', 465: 'SMTPS', 587: 'SMTP',
  993: 'IMAPS', 995: 'POP3S', 1433: 'SQL Server', 2049: 'NFS', 3306: 'MySQL', 3389: 'RDP', 5432: 'PostgreSQL', 5900: 'VNC', 6379: 'Redis', 8080: 'HTTP 8080', 8443: 'HTTPS 8443',
  9200: 'Elasticsearch', 11211: 'Memcached', 27017: 'MongoDB' };
const udpNames: Record<number, string> = { 53: 'DNS', 123: 'NTP', 161: 'SNMP', 443: 'QUIC', 500: 'IKE', 1194: 'OpenVPN', 4500: 'IPsec NAT-T', 51820: 'WireGuard' };
export function ruleName(protocol: string, port: string | null | undefined): string {
  const p = protocol.toLowerCase();
  if (p === 'icmp') return 'Ping';
  if (p === 'esp') return 'ESP (IPsec)';
  if (p === 'gre') return 'GRE';
  const range = (port ?? '').trim();
  const single = /^\d{1,5}$/.test(range) ? Number(range) : null;
  const known = single === null ? undefined : (p === 'udp' ? udpNames : tcpNames)[single];
  return known ?? `${p.toUpperCase()}${range ? ` ${range}` : ''}`;
}

// A package from what it gives ("2 vCPU · 4 GB · 40 GB"); memory in GB, with one decimal under 10 GB when needed.
export function packageName(vcpu: number, memoryMb: number, diskGb: number, taken: Iterable<string | null | undefined> = []): string | undefined {
  if (!(vcpu > 0) || !(memoryMb > 0) || !(diskGb > 0)) return undefined;
  const gb = memoryMb / 1024;
  const memory = Number.isInteger(gb) || gb >= 10 ? String(Math.round(gb)) : gb.toFixed(1).replace(/\.0$/, '');
  return uniqueName(`${vcpu} vCPU · ${memory} GB · ${diskGb} GB`, taken, { max: 100 });
}
