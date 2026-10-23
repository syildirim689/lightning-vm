import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { apiError } from './errors';

// The master key lives in a file outside the database (secrets/master.key, mounted read-only),
// so a database dump alone never reveals VMware credentials. Losing the file means re-entering them.
let key: Buffer | undefined;
function masterKey() {
  if (key) return key;
  try {
    const value = Buffer.from(readFileSync(process.env.MASTER_KEY_FILE ?? '/run/secrets/master_key', 'utf8').trim(), 'base64');
    if (value.length !== 32) throw new Error('master key must be 32 bytes');
    return (key = value);
  } catch {
    throw apiError(503, 'SECRET_KEY_UNAVAILABLE', 'Master key file is missing or invalid');
  }
}

// AES-256-GCM. `context` (for example the connection id) is bound as associated data, so a
// ciphertext copied onto another row does not decrypt.
export function encryptSecret(plain: string, context: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64')}`;
}

export function decryptSecret(blob: string, context: string) {
  const raw = Buffer.from(blob.replace(/^v1:/, ''), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
}
