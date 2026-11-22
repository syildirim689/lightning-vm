import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { cut, day, firstLine, hostLabel, hostName, hostOf, keyFingerprint, packageName, parseKey, passkeyName, readAgent, ruleName, snapshotName, sshKeyName, stamp,
  totpLabel, uniqueName, type PasskeyWords } from './proposals.ts';

const messages = (locale: string) => JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8')).Proposals as Record<string, string> & PasskeyWords;
const tr = messages('tr');
const en = messages('en');

// Browsers and systems as they really announce themselves, the device kind, and what userAgentData adds.
const agents: [string, { brands?: { brand: string }[]; platform?: string; mobile?: boolean } | null, number, string | null, string | null, 'desktop' | 'phone' | 'tablet'][] = [
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', null, 0, 'Chrome', 'Windows', 'desktop'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0', null, 0, 'Edge', 'Windows', 'desktop'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/115.0.0.0', null, 0, 'Opera', 'Windows', 'desktop'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', null, 0, 'Safari', 'macOS', 'desktop'],
  // An iPad asks for the desktop page with a Mac's user agent; its touch points give it away.
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', null, 5, 'Safari', 'iPadOS', 'tablet'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1', null, 5, 'Chrome', 'iOS', 'phone'],
  ['Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', null, 5, 'Safari', 'iPadOS', 'tablet'],
  ['Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0', null, 0, 'Firefox', 'Linux', 'desktop'],
  ['Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36', null, 5, 'Samsung Internet', 'Android', 'phone'],
  ['Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', null, 5, 'Chrome', 'Android', 'tablet'],
  ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', null, 0, 'Chrome', 'ChromeOS', 'desktop'],
  // Headless Chrome (the browser tests) is Chrome.
  ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36', null, 0, 'Chrome', 'Linux', 'desktop'],
  // userAgentData: the brand that is not the compatibility one, and the platform, win over a reduced user agent.
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    { brands: [{ brand: 'Not_A Brand' }, { brand: 'Chromium' }, { brand: 'Brave' }], platform: 'Windows', mobile: false }, 0, 'Brave', 'Windows', 'desktop'],
  ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    { brands: [{ brand: 'Google Chrome' }, { brand: 'Chromium' }], platform: 'Android', mobile: true }, 5, 'Chrome', 'Android', 'phone'],
  ['', { brands: [{ brand: 'Microsoft Edge' }], platform: 'macOS', mobile: false }, 0, 'Edge', 'macOS', 'desktop'],
  // Unknown: nothing is made up.
  ['curl/8.5.0', null, 0, null, null, 'desktop'],
  ['', null, 0, null, null, 'desktop'],
];

test('browser, system and device kind from the user agent and userAgentData', () => {
  for (const [ua, hints, touch, browser, os, kind] of agents) assert.deepEqual(readAgent(ua, hints, touch), { browser, os, kind }, ua || JSON.stringify(hints));
  assert.deepEqual(readAgent(undefined), { browser: null, os: null, kind: 'desktop' });
});

test('a passkey is named by browser, system and device in the panel\'s language', () => {
  const pc = readAgent(agents[0][0]);
  assert.equal(passkeyName(pc, tr), 'Chrome · Windows · Masaüstü');
  assert.equal(passkeyName(pc, en), 'Chrome · Windows · Desktop');
  assert.equal(passkeyName(readAgent(agents[5][0], null, 5), tr), 'Chrome · iOS · Telefon');
  assert.equal(passkeyName(readAgent(agents[6][0], null, 5), en), 'Safari · iPadOS · Tablet');
  // An unknown browser is called that, in the same language; nothing invented for the system.
  assert.equal(passkeyName(readAgent('curl/8.5.0'), tr), 'Tarayıcı · Masaüstü');
  assert.equal(passkeyName(readAgent('curl/8.5.0'), en), 'Browser · Desktop');
});

test('a passkey on a security key or a phone says so first, as the WebAuthn response tells it', () => {
  const pc = readAgent(agents[0][0]);
  assert.equal(passkeyName(pc, tr, [], { attachment: 'cross-platform', transports: ['usb', 'nfc'] }), 'Güvenlik anahtarı · Chrome · Windows');
  assert.equal(passkeyName(pc, en, [], { attachment: 'cross-platform', transports: ['hybrid', 'internal'] }), 'Phone · Chrome · Windows');
  assert.equal(passkeyName(pc, en, [], { attachment: 'platform', transports: ['internal'] }), 'Chrome · Windows · Desktop');
  assert.equal(passkeyName(pc, en, [], { attachment: null }), 'Chrome · Windows · Desktop');
});

test('a proposal is free among the person\'s own: " 2", " 3"…, case and spacing ignored', () => {
  assert.equal(uniqueName('Laptop', []), 'Laptop');
  assert.equal(uniqueName('Laptop', ['laptop']), 'Laptop 2');
  assert.equal(uniqueName('Laptop', ['Laptop', 'LAPTOP  2', 'Laptop 3']), 'Laptop 4');
  assert.equal(uniqueName('  Two   spaces ', []), 'Two spaces');
  assert.equal(uniqueName('', ['x']), '');
  assert.equal(uniqueName('Proje', [], { numbered: true }), 'Proje 1');
  assert.equal(uniqueName('Proje', ['Proje 1'], { numbered: true }), 'Proje 2');
  // Turkish capitals fold as Turkish: "İSTANBUL" is taken when "istanbul" is.
  assert.equal(uniqueName('İstanbul', ['istanbul']), 'İstanbul 2');
  const pc = readAgent(agents[0][0]);
  assert.equal(passkeyName(pc, tr, ['Chrome · Windows · Masaüstü']), 'Chrome · Windows · Masaüstü 2');
  assert.equal(passkeyName(pc, tr, ['Chrome · Windows · Masaüstü', null, undefined]), 'Chrome · Windows · Masaüstü 2');
});

test('limits hold: the base is shortened, the number is kept, nothing ends in a separator', () => {
  const long = 'x'.repeat(70);
  assert.equal(uniqueName(long, []).length, 60);
  const second = uniqueName(long, [cut(long, 60)]);
  assert.equal(second.length, 60);
  assert.ok(second.endsWith(' 2'));
  assert.equal(uniqueName('abc · def', ['abc · d'], { max: 7 }), 'abc 2');
  assert.equal(cut('😀😀😀', 2), '😀😀', 'a surrogate pair is never split');
  assert.equal(firstLine('\n  apt   update && apt upgrade -y \nsecond'), 'apt update && apt upgrade -y');
  const cutLine = firstLine('word '.repeat(30), 20);
  assert.ok(Array.from(cutLine).length <= 20 && cutLine.endsWith('…'), cutLine);
  for (const s of [firstLine('a'.repeat(200), 60), uniqueName('é'.repeat(200), [], { max: 100 })]) assert.ok(Array.from(s).length <= 100);
});

test('host names follow the API\'s rule: a-z, 0-9 and hyphens, 63 characters, numbered', () => {
  const rule = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
  assert.equal(hostLabel('Ubuntu 24.04 LTS'), 'ubuntu-24-04-lts');
  assert.equal(hostLabel('Işık Ağı Şube Çözüm'), 'isik-agi-sube-cozum');
  assert.equal(hostLabel('--Prod!!'), 'prod');
  assert.equal(hostLabel('!!!'), '');
  assert.equal(hostName('Ubuntu', []), 'ubuntu-1');
  assert.equal(hostName('Ubuntu', ['ubuntu-1', 'ubuntu-2']), 'ubuntu-3');
  assert.equal(hostName('', []), 'server-1');
  assert.equal(hostName('İstanbul Lab', []), 'istanbul-lab-1');
  for (const x of [hostName('a'.repeat(100), []), hostName('a-'.repeat(40), ['a']), uniqueName(`${hostLabel('z'.repeat(63), 58)}-copy`, [`${'z'.repeat(58)}-copy`], { max: 63, sep: '' })]) {
    assert.match(x, rule, x);
    assert.ok(x.length <= 63);
  }
});

test('time-based names sort as text and fit the snapshot rule', () => {
  const at = new Date(2026, 10, 3, 9, 5);
  assert.equal(stamp(at), '2026-11-03 09:05');
  assert.equal(day(at), '2026-11-03');
  assert.equal(stamp(new Date(Date.UTC(2026, 0, 1, 23, 30)), 'Europe/Istanbul'), '2026-01-02 02:30');
  assert.equal(snapshotName('web-1', at), 'web-1 2026-11-03 09:05');
  assert.equal(snapshotName('web-1', at, ['web-1 2026-11-03 09:05']), 'web-1 2026-11-03 09:05 2');
  const rule = /^[\p{L}\p{N}][\p{L}\p{N} ._:()-]{0,79}$/u;
  for (const name of ['web-1', 'çok/garip*ad', '-x', 'a'.repeat(100), '']) assert.match(snapshotName(name, at), rule, name);
});

test('SSH keys: the comment, else type and fingerprint', async () => {
  const blob = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
  assert.equal(sshKeyName(`ssh-ed25519 ${blob} serhat@laptop`, null), 'serhat@laptop');
  assert.equal(sshKeyName(`ssh-ed25519 ${blob} serhat@laptop`, null, ['serhat@laptop']), 'serhat@laptop 2');
  const fp = await keyFingerprint(blob);
  assert.match(fp, /^SHA256:[A-Za-z0-9+/]{43}$/);
  // As ssh-keygen -lf prints it for this key.
  assert.equal(fp, 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU');
  assert.equal(sshKeyName(`ssh-ed25519 ${blob}`, fp), `ed25519 ${fp.slice(0, 15)}`);
  assert.equal(sshKeyName(`ssh-ed25519 ${blob}`, null), 'ed25519');
  assert.equal(sshKeyName('not a key', fp), undefined);
  assert.deepEqual(parseKey(`  ecdsa-sha2-nistp256   ${blob}   a b `), { type: 'ecdsa-sha2-nistp256', blob, comment: 'a b' });
  assert.ok(sshKeyName(`ssh-rsa ${blob} ${'c'.repeat(200)}`, null)!.length <= 100);
});

test('TOTP: issuer and account read back from the URI the panel made', () => {
  assert.deepEqual(totpLabel('otpauth://totp/Acme%20Cloud:ay%C5%9Fe%40example.com?secret=ABC&issuer=Acme%20Cloud'), ['Acme Cloud', 'ayşe@example.com']);
  assert.deepEqual(totpLabel('otpauth://totp/Acme:a%40b.c?secret=ABC'), ['Acme', 'a@b.c']);
  assert.deepEqual(totpLabel('nonsense'), ['', '']);
});

test('other proposals: webhook host, package sizes, firewall rules', () => {
  assert.equal(hostOf('https://hooks.example.com/lightning?x=1'), 'hooks.example.com');
  assert.equal(hostOf('ftp://example.com'), '');
  assert.equal(hostOf('hooks.example'), '');
  assert.equal(packageName(2, 4096, 40), '2 vCPU · 4 GB · 40 GB');
  assert.equal(packageName(1, 1536, 20), '1 vCPU · 1.5 GB · 20 GB');
  assert.equal(packageName(2, 4096, 40, ['2 vCPU · 4 GB · 40 GB']), '2 vCPU · 4 GB · 40 GB 2');
  assert.equal(packageName(0, 4096, 40), undefined);
  assert.equal(ruleName('tcp', '443'), 'HTTPS');
  assert.equal(ruleName('udp', '53'), 'DNS');
  assert.equal(ruleName('udp', '51820'), 'WireGuard');
  assert.equal(ruleName('tcp', '8000-8100'), 'TCP 8000-8100');
  assert.equal(ruleName('tcp', ''), 'TCP');
  assert.equal(ruleName('tcp', '12345'), 'TCP 12345');
  assert.equal(ruleName('icmp', null), 'Ping');
});

test('both languages have every word, and no proposal mixes them', () => {
  const keys = ['desktop', 'phone', 'tablet', 'browser', 'securityKey', 'otherPhone', 'tokenRead', 'tokenWrite', 'project', 'network', 'networkPlain', 'codesFile'];
  for (const k of keys) { assert.ok(tr[k]?.trim(), `tr ${k}`); assert.ok(en[k]?.trim(), `en ${k}`); }
  const pc = readAgent(agents[0][0]);
  const turkish = /[çğıöşüÇĞİÖŞÜ]|Masaüstü|Tarayıcı|Telefon|anahtar/;
  for (const via of [undefined, { attachment: 'cross-platform', transports: ['usb'] }, { attachment: 'cross-platform', transports: ['hybrid'] }]) {
    assert.doesNotMatch(passkeyName(pc, en, [], via), turkish);
    assert.doesNotMatch(passkeyName(readAgent('curl'), en, [], via), turkish);
  }
  assert.doesNotMatch(passkeyName(pc, tr), /Desktop|Browser|Phone|Security key/);
});
