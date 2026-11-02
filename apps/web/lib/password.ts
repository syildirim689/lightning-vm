// A random 20-character password with lower and upper case, digits and a symbol (no look-alikes such as l/1/O/0).
const sets = ['abcdefghijkmnpqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', '!@#$%*-_+='];
const pick = (s: string, b: number) => s[b % s.length];

export function strongPassword(length = 20) {
  const all = sets.join('');
  const bytes = crypto.getRandomValues(new Uint8Array(length + 4));
  const chars = Array.from(bytes.slice(4), (b, i) => i < sets.length ? pick(sets[i], b) : pick(all, b));
  // The first four (one of each kind) are shuffled into place.
  for (let i = 0; i < sets.length; i++) { const j = bytes[i] % length; [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}
