// The Incus (and LXD) API client of the adapter: HTTPS with a TLS client certificate, TLS trust exactly as the
// connection says (system CAs, a given CA, or a pinned leaf certificate), and failures turned into the adapter
// contract's codes (docs/adapter-contract.md). No dependencies.
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
// itself has an interface on (PostgreSQL, Redis and the API live there) and INCUS_DENY_NETWORKS, unless
// INCUS_ALLOW_NETWORKS (comma-separated CIDRs) says otherwise. The same rule as the VMware adapter's netguard.go.
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
  const blocked = subnets(['127.0.0.0/8', '169.254.0.0/16', '0.0.0.0/8', '224.0.0.0/4', '::1/128', 'fe80::/10', 'ff00::/8', '::/128', ...own, ...csv(env.INCUS_DENY_NETWORKS)]);
  const allowed = subnets(csv(env.INCUS_ALLOW_NETWORKS));
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
  return new Failure('NOT_INCUS', `no Incus API answered at /1.0: ${err?.message ?? err}`);
}

// The client certificate and its key out of what was pasted into the password field. Pasted into a one-line field
// the line breaks are gone (or have become spaces): both blocks are wrapped again. null: not both there.
export function identity(text) {
  const block = (label) => {
    const m = new RegExp(`-----BEGIN (${label})-----([\\s\\S]*?)-----END \\1-----`).exec(String(text ?? ''));
    const body = m?.[2].replace(/\s+/g, '');
    if (!body || !/^[A-Za-z0-9+/=]+$/.test(body)) return null;
    return `-----BEGIN ${m[1]}-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END ${m[1]}-----\n`;
  };
  const cert = block('CERTIFICATE'), key = block('[A-Z ]*PRIVATE KEY');
  return cert && key ? { cert, key } : null;
}

// What a failed API call means in the contract's words. 404 stays "NOT_FOUND": the caller knows what it asked for.
export function apiFailure(status, text) {
  if (status === 401 || status === 403) return new Failure('PERMISSION_DENIED', `the certificate may not do this: ${text || 'not authorized'}`);
  if (status === 404) return new Failure('NOT_FOUND', text || 'not found', { status });
  return new Failure('INCUS_ERROR', text || `HTTP ${status}`, { status });
}
// Why a background operation failed.
export function operationFailure(text) {
  const t = String(text ?? '');
  if (/no space left|not enough|insufficient|quota|exceed/i.test(t)) return new Failure('INSUFFICIENT_RESOURCES', t);
  if (/already exists/i.test(t)) return new Failure('DUPLICATE_NAME', t);
  return new Failure('TASK_FAILED', t || 'the operation failed');
}
// Everything below these paths lives in a project.
const scoped = /^\/1\.0\/(instances|images|networks|storage-pools|profiles)(\/|\?|$)/;

// Opens a session for one adapter request. Returns api(method, path, body): the `metadata` of the answer (for a
// background operation: the operation, whose id api.wait takes). The user name is the project ("default").
export async function connect(target, { timeoutMs = 70_000, transport } = {}) {
  if (!target?.host) throw new Failure('INVALID_REQUEST', 'host is required');
  const project = String(target.username || 'default').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(project)) throw new Failure('INVALID_REQUEST', 'the user name is the Incus project: letters, digits, . _ and -');
  if (transport) return Object.assign(transport, { project: transport.project ?? project }); // tests hand in a fake API
  const id = identity(target.password);
  if (!id) throw new Failure('INVALID_LOGIN', 'paste the client certificate and its private key (both PEM blocks) into the password field');
  const port = Number(target.port) || 8443;
  const { pin, ...trust } = tlsOptions(target.tls);
  const address = await guardedAddress(target.host);
  let agent;
  // No TLS session cache: a resumed session comes without the peer's certificate, so a second socket (calls made
  // side by side) could not be checked against the pin, and was refused as a mismatch.
  try { agent = new https.Agent({ keepAlive: true, maxSockets: 4, maxCachedSessions: 0, ...trust, cert: id.cert, key: id.key, servername: isIP(target.host) ? undefined : target.host, lookup: (_h, _o, cb) => cb(null, address, isIP(address)) }); }
  catch { throw new Failure('INVALID_LOGIN', 'the client certificate or its key could not be read'); }
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const full = scoped.test(path) ? `${path}${path.includes('?') ? '&' : '?'}project=${encodeURIComponent(project)}` : path;
    const req = https.request({ agent, host: target.host, port, method, path: full, timeout: timeoutMs,
      headers: { accept: 'application/json', ...(data !== undefined && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* an error page */ }
        if (res.statusCode >= 200 && res.statusCode < 300 && json && json.type !== 'error') return resolve(json.metadata ?? null);
        reject(json ? apiFailure(json.error_code || res.statusCode, String(json.error ?? '')) : new Failure('NOT_INCUS', `no Incus API answered at /1.0 (HTTP ${res.statusCode})`));
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
    req.end(data);
  });
  const api = async (method, path, body) => {
    try { return await call(method, path, body); }
    catch (e) {
      // A key that does not belong to the certificate fails here, before the server is asked anything.
      if (/key values mismatch|PEM routines|bad decrypt|no start line|unsupported/i.test(String(e?.message ?? '')) && !(e instanceof Failure)) throw new Failure('INVALID_LOGIN', 'the client certificate and the private key do not belong together');
      const f = classify(e);
      if (['TLS_UNTRUSTED', 'TLS_HOSTNAME_MISMATCH', 'TLS_PIN_MISMATCH'].includes(f.code) && !f.certificate) f.certificate = await presented(address, port, target.host);
      throw f;
    }
  };
  api.close = () => agent.destroy();
  api.project = project;
  try {
    // Proves the address is Incus (or LXD) and that the server knows this certificate.
    const server = await api('GET', '/1.0');
    if (!server?.api_version) throw new Failure('NOT_INCUS', 'no Incus API answered at /1.0');
    if (server.auth !== 'trusted') throw new Failure('INVALID_LOGIN', 'the server does not trust this client certificate (incus config trust add-certificate)');
    api.server = server;
  } catch (e) { agent.destroy(); throw e; }
  return api;
}
