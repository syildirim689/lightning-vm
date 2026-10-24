// Uploaded certificates: key match, name, dates, chain warnings. Certificates are made with openssl on the fly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { checkCertificate } = await import('../dist/certificates.js');
const dir = mkdtempSync(join(tmpdir(), 'lvm-cert-'));
const openssl = (...args) => spawnSync('openssl', args, { encoding: 'utf8' });
const skip = openssl('version').status !== 0 && 'needs openssl';
const make = (name, days = 30, file = name) => {
  openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', String(days), '-subj', `/CN=${name}`,
    '-addext', `subjectAltName=DNS:${name}`, '-keyout', join(dir, `${file}.key`), '-out', join(dir, `${file}.crt`));
  return { cert: readFileSync(join(dir, `${file}.crt`), 'utf8'), key: readFileSync(join(dir, `${file}.key`), 'utf8') };
};
const code = (fn) => { try { fn(); return null; } catch (e) { return e.getResponse().fields; } };

test('a matching certificate and key pass with warnings; mismatches and wrong names are refused', { skip }, () => {
  const a = make('panel.example.com', 400);
  const b = make('other.example.com', 400);
  const ok = checkCertificate(a.cert, a.key, 'panel.example.com');
  assert.deepEqual(ok.names, ['panel.example.com']);
  assert.ok(ok.warnings.includes('SELF_SIGNED'));
  assert.ok(ok.daysLeft >= 398);
  assert.deepEqual(code(() => checkCertificate(a.cert, b.key, 'panel.example.com')), { key: 'KEY_MISMATCH' });
  assert.deepEqual(code(() => checkCertificate(a.cert, a.key, 'www.example.com')), { cert: 'CERT_NAME_MISMATCH' });
  assert.deepEqual(code(() => checkCertificate('not a cert', a.key, 'panel.example.com')), { cert: 'INVALID_CERTIFICATE' });
  assert.deepEqual(code(() => checkCertificate(a.cert, '-----BEGIN ENCRYPTED PRIVATE KEY-----\nx\n-----END ENCRYPTED PRIVATE KEY-----', 'panel.example.com')), { key: 'KEY_ENCRYPTED' });
  assert.ok(checkCertificate(make('soon.example.com', 10).cert, readFileSync(join(dir, 'soon.example.com.key'), 'utf8'), 'soon.example.com').warnings.includes('EXPIRES_SOON'));
});
