// The oVirt Engine REST client of the adapter (oVirt, Red Hat Virtualization, Oracle Linux Virtualization
// Manager): JSON over HTTPS with the account sent on every call, TLS trust exactly as the connection says (system
// CAs, a given CA, or a pinned leaf certificate), and failures turned into the adapter contract's codes
// (docs/adapter-contract.md). No dependencies.
import { createHash, X509Certificate } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import tls from 'node:tls';

export class Failure extends Error {
  constructor(code, message, extra) { super(message ?? code); this.code = code; Object.assign(this, extra); }
}

// Addresses the adapter never talks to: loopback, link-local, unspecified and multicast, every subnet the container
// itself has an interface on (PostgreSQL, Redis and the API live there) and OVIRT_DENY_NETWORKS, unless
// OVIRT_ALLOW_NETWORKS (comma-separated CIDRs) says otherwise. The same rule as the VMware adapter's netguard.go.
const csv = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const subnets = (cidrs) => {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [net, bits] = String(cidr).split('/');
    if (isIP(net)) list.addSubnet(net, Number(bits ?? (isIP(net) === 4 ? 32 : 128)), isIP(net) === 4 ? 'ipv4' : 'ipv6');
  }
  return list;
};
// permitted(address, family) for the given environment and interfaces (os.networkInterfaces(); tests hand in their own).
export function addressGuard(env = process.env, interfaces = networkInterfaces()) {
  const own = Object.values(interfaces ?? {}).flat().filter((i) => i && !i.internal && i.cidr).map((i) => i.cidr);
  const blocked = subnets(['127.0.0.0/8', '169.254.0.0/16', '0.0.0.0/8', '224.0.0.0/4', '::1/128', 'fe80::/10', 'ff00::/8', '::/128', ...own, ...csv(env.OVIRT_DENY_NETWORKS)]);
  const allowed = subnets(csv(env.OVIRT_ALLOW_NETWORKS));
  return (address, family) => allowed.check(address, family) || !blocked.check(address, family);
}
const permitted = addressGuard();
export async function guardedAddress(host) {
  const list = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }).catch(() => { throw new Failure('DNS_FAILED', `cannot resolve ${host}`); });
  for (const a of list) {
    const family = a.family === 6 ? 'ipv6' : 'ipv4';
    if (!permitted(a.address, family)) throw new Failure('ENDPOINT_BLOCKED', 'endpoint address is not permitted');
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
  return new Failure('NOT_OVIRT', `no oVirt Engine API answered at /ovirt-engine/api: ${err?.message ?? err}`);
}

// What a failed call means in the contract's words. The engine answers with a fault: a reason and a detail.
export function engineFailure(status, text) {
  if (status === 401) return new Failure('INVALID_LOGIN', 'user name or password rejected');
  if (status === 403) return new Failure('PERMISSION_DENIED', `the account lacks a required permission: ${text}`);
  if (status === 404) return new Failure('VM_NOT_FOUND', text || 'not found');
  if (/already in use|already exists/i.test(text)) return new Failure('DUPLICATE_NAME', text);
  if (/low disk space|not enough|insufficient|no available host/i.test(text)) return new Failure('INSUFFICIENT_RESOURCES', text);
  // Still busy with the step before (a disk being grown, a snapshot being made, a removal under way): that passes,
  // so it is a code the worker tries again, not the refusal for good that INVALID_STATE is.
  if (/\block(ed)?\b|currently in progress|try again|performing an operation on a snapshot|is currently being created/i.test(text)) return new Failure('ENGINE_BUSY', text);
  if (status === 409 || /is not down|is not up|illegal status|cannot .* while|in status/i.test(text)) return new Failure('INVALID_STATE', text);
  return new Failure('OVIRT_ERROR', text || `HTTP ${status}`, { status });
}

// Opens the connection for one adapter request. Returns api(method, path, body): the parsed JSON answer.
// Paths are below /ovirt-engine/api; the first call proves the address is an engine and the login works.
export async function connect(target, { timeoutMs = 50_000, transport } = {}) {
  if (!target?.host || !target?.username) throw new Failure('INVALID_REQUEST', 'host and username are required');
  if (transport) return transport; // tests hand in a fake engine
  const port = Number(target.port) || 443;
  const { pin, ...trust } = tlsOptions(target.tls);
  const address = await guardedAddress(target.host);
  // No TLS session cache: a resumed session comes without the peer's certificate, so a second socket (calls made
  // side by side) could not be checked against the pin, and was refused as a mismatch.
  const agent = new https.Agent({ keepAlive: true, maxSockets: 4, maxCachedSessions: 0, ...trust, servername: isIP(target.host) ? undefined : target.host, lookup: (_h, _o, cb) => cb(null, address, isIP(address)) });
  const auth = `Basic ${Buffer.from(`${target.username}:${target.password ?? ''}`).toString('base64')}`;
  // One login for the whole adapter request. A plain Basic call makes the engine log in and out again every time; with
  // "Prefer: persistent-auth" it keeps the session and names it in a cookie, which goes with the calls after it. The
  // Authorization header stays on each of them (the engine reads it only when the session is not valid any more), so
  // an engine or proxy that hands out no cookie is served as before. close() ends the session the documented way:
  // one call without the Prefer header.
  let cookie = '', persistent = true;
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request({ agent, host: target.host, port, method, path: `/ovirt-engine/api${path}`, timeout: timeoutMs,
      headers: { authorization: auth, accept: 'application/json', version: '4', ...(persistent && { prefer: 'persistent-auth' }), ...(cookie && { cookie }), ...(payload !== undefined && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const session = [res.headers['set-cookie'] ?? []].flat().map((c) => c.split(';')[0]).find((c) => c.startsWith('JSESSIONID='));
        if (session && persistent) cookie = session;
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = text ? JSON.parse(text) : {}; } catch { /* an error page */ }
        if (res.statusCode >= 200 && res.statusCode < 300 && json) return resolve(json);
        if (res.statusCode >= 200 && res.statusCode < 300) return reject(new Failure('NOT_OVIRT', 'no oVirt Engine API answered at /ovirt-engine/api'));
        reject(engineFailure(res.statusCode, [json?.reason, json?.detail].filter(Boolean).join(': ') || res.statusMessage));
      });
    });
    req.on('socket', (s) => {
      // A kept-alive socket was checked when it was opened.
      if (!pin || !s.connecting) return;
      s.once('secureConnect', () => {
        const der = s.getPeerCertificate(true)?.raw;
        if (!der || createHash('sha256').update(der).digest('hex') !== pin) req.destroy(new Failure('TLS_PIN_MISMATCH', 'the endpoint presents another certificate than the pinned one'));
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => reject(e));
    req.end(payload);
  });
  const api = async (method, path, body) => {
    try { return await call(method, path, body); }
    catch (e) {
      const f = classify(e);
      if (['TLS_UNTRUSTED', 'TLS_HOSTNAME_MISMATCH', 'TLS_PIN_MISMATCH'].includes(f.code) && !f.certificate) f.certificate = await presented(address, port, target.host);
      throw f;
    }
  };
  api.close = async () => {
    if (cookie) { persistent = false; await call('GET', '').catch(() => undefined); cookie = ''; }
    agent.destroy();
  };
  try {
    api.root = await api('GET', '');
    if (!cookie) persistent = false; // no session was handed out: do not leave one behind with every call
    if (!api.root?.product_info) throw new Failure('NOT_OVIRT', 'no oVirt Engine API answered at /ovirt-engine/api');
  } catch (e) { agent.destroy(); if (e.code === 'VM_NOT_FOUND') throw new Failure('NOT_OVIRT', 'no oVirt Engine API answered at /ovirt-engine/api'); throw e; }
  return api;
}
