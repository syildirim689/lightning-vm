// The real client (TLS trust and login) against a local HTTPS server with a self-signed certificate.
// Needs the openssl command to make that certificate; without it the tests are skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PROXMOX_ALLOW_NETWORKS = '127.0.0.0/8'; // read when pve.mjs loads
const { connect } = await import('../pve.mjs');

let key, cert;
try {
  const dir = mkdtempSync(join(tmpdir(), 'lvm-pve-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=pve.test', '-addext', 'subjectAltName=DNS:pve.test,IP:127.0.0.1',
    '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  key = readFileSync(join(dir, 'k.pem'), 'utf8'); cert = readFileSync(join(dir, 'c.pem'), 'utf8');
  rmSync(dir, { recursive: true, force: true });
} catch { /* no openssl */ }
const skip = !cert && 'openssl is not available';
const pin = cert ? createHash('sha256').update(new X509Certificate(cert).raw).digest('hex') : '';

async function fake(seen) {
  const server = https.createServer({ key, cert }, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, cookie: req.headers.cookie, csrf: req.headers.csrfpreventiontoken, body });
      const json = (status, data, message) => { res.writeHead(status, message, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data })); };
      if (req.url === '/api2/json/access/ticket') return new URLSearchParams(body).get('password') === 'right' ? json(200, { ticket: 'PVE:root@pam:ABC==', CSRFPreventionToken: 'csrf-1' }) : json(401, null, 'authentication failure');
      const ok = req.headers.authorization === 'PVEAPIToken=panel@pve!lvm=secret-1' || /PVEAuthCookie=PVE%3Aroot%40pam%3AABC%3D%3D/.test(req.headers.cookie ?? '');
      if (!ok) return json(401, null, 'authentication failure');
      if (req.url === '/api2/json/version') return json(200, { version: '8.2.4', release: '8.2' });
      if (req.url.startsWith('/api2/json/nodes/pve1/qemu/999')) return json(500, null, 'Configuration file \'nodes/pve1/qemu-server/999.conf\' does not exist');
      if (req.url === '/api2/json/forbidden') return json(403, null, 'Permission check failed (/vms/100, VM.Clone)');
      json(200, { echoed: req.url });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

test('a pinned certificate is trusted, a token signs every call and failures become contract codes', { skip }, async () => {
  const seen = []; const { server, port } = await fake(seen);
  try {
    const api = await connect({ host: '127.0.0.1', port, username: 'panel@pve!lvm', password: 'secret-1', tls: { mode: 'pinned', sha256: pin.toUpperCase().match(/../g).join(':') } });
    assert.equal(api.version.version, '8.2.4');
    assert.deepEqual(await api('GET', '/cluster/resources', { type: 'vm' }), { echoed: '/api2/json/cluster/resources?type=vm' });
    await api('POST', '/nodes/pve1/qemu/100/clone', { newid: 105, name: 'lvm-x', skipped: undefined });
    assert.equal(seen.at(-1).body, 'newid=105&name=lvm-x'); assert.equal(seen.at(-1).auth, 'PVEAPIToken=panel@pve!lvm=secret-1');
    await api('POST', '/nodes/pve1/qemu/100/agent/exec', { command: ['sh', '/root/x.sh'] });
    assert.equal(seen.at(-1).body, 'command=sh&command=%2Froot%2Fx.sh', 'a list is the same key repeated');
    await assert.rejects(api('GET', '/nodes/pve1/qemu/999/config'), { code: 'VM_NOT_FOUND' });
    await assert.rejects(api('GET', '/forbidden'), { code: 'PERMISSION_DENIED' });
    api.close();
  } finally { server.close(); }
});

test('calls made side by side over a pinned connection are all accepted (each new socket shows its certificate)', { skip }, async () => {
  const seen = []; const { server, port } = await fake(seen);
  try {
    const api = await connect({ host: '127.0.0.1', port, username: 'panel@pve!lvm', password: 'secret-1', tls: { mode: 'pinned', sha256: pin } });
    assert.equal((await Promise.all([1, 2, 3, 4, 5, 6].map((i) => api('GET', `/cluster/resources`, { i })))).length, 6);
    api.close();
  } finally { server.close(); }
});

test('a user and password log in with a ticket; a wrong password is INVALID_LOGIN', { skip }, async () => {
  const seen = []; const { server, port } = await fake(seen);
  try {
    const target = { host: '127.0.0.1', port, username: 'root@pam', tls: { mode: 'ca', caPem: cert } };
    const api = await connect({ ...target, password: 'right' });
    await api('PUT', '/nodes/pve1/qemu/100/config', { cores: 2 });
    assert.equal(seen.at(-1).csrf, 'csrf-1'); assert.match(seen.at(-1).cookie, /^PVEAuthCookie=/);
    api.close();
    await assert.rejects(connect({ ...target, password: 'wrong' }), { code: 'INVALID_LOGIN' });
  } finally { server.close(); }
});

test('an unknown certificate is refused and shown; another pin does not match; local addresses are blocked', { skip }, async () => {
  const seen = []; const { server, port } = await fake(seen);
  try {
    const target = { host: '127.0.0.1', port, username: 'panel@pve!lvm', password: 'secret-1' };
    const untrusted = await connect({ ...target, tls: { mode: 'system' } }).catch((e) => e);
    assert.equal(untrusted.code, 'TLS_UNTRUSTED'); assert.equal(untrusted.certificate.sha256, pin); assert.match(untrusted.certificate.subject, /pve\.test/);
    assert.deepEqual(untrusted.certificate.ips, ['127.0.0.1']);
    assert.equal(seen.length, 0, 'nothing was sent to an endpoint that is not trusted');
    await assert.rejects(connect({ ...target, tls: { mode: 'pinned', sha256: 'a'.repeat(64) } }), { code: 'TLS_PIN_MISMATCH' });
    assert.equal(seen.length, 0, 'no credentials reach an endpoint with another certificate');
    await assert.rejects(connect({ ...target, tls: { mode: 'pinned', sha256: 'abc' } }), { code: 'INVALID_PIN' });
    await assert.rejects(connect({ ...target, host: '169.254.169.254', tls: { mode: 'system' } }), { code: 'ENDPOINT_BLOCKED' });
    await assert.rejects(connect({ ...target, port: 1, tls: { mode: 'pinned', sha256: pin } }), { code: 'CONNECTION_REFUSED' });
  } finally { server.close(); }
});
