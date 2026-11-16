// The real client (TLS trust, session, JSON-RPC, upload) against a local HTTPS server with a self-signed
// certificate. Needs the openssl command to make that certificate; without it the tests are skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.XCPNG_ALLOW_NETWORKS = '127.0.0.0/8'; // read when xapi.mjs loads
const { connect } = await import('../xapi.mjs');

let key, cert;
try {
  const dir = mkdtempSync(join(tmpdir(), 'lvm-xapi-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=xcp.test', '-addext', 'subjectAltName=DNS:xcp.test,IP:127.0.0.1',
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
      const body = Buffer.concat(chunks);
      if (req.method === 'PUT') { seen.push({ put: req.url, bytes: body.length }); res.writeHead(200); return res.end(); }
      const m = JSON.parse(body.toString());
      seen.push({ method: m.method, params: m.params });
      const answer = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...o })); };
      if (m.method === 'session.login_with_password') return m.params[1] === 'right' ? answer({ result: 'OpaqueRef:session-1' }) : answer({ error: { code: 1, message: 'SESSION_AUTHENTICATION_FAILED', data: [m.params[0], 'wrong'] } });
      if (m.params[0] !== 'OpaqueRef:session-1') return answer({ error: { code: 1, message: 'SESSION_INVALID', data: [] } });
      if (m.method === 'VM.get_by_uuid') return answer({ error: { code: 1, message: 'UUID_INVALID', data: ['VM', m.params[1]] } });
      answer({ result: { echoed: m.method, args: m.params.slice(1) } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

test('a session is opened, put in front of every call, used for an upload and closed', { skip }, async () => {
  const seen = []; const { server, port } = await fake(seen);
  try {
    const call = await connect({ host: '127.0.0.1', port, username: 'root', password: 'right', tls: { mode: 'pinned', sha256: pin } });
    assert.deepEqual(seen[0], { method: 'session.login_with_password', params: ['root', 'right', '2.0', 'lightning-vm'] });
    assert.deepEqual(await call('VM.get_record', 'OpaqueRef:vm-1'), { echoed: 'VM.get_record', args: ['OpaqueRef:vm-1'] });
    await assert.rejects(call('VM.get_by_uuid', 'nope'), { code: 'VM_NOT_FOUND' });
    await call.put('/import_raw_vdi', { vdi: 'OpaqueRef:vdi-1', format: 'raw' }, Buffer.alloc(4096, 7));
    assert.deepEqual(seen.at(-1), { put: '/import_raw_vdi?session_id=OpaqueRef%3Asession-1&vdi=OpaqueRef%3Avdi-1&format=raw', bytes: 4096 });
    await call.close();
    assert.equal(seen.at(-1).method, 'session.logout');
  } finally { server.close(); }
});

test('a wrong password, an unknown certificate and a blocked address are refused with their codes', { skip }, async () => {
  const seen = []; const { server, port } = await fake(seen);
  try {
    const target = { host: '127.0.0.1', port, username: 'root', password: 'right' };
    await assert.rejects(connect({ ...target, password: 'wrong', tls: { mode: 'ca', caPem: cert } }), { code: 'INVALID_LOGIN' });
    const before = seen.length;
    const untrusted = await connect({ ...target, tls: { mode: 'system' } }).catch((e) => e);
    assert.equal(untrusted.code, 'TLS_UNTRUSTED'); assert.equal(untrusted.certificate.sha256, pin);
    await assert.rejects(connect({ ...target, tls: { mode: 'pinned', sha256: 'b'.repeat(64) } }), { code: 'TLS_PIN_MISMATCH' });
    assert.equal(seen.length, before, 'no password reaches an endpoint that is not trusted');
    await assert.rejects(connect({ ...target, host: '169.254.169.254', tls: { mode: 'system' } }), { code: 'ENDPOINT_BLOCKED' });
  } finally { server.close(); }
});
