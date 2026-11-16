// The XAPI client of the adapter (XCP-ng, XenServer / Citrix Hypervisor): JSON-RPC over HTTPS with one session per
// request, TLS trust exactly as the connection says (system CAs, a given CA, or a pinned leaf certificate), and
// failures turned into the adapter contract's codes (docs/adapter-contract.md). No dependencies.
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
// itself has an interface on (PostgreSQL, Redis and the API live there) and XCPNG_DENY_NETWORKS, unless
// XCPNG_ALLOW_NETWORKS (comma-separated CIDRs) says otherwise. The same rule as the VMware adapter's netguard.go.
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
  const blocked = subnets(['127.0.0.0/8', '169.254.0.0/16', '0.0.0.0/8', '224.0.0.0/4', '::1/128', 'fe80::/10', 'ff00::/8', '::/128', ...own, ...csv(env.XCPNG_DENY_NETWORKS)]);
  const allowed = subnets(csv(env.XCPNG_ALLOW_NETWORKS));
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
  return new Failure('NOT_XAPI', `no XAPI answered at /jsonrpc: ${err?.message ?? err}`);
}

// What an XAPI error means in the contract's words. XAPI errors are a code and its arguments.
export function xapiFailure(code, data = []) {
  const text = [code, ...data].join(' ');
  if (code === 'SESSION_AUTHENTICATION_FAILED') return new Failure('INVALID_LOGIN', 'user name or password rejected');
  if (code === 'HOST_IS_SLAVE') return new Failure('HOST_IS_SLAVE', `connect to the pool master instead: ${data[0] ?? ''}`, { master: data[0] });
  if (code === 'RBAC_PERMISSION_DENIED') return new Failure('PERMISSION_DENIED', `the account lacks a required role: ${data[0] ?? ''}`);
  if (code === 'HANDLE_INVALID' || code === 'UUID_INVALID') return new Failure('VM_NOT_FOUND', text);
  if (code === 'VM_BAD_POWER_STATE' || code === 'OTHER_OPERATION_IN_PROGRESS' || code === 'OPERATION_NOT_ALLOWED') return new Failure('INVALID_STATE', text);
  if (code === 'SR_FULL' || code === 'HOST_NOT_ENOUGH_FREE_MEMORY' || code === 'NO_HOSTS_AVAILABLE') return new Failure('INSUFFICIENT_RESOURCES', text);
  if (code === 'VM_LACKS_FEATURE' || code === 'VM_LACKS_FEATURE_SHUTDOWN' || code === 'VM_MISSING_PV_DRIVERS') return new Failure('TOOLS_NOT_RUNNING', text);
  return new Failure('XAPI_ERROR', text, { xapi: code });
}

// Opens a session for one adapter request. Returns call(method, ...args): the session is put in front of the
// arguments. call.put(path, query, body) uploads raw bytes (a disk image) with the same session.
//
// An upload for a disk on another pool member's own storage is answered with a 302 to that host (import_raw_vdi.ml:
// https://<the host's address><path>?<the same query>); it is followed once, through the same address guard. Trust
// for that host: with system CAs or a given CA its certificate is verified as usual (for the address XAPI names).
// A pinned connection pins the master's certificate, and every host has its own: the member is accepted when its
// certificate is one the pinned master lists for the pool (class Certificate, XenServer / XCP-ng 8.2 and later).
// On an older pool a pinned connection cannot upload to a member's local storage, and TLS_PIN_MISMATCH says so.
export async function connect(target, { timeoutMs = 50_000, transport } = {}) {
  if (!target?.host || !target?.username) throw new Failure('INVALID_REQUEST', 'host and username are required');
  if (transport) return transport; // tests hand in a fake XAPI
  const port = Number(target.port) || 443;
  const { pin, ...trust } = tlsOptions(target.tls);
  const address = await guardedAddress(target.host);
  // No TLS session cache: a resumed session comes without the peer's certificate, so a second socket (calls made
  // side by side) could not be checked against the pin, and was refused as a mismatch.
  const agent = new https.Agent({ keepAlive: true, maxSockets: 4, maxCachedSessions: 0, ...trust, servername: isIP(target.host) ? undefined : target.host, lookup: (_h, _o, cb) => cb(null, address, isIP(address)) });
  const master = { agent, host: target.host, port, pins: pin ? [pin] : null };
  const request = (method, path, headers, body, via = master) => new Promise((resolve, reject) => {
    const req = https.request({ agent: via.agent, host: via.host, port: via.port, method, path, timeout: timeoutMs, headers: { ...headers, ...(body !== undefined && { 'content-length': Buffer.byteLength(body) }) } }, (res) => {
      // A redirect comes before the body was read: the rest of the upload is not pushed at a host that will not take it.
      if (res.statusCode >= 300 && res.statusCode < 400) { resolve({ status: res.statusCode, location: res.headers.location, text: '' }); req.destroy(); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('socket', (s) => {
      // A kept-alive socket was checked when it was opened.
      if (!via.pins || !s.connecting) return;
      s.once('secureConnect', () => {
        const der = s.getPeerCertificate(true)?.raw;
        if (!der || !via.pins.includes(createHash('sha256').update(der).digest('hex'))) req.destroy(new Failure('TLS_PIN_MISMATCH', 'the endpoint presents another certificate than the pinned one'));
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => reject(e));
    req.end(body);
  });
  const guarded = async (work) => {
    try { return await work(); }
    catch (e) {
      const f = classify(e);
      if (['TLS_UNTRUSTED', 'TLS_HOSTNAME_MISMATCH', 'TLS_PIN_MISMATCH'].includes(f.code) && !f.certificate) f.certificate = await presented(address, port, target.host);
      throw f;
    }
  };
  let id = 0;
  const rpc = (method, params) => guarded(async () => {
    const r = await request('POST', '/jsonrpc', { 'content-type': 'application/json', accept: 'application/json' }, JSON.stringify({ jsonrpc: '2.0', method, params, id: ++id }));
    let json = null; try { json = JSON.parse(r.text); } catch { /* not XAPI */ }
    if (!json || (json.result === undefined && !json.error)) throw new Failure('NOT_XAPI', `no XAPI answered at /jsonrpc (HTTP ${r.status})`);
    if (json.error) throw xapiFailure(String(json.error.message ?? 'XAPI_ERROR'), Array.isArray(json.error.data) ? json.error.data.map(String) : []);
    return json.result;
  });
  let session;
  try { session = await rpc('session.login_with_password', [target.username, target.password ?? '', '2.0', 'lightning-vm']); }
  catch (e) { agent.destroy(); throw e; }
  const call = (method, ...args) => rpc(method, [session, ...args]);
  // The SHA-256 fingerprints of the pool's host certificates ("AA:BB:..."; fingerprint_sha256 since XAPI 24.20, before
  // that fingerprint, which holds the same value). Empty where the class does not exist.
  const memberPins = async () => Object.values(await call('Certificate.get_all_records').catch(() => ({}))).filter((c) => c.type === undefined || c.type === 'host')
    .map((c) => /[0-9a-f]{64}$/i.exec(String(c.fingerprint_sha256 || c.fingerprint || '').replace(/:/g, ''))?.[0].toLowerCase()).filter(Boolean);
  const toMember = async (location, headers, body) => {
    let to; try { to = new URL(location); } catch { /* below */ }
    if (to?.protocol !== 'https:') throw new Failure('XAPI_ERROR', 'the upload was redirected to something that is not an https address');
    const host = to.hostname.replace(/^\[|\]$/g, ''), member = await guardedAddress(host);
    const via = { host, port: Number(to.port) || 443, pins: pin ? [pin, ...await memberPins()] : null,
      agent: new https.Agent({ maxCachedSessions: 0, ...trust, servername: isIP(host) ? undefined : host, lookup: (_h, _o, cb) => cb(null, member, isIP(member)) }) };
    try { return await request('PUT', `${to.pathname}${to.search}`, headers, body, via); }
    catch (e) {
      // The certificate shown with the failure is the member's, not the master's.
      const f = classify(e);
      if (['TLS_UNTRUSTED', 'TLS_HOSTNAME_MISMATCH', 'TLS_PIN_MISMATCH'].includes(f.code)) throw new Failure(f.code, `pool member ${host} (it holds the storage): ${f.message}`, { certificate: await presented(member, via.port, host) });
      throw f;
    } finally { via.agent.destroy(); }
  };
  call.put = (path, query, body) => guarded(async () => {
    const headers = { 'content-type': 'application/octet-stream' };
    let r = await request('PUT', `${path}?${new URLSearchParams({ session_id: session, ...query })}`, headers, body);
    if (r.status >= 300 && r.status < 400 && r.location) r = await toMember(r.location, headers, body);
    if (r.status < 200 || r.status >= 300) throw new Failure('XAPI_ERROR', `upload failed (HTTP ${r.status})`);
  });
  call.close = async () => { await rpc('session.logout', [session]).catch(() => undefined); agent.destroy(); };
  return call;
}
