// The WinRM client of the adapter (Microsoft Hyper-V): PowerShell on the host over WS-Management, HTTPS only, with
// NTLMv2 or Basic sign-in, TLS trust exactly as the connection says (system CAs, a given CA, or a pinned leaf
// certificate), and failures turned into the adapter contract's codes (docs/adapter-contract.md). No dependencies.
import { createHash, createHmac, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import tls from 'node:tls';

export class Failure extends Error {
  constructor(code, message, extra) { super(message ?? code); this.code = code; Object.assign(this, extra); }
}

// Addresses the adapter never talks to (it sits on the panel's own network): loopback, link-local, unspecified
// and multicast, unless HYPERV_ALLOW_NETWORKS (comma-separated CIDRs) says otherwise.
const blocked = new BlockList();
for (const [net, bits, family] of [['127.0.0.0', 8, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['0.0.0.0', 8, 'ipv4'], ['224.0.0.0', 4, 'ipv4'], ['::1', 128, 'ipv6'], ['fe80::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'], ['::', 128, 'ipv6']]) blocked.addSubnet(net, bits, family);
const allowed = new BlockList();
for (const cidr of (process.env.HYPERV_ALLOW_NETWORKS ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
  const [net, bits] = cidr.split('/');
  if (isIP(net)) allowed.addSubnet(net, Number(bits ?? (isIP(net) === 4 ? 32 : 128)), isIP(net) === 4 ? 'ipv4' : 'ipv6');
}
export async function guardedAddress(host) {
  const list = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }).catch(() => { throw new Failure('DNS_FAILED', `cannot resolve ${host}`); });
  for (const a of list) {
    const family = a.family === 6 ? 'ipv6' : 'ipv4';
    if (blocked.check(a.address, family) && !allowed.check(a.address, family)) throw new Failure('ENDPOINT_BLOCKED', 'endpoint address is not permitted');
  }
  return list[0].address;
}

const certInfo = (der) => {
  try {
    const c = new X509Certificate(der);
    const alt = (c.subjectAltName ?? '').split(',').map((x) => x.trim());
    return { subject: c.subject.replace(/\n/g, ', '), issuer: c.issuer.replace(/\n/g, ', '), notAfter: new Date(c.validTo).toISOString().replace(/\.\d+Z$/, 'Z'),
      sha256: createHash('sha256').update(der).digest('hex'), dnsNames: alt.filter((x) => x.startsWith('DNS:')).map((x) => x.slice(4)),
      ips: alt.filter((x) => x.startsWith('IP Address:')).map((x) => x.slice(11)), pem: c.toString() };
  } catch { return undefined; }
};
// The certificate the endpoint presents, read without trusting it (for the "trust this certificate" dialog).
const presented = (address, port, host) => new Promise((resolve) => {
  const s = tls.connect({ host: address, port, servername: isIP(host) ? undefined : host, rejectUnauthorized: false, timeout: 8000 }, () => {
    const der = s.getPeerCertificate(true)?.raw; s.destroy(); resolve(der ? certInfo(der) : undefined);
  });
  s.on('error', () => resolve(undefined)); s.on('timeout', () => { s.destroy(); resolve(undefined); });
});

function tlsOptions(t = {}) {
  const mode = t.mode || 'system';
  if (mode === 'system') return {};
  if (mode === 'ca') {
    if (!/BEGIN CERTIFICATE/.test(t.caPem ?? '')) throw new Failure('INVALID_CA', 'the CA bundle is not PEM');
    return { ca: [...tls.rootCertificates, t.caPem] };
  }
  if (mode === 'pinned') {
    const pin = String(t.sha256 ?? '').replace(/:/g, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pin)) throw new Failure('INVALID_PIN', 'the fingerprint must be 64 hex characters');
    // The leaf must be exactly the pinned one; chain and name are not looked at.
    return { rejectUnauthorized: false, pin };
  }
  throw new Failure('INVALID_TLS_MODE', `unknown TLS mode ${mode}`);
}

function classify(err) {
  if (err instanceof Failure) return err;
  const code = err?.code ?? '';
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return new Failure('TLS_HOSTNAME_MISMATCH', err.message);
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code)) return new Failure('TLS_UNTRUSTED', err.message);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new Failure('DNS_FAILED', err.message);
  if (code === 'ECONNREFUSED') return new Failure('CONNECTION_REFUSED', err.message);
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || err?.name === 'AbortError' || err?.name === 'TimeoutError') return new Failure('TIMEOUT', 'timed out');
  return new Failure('NOT_WINRM', `no WinRM service answered at /wsman: ${err?.message ?? err}`);
}

// ---- NTLMv2 (MS-NLMP), enough to sign in over HTTPS -------------------------------------------------
// MD4 is not in every OpenSSL build any more, so it is here: 48 steps over 64-byte blocks.
export function md4(input) {
  const rol = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
  const bits = input.length * 8;
  const padded = Buffer.concat([input, Buffer.from([0x80]), Buffer.alloc((119 - (input.length % 64)) % 64), Buffer.alloc(8)]);
  padded.writeUInt32LE(bits >>> 0, padded.length - 8); padded.writeUInt32LE(Math.floor(bits / 2 ** 32), padded.length - 4);
  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const x = new Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) x[i] = padded.readUInt32LE(off + i * 4);
    const [aa, bb, cc, dd] = [a, b, c, d];
    const f = (p, q, r) => ((p & q) | (~p & r)) >>> 0, g = (p, q, r) => ((p & q) | (p & r) | (q & r)) >>> 0, h = (p, q, r) => (p ^ q ^ r) >>> 0;
    const step = (fn, p, q, r, s, k, n, add) => rol((p + fn(q, r, s) + x[k] + add) >>> 0, n);
    for (const i of [0, 4, 8, 12]) { a = step(f, a, b, c, d, i, 3, 0); d = step(f, d, a, b, c, i + 1, 7, 0); c = step(f, c, d, a, b, i + 2, 11, 0); b = step(f, b, c, d, a, i + 3, 19, 0); }
    for (const i of [0, 1, 2, 3]) { a = step(g, a, b, c, d, i, 3, 0x5a827999); d = step(g, d, a, b, c, i + 4, 5, 0x5a827999); c = step(g, c, d, a, b, i + 8, 9, 0x5a827999); b = step(g, b, c, d, a, i + 12, 13, 0x5a827999); }
    for (const i of [0, 2, 1, 3]) { a = step(h, a, b, c, d, i, 3, 0x6ed9eba1); d = step(h, d, a, b, c, i + 8, 9, 0x6ed9eba1); c = step(h, c, d, a, b, i + 4, 11, 0x6ed9eba1); b = step(h, b, c, d, a, i + 12, 15, 0x6ed9eba1); }
    a = (a + aa) >>> 0; b = (b + bb) >>> 0; c = (c + cc) >>> 0; d = (d + dd) >>> 0;
  }
  const out = Buffer.alloc(16);
  out.writeUInt32LE(a, 0); out.writeUInt32LE(b, 4); out.writeUInt32LE(c, 8); out.writeUInt32LE(d, 12);
  return out;
}
const utf16 = (s) => Buffer.from(String(s), 'utf16le');
const hmac = (key, ...parts) => { const m = createHmac('md5', key); for (const p of parts) m.update(p); return m.digest(); };
// "DOMAIN\user" or "user@domain" or just "user".
export function account(username) {
  const s = String(username);
  if (s.includes('\\')) return { domain: s.split('\\')[0], user: s.split('\\').slice(1).join('\\') };
  return { domain: '', user: s };
}
export const ntlmV2Hash = (user, domain, password) => hmac(md4(utf16(password)), utf16(user.toUpperCase() + domain));
const FLAGS = 0x00088207; // unicode, request target, NTLM, always sign, extended session security
export function ntlmNegotiate() {
  const m = Buffer.alloc(32);
  m.write('NTLMSSP\0', 0, 'latin1'); m.writeUInt32LE(1, 8); m.writeUInt32LE(FLAGS, 12);
  m.writeUInt32LE(32, 20); m.writeUInt32LE(32, 28); // empty domain and workstation, both at the end
  return m;
}
export function ntlmAuthenticate(challengeMessage, username, password, nonce = randomBytes(8), now = Date.now()) {
  const c = challengeMessage;
  if (c.length < 48 || c.toString('latin1', 0, 8) !== 'NTLMSSP\0' || c.readUInt32LE(8) !== 2) throw new Failure('NOT_WINRM', 'the server sent no NTLM challenge');
  const serverChallenge = c.subarray(24, 32);
  const infoLen = c.readUInt16LE(40), infoOff = c.readUInt32LE(44);
  const targetInfo = infoLen ? c.subarray(infoOff, infoOff + infoLen) : Buffer.alloc(4);
  // The server's own clock, when it sent one (MsvAvTimestamp, id 7), else ours: 100 ns steps since 1601.
  let time = Buffer.alloc(8);
  time.writeBigUInt64LE((BigInt(now) + 11644473600000n) * 10000n);
  for (let o = 0; o + 4 <= targetInfo.length;) { const id = targetInfo.readUInt16LE(o), len = targetInfo.readUInt16LE(o + 2); if (id === 0) break; if (id === 7 && len === 8) time = targetInfo.subarray(o + 4, o + 12); o += 4 + len; }
  const { domain, user } = account(username);
  const key = ntlmV2Hash(user, domain, password);
  const blob = Buffer.concat([Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]), time, nonce, Buffer.alloc(4), targetInfo, Buffer.alloc(4)]);
  const nt = Buffer.concat([hmac(key, serverChallenge, blob), blob]);
  const lm = Buffer.concat([hmac(key, serverChallenge, nonce), nonce]);
  const parts = [lm, nt, utf16(domain), utf16(user), utf16('LIGHTNING')];
  const head = Buffer.alloc(64);
  head.write('NTLMSSP\0', 0, 'latin1'); head.writeUInt32LE(3, 8);
  let off = 64;
  for (const [i, p] of parts.entries()) { head.writeUInt16LE(p.length, 12 + i * 8); head.writeUInt16LE(p.length, 14 + i * 8); head.writeUInt32LE(off, 16 + i * 8); off += p.length; }
  head.writeUInt32LE(off, 56); // session key: none
  head.writeUInt32LE(c.readUInt32LE(20) & FLAGS, 60);
  return Buffer.concat([head, ...parts]);
}

// ---- WS-Management ----------------------------------------------------------------------------------
const SHELL = 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function envelope(url, action, { shell, options = {}, body = '', timeout = 60 } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:w="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd" xmlns:rsp="${SHELL}" xmlns:p="http://schemas.microsoft.com/wbem/wsman/1/wsman.xsd">`
    + `<s:Header><a:To>${esc(url)}</a:To><w:ResourceURI s:mustUnderstand="true">${SHELL}/cmd</w:ResourceURI><a:ReplyTo><a:Address s:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address></a:ReplyTo>`
    + `<a:Action s:mustUnderstand="true">${action}</a:Action><w:MaxEnvelopeSize s:mustUnderstand="true">512000</w:MaxEnvelopeSize><a:MessageID>uuid:${randomUUID()}</a:MessageID><w:Locale xml:lang="en-US" s:mustUnderstand="false"/>`
    + `<p:DataLocale xml:lang="en-US" s:mustUnderstand="false"/><w:OperationTimeout>PT${timeout}S</w:OperationTimeout>`
    + (shell ? `<w:SelectorSet><w:Selector Name="ShellId">${esc(shell)}</w:Selector></w:SelectorSet>` : '')
    + (Object.keys(options).length ? `<w:OptionSet>${Object.entries(options).map(([k, v]) => `<w:Option Name="${k}">${v}</w:Option>`).join('')}</w:OptionSet>` : '')
    + `</s:Header><s:Body>${body}</s:Body></s:Envelope>`;
}
const tag = (xml, name) => new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:\\w+:)?${name}>`).exec(xml)?.[1];
const streams = (xml, name) => Buffer.concat([...xml.matchAll(new RegExp(`<(?:\\w+:)?Stream[^>]*Name="${name}"[^>]*>([^<]*)</(?:\\w+:)?Stream>`, 'g'))].map((m) => Buffer.from(m[1], 'base64')));

// What a failed script means in the contract's words: scripts throw "LVM:<CODE>:<text>" for the cases they know.
export function scriptFailure(text) {
  const known = /LVM:([A-Z_]+):([^\r\n]*)/.exec(text);
  if (known) return new Failure(known[1], known[2].trim());
  const line = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? 'the script failed';
  if (/access is denied|not have the required permission|unauthorizedaccess/i.test(text)) return new Failure('PERMISSION_DENIED', line);
  if (/not enough (memory|disk space)|insufficient|there is not enough space/i.test(text)) return new Failure('INSUFFICIENT_RESOURCES', line);
  if (/unable to find a virtual machine|cannot find a virtual machine|was not found/i.test(text)) return new Failure('VM_NOT_FOUND', line);
  if (/is not recognized as the name of a cmdlet/i.test(text)) return new Failure('NOT_HYPERV', 'the Hyper-V PowerShell module is not installed on this host');
  return new Failure('HYPERV_ERROR', line.slice(0, 300));
}

// Opens the connection for one adapter request. Returns ps(script): runs the PowerShell script on the host and
// gives back what it wrote as JSON (scripts end with their result; see scripts.mjs).
export async function connect(target, { timeoutMs = 60_000, transport } = {}) {
  if (!target?.host || !target?.username) throw new Failure('INVALID_REQUEST', 'host and username are required');
  if (transport) return transport; // tests hand in a fake host
  const port = Number(target.port) || 5986;
  const { pin, ...trust } = tlsOptions(target.tls);
  const address = await guardedAddress(target.host);
  // One connection for the whole request: NTLM signs in a connection, not a request.
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1, ...trust, servername: isIP(target.host) ? undefined : target.host, lookup: (_h, _o, cb) => cb(null, address, isIP(address)) });
  const url = `https://${target.host}:${port}/wsman`;
  const post = (xml, authorization) => new Promise((resolve, reject) => {
    const req = https.request({ agent, host: target.host, port, method: 'POST', path: '/wsman', timeout: timeoutMs + 15_000,
      headers: { 'content-type': 'application/soap+xml;charset=UTF-8', 'content-length': Buffer.byteLength(xml), ...(authorization && { authorization }) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('socket', (s) => {
      if (!pin) return;
      s.once('secureConnect', () => {
        const der = s.getPeerCertificate(true)?.raw;
        if (!der || createHash('sha256').update(der).digest('hex') !== pin) req.destroy(new Failure('TLS_PIN_MISMATCH', 'the endpoint presents another certificate than the pinned one'));
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => reject(e));
    req.end(xml);
  });
  let signedIn = false, basic = '';
  const send = async (xml) => {
    try {
      let r = await post(xml, basic || undefined);
      if (r.status === 401 && !signedIn) {
        const offered = [].concat(r.headers['www-authenticate'] ?? []).join(', ');
        if (/Negotiate|NTLM/i.test(offered)) {
          const scheme = /Negotiate/i.test(offered) ? 'Negotiate' : 'NTLM';
          const first = await post(xml, `${scheme} ${ntlmNegotiate().toString('base64')}`);
          const challenge = new RegExp(`${scheme}\\s+([A-Za-z0-9+/=]+)`, 'i').exec([].concat(first.headers['www-authenticate'] ?? []).join(', '))?.[1];
          if (first.status !== 401 || !challenge) throw new Failure('NOT_WINRM', 'the server did not continue the sign-in');
          r = await post(xml, `${scheme} ${ntlmAuthenticate(Buffer.from(challenge, 'base64'), target.username, target.password ?? '').toString('base64')}`);
        } else if (/Basic/i.test(offered)) {
          basic = `Basic ${Buffer.from(`${target.username}:${target.password ?? ''}`).toString('base64')}`;
          r = await post(xml, basic);
        } else throw new Failure('NOT_WINRM', 'the server offers no sign-in method the adapter knows (NTLM or Basic over HTTPS)');
        if (r.status === 401) throw new Failure('INVALID_LOGIN', 'user name or password rejected');
        signedIn = true;
      } else if (r.status === 401) throw new Failure('INVALID_LOGIN', 'user name or password rejected');
      if (r.status !== 200 && !/Envelope/.test(r.text)) throw new Failure('NOT_WINRM', `no WinRM service answered at /wsman (HTTP ${r.status})`);
      return r;
    } catch (e) {
      const f = classify(e);
      if (['TLS_UNTRUSTED', 'TLS_HOSTNAME_MISMATCH', 'TLS_PIN_MISMATCH'].includes(f.code) && !f.certificate) f.certificate = await presented(address, port, target.host);
      throw f;
    }
  };
  const fault = (r) => { const text = tag(r.text, 'Text') ?? tag(r.text, 'Message') ?? `HTTP ${r.status}`; return /access is denied/i.test(text) ? new Failure('PERMISSION_DENIED', text) : new Failure('HYPERV_ERROR', `WinRM: ${text}`.slice(0, 300)); };

  const ps = async (script, { seconds = 110 } = {}) => {
    const opened = await send(envelope(url, 'http://schemas.xmlsoap.org/ws/2004/09/transfer/Create', { options: { WINRS_NOPROFILE: 'TRUE', WINRS_CODEPAGE: '65001' },
      body: '<rsp:Shell><rsp:InputStreams>stdin</rsp:InputStreams><rsp:OutputStreams>stdout stderr</rsp:OutputStreams></rsp:Shell>' }));
    const shell = tag(opened.text, 'ShellId');
    if (opened.status !== 200 || !shell) throw fault(opened);
    try {
      // The script arrives on standard input, so its length is not bound by the command line.
      const reader = "[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8;$s=[Console]::In.ReadToEnd();Invoke-Expression $s";
      const started = await send(envelope(url, `${SHELL}/Command`, { shell, options: { WINRS_CONSOLEMODE_STDIN: 'FALSE', WINRS_SKIP_CMD_SHELL: 'TRUE' },
        body: `<rsp:CommandLine><rsp:Command>powershell.exe</rsp:Command>${['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', utf16(reader).toString('base64')].map((a) => `<rsp:Arguments>${a}</rsp:Arguments>`).join('')}</rsp:CommandLine>` }));
      const command = tag(started.text, 'CommandId');
      if (started.status !== 200 || !command) throw fault(started);
      const bytes = Buffer.from(script, 'utf8');
      for (let o = 0; o < bytes.length || o === 0; o += 60_000) {
        const last = o + 60_000 >= bytes.length;
        const sent = await send(envelope(url, `${SHELL}/Send`, { shell, body: `<rsp:Send><rsp:Stream Name="stdin" CommandId="${command}"${last ? ' End="true"' : ''}>${bytes.subarray(o, o + 60_000).toString('base64')}</rsp:Stream></rsp:Send>` }));
        if (sent.status !== 200) throw fault(sent);
        if (last) break;
      }
      let out = Buffer.alloc(0), err = Buffer.alloc(0), code = null;
      const until = Date.now() + seconds * 1000;
      while (code === null) {
        if (Date.now() > until) throw new Failure('TIMEOUT', 'timed out');
        const r = await send(envelope(url, `${SHELL}/Receive`, { shell, timeout: 20, body: `<rsp:Receive><rsp:DesiredStream CommandId="${command}">stdout stderr</rsp:DesiredStream></rsp:Receive>` }));
        if (r.status !== 200) { if (/TimedOut|2150858793/.test(r.text)) continue; throw fault(r); } // nothing new yet: ask again
        out = Buffer.concat([out, streams(r.text, 'stdout')]); err = Buffer.concat([err, streams(r.text, 'stderr')]);
        if (/CommandState\/Done/.test(r.text)) code = Number(tag(r.text, 'ExitCode') ?? 0);
      }
      const text = out.toString('utf8');
      const ok = /^LVMOK (.*)$/m.exec(text);
      if (code !== 0 || !ok) throw scriptFailure(`${text}\n${err.toString('utf8')}`);
      return JSON.parse(ok[1]);
    } finally {
      await send(envelope(url, 'http://schemas.xmlsoap.org/ws/2004/09/transfer/Delete', { shell })).catch(() => undefined);
    }
  };
  ps.close = () => agent.destroy();
  return ps;
}
