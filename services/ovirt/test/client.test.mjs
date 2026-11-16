// The real client (TLS trust, account, JSON) against a local HTTPS server with a self-signed certificate.
// Needs the openssl command to make that certificate; without it the tests are skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OVIRT_ALLOW_NETWORKS = '127.0.0.0/8'; // read when engine.mjs loads
const { connect } = await import('../engine.mjs');

let key, cert;
try {
  const dir = mkdtempSync(join(tmpdir(), 'lvm-ovirt-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=engine.test', '-addext', 'subjectAltName=DNS:engine.test,IP:127.0.0.1',
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
      seen.push({ method: req.method, url: req.url, version: req.headers.version, accept: req.headers.accept, type: req.headers['content-type'], body: Buffer.concat(chunks).toString() });
      const json = (status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.headers.authorization !== `Basic ${Buffer.from('admin@internal:right').toString('base64')}`) return json(401, {});
      if (req.url === '/ovirt-engine/api') return json(200, { product_info: { name: 'oVirt Engine', version: { full_version: '4.5.6' } } });
      if (req.url === '/ovirt-engine/api/vms/missing') return json(404, { reason: 'Not Found', detail: 'Entity not found: VM' });
      if (req.url === '/ovirt-engine/api/vms/busy/start') return json(409, { reason: 'Operation Failed', detail: '[Cannot run VM. VM is locked.]' });
      json(200, { echoed: req.url });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

test('the account goes with every call as JSON for API version 4; faults become contract codes', { skip }, async () => {
  const seen = []; const { server, port } = await fake(seen);
  try {
    const api = await connect({ host: '127.0.0.1', port, username: 'admin@internal', password: 'right', tls: { mode: 'pinned', sha256: pin } });
    assert.equal(api.root.product_info.name, 'oVirt Engine');
    assert.deepEqual(await api('GET', '/vms?search=name%3Dlvm-x'), { echoed: '/ovirt-engine/api/vms?search=name%3Dlvm-x' });
    await api('PUT', '/vms/1', { memory: 1024 });
    assert.deepEqual([seen.at(-1).version, seen.at(-1).accept, seen.at(-1).type, seen.at(-1).body], ['4', 'application/json', 'application/json', '{"memory":1024}']);
    await assert.rejects(api('GET', '/vms/missing'), { code: 'VM_NOT_FOUND' });
    await assert.rejects(api('POST', '/vms/busy/start', {}), { code: 'INVALID_STATE' });
    api.close();
  } finally { server.close(); }
});

test('a wrong password, an unknown certificate and a blocked address are refused with their codes', { skip }, async () => {
  const seen = []; const { server, port } = await fake(seen);
  try {
    const target = { host: '127.0.0.1', port, username: 'admin@internal', password: 'right' };
    await assert.rejects(connect({ ...target, password: 'wrong', tls: { mode: 'ca', caPem: cert } }), { code: 'INVALID_LOGIN' });
    const before = seen.length;
    const untrusted = await connect({ ...target, tls: { mode: 'system' } }).catch((e) => e);
    assert.equal(untrusted.code, 'TLS_UNTRUSTED'); assert.equal(untrusted.certificate.sha256, pin);
    await assert.rejects(connect({ ...target, tls: { mode: 'pinned', sha256: 'c'.repeat(64) } }), { code: 'TLS_PIN_MISMATCH' });
    assert.equal(seen.length, before, 'no password reaches an endpoint that is not trusted');
    await assert.rejects(connect({ ...target, host: '169.254.169.254', tls: { mode: 'system' } }), { code: 'ENDPOINT_BLOCKED' });
  } finally { server.close(); }
});
