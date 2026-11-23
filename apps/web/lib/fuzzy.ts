import { fold } from './note-line.ts';

// The command palette's search: how well a typed query matches a line of text (a server's name, address and owner;
// a ticket's number and subject; a page's name). Higher is better, 0 is no match.
//   3  the whole query is in the text ("web-3", "10.0.0.5", "#1042"), as before
//   2  every word of the query is in the text, in any order ("fatura açık" in "Açık faturalar")
//   1  every word is there with at most one slip: a letter missing, added, wrong or two swapped ("sevrer" → server,
//      "faturlar" → faturalar), also as the start of a word ("snaps" → snapshots); two slips in words of 8+ letters.
// Turkish İ/I/ı/i, capitals and accents never count as slips (lib/note-line.ts fold). Words with digits (addresses,
// numbers, ids) must be typed exactly: "10.0.0.6" must not find 10.0.0.5. Words shorter than 4 letters too.
export function matchScore(query: string, text: string): number {
  const q = fold(query.trim());
  if (!q) return 0;
  const t = fold(text);
  if (t.includes(q)) return 3;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.every((w) => t.includes(w))) return 2;
  const parts = t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const close = (w: string) => {
    if (t.includes(w)) return true;
    if (/\d/.test(w) || w.length < 4) return false;
    const limit = w.length >= 8 ? 2 : 1;
    // The whole word, or its start (a word being typed): starts a letter or two shorter or longer count too.
    return parts.some((p) => near(w, p, limit) || Array.from({ length: 2 * limit + 1 }, (_, i) => w.length - limit + i)
      .some((n) => n >= 4 && n < p.length && near(w, p.slice(0, n), limit)));
  };
  return words.every(close) ? 1 : 0;
}

// Damerau-Levenshtein distance (with swapped neighbours) no more than `limit`.
function near(a: string, b: string, limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit) return false;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      best = Math.min(best, d[i][j]);
    }
    if (best > limit) return false;
  }
  return d[a.length][b.length] <= limit;
}
