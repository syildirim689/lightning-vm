import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'lvm-key-'));
process.env.MASTER_KEY_FILE = join(dir, 'master.key');
writeFileSync(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { encryptSecret, decryptSecret } = await import('../dist/secrets.js');

test('secrets round-trip and never contain the plaintext', () => {
  const blob = encryptSecret('vCenter p@ss', 'conn-1');
  assert.match(blob, /^v1:/);
  assert.doesNotMatch(blob, /p@ss/);
  assert.equal(decryptSecret(blob, 'conn-1'), 'vCenter p@ss');
  assert.notEqual(encryptSecret('vCenter p@ss', 'conn-1'), blob, 'random IV per encryption');
});

test('a ciphertext moved to another row or tampered with does not decrypt', () => {
  const blob = encryptSecret('secret', 'conn-1');
  assert.throws(() => decryptSecret(blob, 'conn-2'));
  const raw = Buffer.from(blob.slice(3), 'base64');
  raw[14] ^= 1;
  assert.throws(() => decryptSecret(`v1:${raw.toString('base64')}`, 'conn-1'));
});
