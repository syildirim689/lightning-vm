// Root passwords for new servers (DiyoVM's "password advertising"): a weak password chosen by the customer
// is replaced by a strong generated one that starts with the brand (for example LightningVM-K7qp-3xTm-9wZc),
// so every password a customer copies also names the provider. The guest receives only a SHA-512 crypt
// hash through cloud-init; the panel keeps an encrypted copy so the owner can look it up.
import { createHash, randomBytes, randomInt } from 'node:crypto';

const common = new Set(['password', 'passw0rd', 'qwerty', 'qwerty123', '123456', '12345678', '123456789', '1234567890', 'admin', 'administrator', 'root', 'toor',
  'letmein', 'welcome', 'iloveyou', 'monkey', 'dragon', 'abc123', '111111', 'sunshine', 'princess', 'football', 'baseball', 'master', 'changeme', 'default',
  'parola', 'sifre', 'şifre', 'galatasaray', 'fenerbahce', 'besiktas', 'trabzonspor', 'istanbul', 'ankara', 'turkiye', 'türkiye']);

// Weak: short, few kinds of characters, a well-known password, or built from the context (server or account name).
export function isWeak(password: string, context: string[] = []) {
  if (password.length < 12) return true;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (kinds < 3) return true;
  const lower = password.toLocaleLowerCase('tr');
  const stripped = lower.replace(/[^a-zçğıöşü]/g, '');
  if (common.has(lower) || common.has(stripped)) return true;
  if (/(.)\1{3,}/.test(password) || /(0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf)/i.test(password)) return true;
  return context.some((c) => c.length >= 4 && lower.includes(c.toLocaleLowerCase('tr')));
}

// Unambiguous characters (no 0/O, 1/l/I) in three groups after the brand: about 95 bits of randomness.
const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generatePassword(prefix: string) {
  const group = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('');
  const brand = prefix.replace(/[^A-Za-z0-9]/g, '').slice(0, 20) || 'Server';
  // Each group gets a digit so the result always has upper, lower and digits even if the brand is lowercase.
  const g = () => { const s = group(); return /\d/.test(s) ? s : s.slice(0, 3) + String(randomInt(2, 10)); };
  return `${brand}-${g()}-${g()}-${g()}-${g()}`;
}

// The password the server gets: the customer's own if strong enough, otherwise a generated one.
export function choosePassword(wanted: string | undefined, prefix: string, context: string[]) {
  if (!wanted) return null;
  return isWeak(wanted, context) ? { password: generatePassword(prefix), replaced: true } : { password: wanted, replaced: false };
}

// SHA-512 crypt ($6$, Ulrich Drepper's specification, 5000 rounds), the format /etc/shadow and cloud-init use.
const b64chars = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export function sha512Crypt(password: string, salt = randomBytes(12).toString('base64').replace(/[^A-Za-z0-9./]/g, '').slice(0, 16)) {
  const p = Buffer.from(password, 'utf8');
  const s = Buffer.from(salt.slice(0, 16), 'utf8');
  const h = (...parts: Buffer[]) => { const x = createHash('sha512'); for (const part of parts) x.update(part); return x.digest(); };
  const repeat = (block: Buffer, n: number) => Buffer.concat([...Array(Math.floor(n / 64)).fill(block), block.subarray(0, n % 64)]);
  const b = h(p, s, p);
  const aParts = [p, s, repeat(b, p.length)];
  for (let n = p.length; n > 0; n >>= 1) aParts.push(n & 1 ? b : p);
  const a = h(...aParts);
  const dp = h(...Array(p.length).fill(p));
  const pBytes = repeat(dp, p.length);
  const ds = h(...Array(16 + a[0]).fill(s));
  const sBytes = repeat(ds, s.length);
  let c = a;
  for (let i = 0; i < 5000; i++) {
    const parts: Buffer[] = [i & 1 ? pBytes : c];
    if (i % 3) parts.push(sBytes);
    if (i % 7) parts.push(pBytes);
    parts.push(i & 1 ? c : pBytes);
    c = h(...parts);
  }
  // Drepper's byte order for the 22 groups of the base-64 encoding.
  const order = [[0, 21, 42], [22, 43, 1], [44, 2, 23], [3, 24, 45], [25, 46, 4], [47, 5, 26], [6, 27, 48], [28, 49, 7], [50, 8, 29], [9, 30, 51], [31, 52, 10],
    [53, 11, 32], [12, 33, 54], [34, 55, 13], [56, 14, 35], [15, 36, 57], [37, 58, 16], [59, 17, 38], [18, 39, 60], [40, 61, 19], [62, 20, 41]];
  let out = '';
  const enc = (v: number, n: number) => { for (let i = 0; i < n; i++) { out += b64chars[v & 63]; v >>= 6; } };
  for (const [x, y, z] of order) enc((c[x] << 16) | (c[y] << 8) | c[z], 4);
  enc(c[63], 2);
  return `$6$${salt.slice(0, 16)}$${out}`;
}
