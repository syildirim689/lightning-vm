// Text similarity for the support desk (no database; unit-tested in test/similarity-rules.test.mjs): which earlier
// texts are about the same thing as a new one. Words are folded the way the panel's search folds them (no capitals,
// plain letters for Turkish ones: "Şifre" = "sifre"), common words are dropped, and texts are compared by the words
// they share, weighted so that a word many texts contain counts for little (TF-IDF, cosine similarity).
// A match is only offered when it shares enough words to say which: every result carries them, as the reason shown.

export const similarityRule = {
  minToken: 3,     // shorter words are dropped
  minShared: 2,    // distinct words a match must share with the text asked about
  minScore: 0.12,  // cosine similarity below which a match is not offered
  top: 3,          // results offered
  maxChars: 4000,  // of each text, this much is read
};

// The folding of db.ts (foldText), kept in step with it: search and suggestions must agree on what a word is.
export const fold = (s: string) => s.replace(/[İIı]/g, 'i').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Words that say nothing about the subject, in Turkish and English, already folded.
const stop = new Set(('ve veya ile icin bir bu su ama fakat gibi daha cok var yok degil mi mu ben biz siz sen onlar bana bize size nasil neden ne zaman kadar sonra once '
  + 'merhaba selam lutfen tesekkurler tesekkur ederim iyi gunler calismalar rica sayin olarak olan oldu oluyor ediyorum istiyorum yardim yardimci olur musunuz misiniz '
  + 'the and for with not are was were have has had you your our can could would please hello thanks thank regards dear this that these those from but about into when what how why '
  + 'help need want get got does did doing been being will just also any some').split(' '));

export function tokens(text: string, rule = similarityRule): string[] {
  return fold(String(text ?? '').slice(0, rule.maxChars)).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= rule.minToken && !stop.has(w));
}

export type Doc = { id: string; text: string };
export type Match = { id: string; score: number; shared: string[] };

export function similar(query: string, docs: Doc[], rule = similarityRule): Match[] {
  const q = tokens(query, rule);
  if (!q.length || !docs.length) return [];
  const bags = docs.map((d) => ({ id: d.id, words: tokens(d.text, rule) }));
  // In how many texts each word appears (the text asked about counts as one).
  const df = new Map<string, number>();
  for (const words of [q, ...bags.map((b) => b.words)]) for (const w of new Set(words)) df.set(w, (df.get(w) ?? 0) + 1);
  const n = bags.length + 1;
  const vector = (words: string[]) => {
    const tf = new Map<string, number>();
    for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
    const v = new Map<string, number>();
    for (const [w, c] of tf) v.set(w, (1 + Math.log(c)) * Math.log(1 + n / (df.get(w) ?? 1)));
    return v;
  };
  const norm = (v: Map<string, number>) => Math.sqrt([...v.values()].reduce((a, x) => a + x * x, 0));
  const qv = vector(q), qn = norm(qv);
  const out: Match[] = [];
  for (const b of bags) {
    if (!b.words.length) continue;
    const dv = vector(b.words);
    const shared = [...qv.keys()].filter((w) => dv.has(w));
    if (shared.length < Math.min(rule.minShared, qv.size)) continue;
    const score = shared.reduce((a, w) => a + qv.get(w)! * dv.get(w)!, 0) / (qn * norm(dv));
    if (score >= rule.minScore) out.push({ id: b.id, score: Math.round(score * 100) / 100,
      shared: shared.sort((x, y) => qv.get(y)! * dv.get(y)! - qv.get(x)! * dv.get(x)!).slice(0, 5) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, rule.top);
}
