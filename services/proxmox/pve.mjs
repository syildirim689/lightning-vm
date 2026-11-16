// The Proxmox VE API client of the adapter: one login per request (an API token, or a ticket for user and
// password), TLS trust exactly as the connection says (system CAs, a given CA, or a pinned leaf certificate), and
// failures turned into the adapter contract's codes (docs/adapter-contract.md). No dependencies.
import { createHash, X509Certificate } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import tls from 'node:tls';

export class Failure extends Error {
  constructor(code, message, extra) { super(message ?? code); this.code = code; Object.assign(this, extra); }
}

// Addresses the adapter never talks to (it sits on the panel's own network): loopback, link-local, unspecified
// and multicast, unless PROXMOX_ALLOW_NETWORKS (comma-separated CIDRs) says otherwise.
const blocked = new BlockList();
for (const [net, bits, family] of [['127.0.0.0', 8, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['0.0.0.0', 8, 'ipv4'], ['224.0.0.0', 4, 'ipv4'], ['::1', 128, 'ipv6'], ['fe80::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'], ['::', 128, 'ipv6']]) blocked.addSubnet(net, bits, family);
const allowed = new BlockList();
for (const cidr of (process.env.PROXMOX_ALLOW_NETWORKS ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
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
  return new Failure('NOT_PROXMOX', `no Proxmox VE API answered at /api2/json: ${err?.message ?? err}`);
}

// What a failed API call means in the contract's words. Proxmox answers 500/501 with the reason in the status line.
function apiFailure(status, text) {
  if (status === 401) return new Failure('INVALID_LOGIN', 'user name, password or API token rejected');
  if (status === 403) return new Failure('PERMISSION_DENIED', `the account lacks a required privilege: ${text}`);
  if (/does not exist|no such (vm|guest|file)|not found|Configuration file .* does not exist/i.test(text)) return new Failure('VM_NOT_FOUND', text || 'not found');
  return new Failure('PROXMOX_ERROR', text || `HTTP ${status}`, { status });
}

// Opens a session for one adapter request. Returns api(method, path, params): the `data` of the answer.
export async function connect(target, { timeoutMs = 25_000, transport } = {}) {
  if (!target?.host || !target?.username) throw new Failure('INVALID_REQUEST', 'host and username are required');
  if (transport) return transport; // tests hand in a fake API
  const port = Number(target.port) || 8006;
  const { pin, ...trust } = tlsOptions(target.tls);
  const address = await guardedAddress(target.host);
  const agent = new https.Agent({ keepAlive: true, maxSockets: 4, ...trust, servername: isIP(target.host) ? undefined : target.host, lookup: (_h, _o, cb) => cb(null, address, isIP(address)) });
  const headers = {};
  const call = (method, path, params) => new Promise((resolve, reject) => {
    const query = method === 'GET' || method === 'DELETE' ? params : undefined;
    // An array is sent as the same key several times (how Proxmox reads a list such as agent/exec's command).
    const body = query ? undefined : params && new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, String(x)]) : [[k, String(v)]]))).toString();
    const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}` : '';
    const req = https.request({ agent, host: target.host, port, method, path: `/api2/json${path}${qs}`, timeout: timeoutMs,
      headers: { accept: 'application/json', ...headers, ...(body !== undefined && { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) }) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* an error page */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json?.data ?? null);
        const why = [res.statusMessage, json?.errors && Object.entries(json.errors).map(([k, v]) => `${k}: ${v}`).join('; '), json?.message].filter(Boolean).join(' - ');
        reject(apiFailure(res.statusCode, why));
      });
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
    req.end(body);
  });
  const api = async (method, path, params) => {
    try { return await call(method, path, params); }
    catch (e) {
      const f = classify(e);
      if (['TLS_UNTRUSTED', 'TLS_HOSTNAME_MISMATCH', 'TLS_PIN_MISMATCH'].includes(f.code) && !f.certificate) f.certificate = await presented(address, port, target.host);
      throw f;
    }
  };
  api.close = () => agent.destroy();
  try {
    if (target.username.includes('!')) headers.authorization = `PVEAPIToken=${target.username}=${target.password ?? ''}`;
    else {
      const t = await api('POST', '/access/ticket', { username: target.username, password: target.password ?? '' });
      if (!t?.ticket) throw new Failure('INVALID_LOGIN', 'user name or password rejected');
      headers.cookie = `PVEAuthCookie=${encodeURIComponent(t.ticket)}`;
      headers.CSRFPreventionToken = t.CSRFPreventionToken;
    }
    // Proves the address is Proxmox VE and the login works (a token is only checked by a real call).
    api.version = await api('GET', '/version');
    if (!api.version?.version) throw new Failure('NOT_PROXMOX', 'no Proxmox VE API answered at /api2/json');
  } catch (e) { agent.destroy(); throw e; }
  return api;
}
