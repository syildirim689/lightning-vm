// Text similarity for the support desk: Turkish folding, common words, what counts as a match and in what order.
import test from 'node:test';
import assert from 'node:assert/strict';

const { fold, tokens, similar, similarityRule } = await import('../dist/similarity-rules.js');
// The search's own folding (db.ts, foldText), written out here: that file opens database connections when loaded.
const foldText = (s) => s.replace(/[İIı]/g, 'i').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

test('words are folded as the search folds them, and common words say nothing', () => {
  assert.equal(fold('ŞİFRE Iğdır çözüldü'), 'sifre igdir cozuldu');
  for (const s of ['İstanbul', 'IŞIK', 'Öğrenci Ünitesi', 'plain']) assert.equal(fold(s), foldText(s), 'the same folding as db.ts');
  assert.deepEqual(tokens('Merhaba, sunucuma SSH ile bağlanamıyorum; lütfen yardım!'), ['sunucuma', 'ssh', 'baglanamiyorum']);
  assert.deepEqual(tokens('Hello, I can not reach my server over SSH. Thanks'), ['reach', 'server', 'over', 'ssh']);
  assert.deepEqual(tokens(''), []);
  assert.deepEqual(tokens(null), []);
  assert.equal(tokens('x'.repeat(10) + ' ' + 'word '.repeat(5000)).length <= similarityRule.maxChars / 5 + 1, true, 'a long text is cut');
});

const docs = [
  { id: 'ssh', text: 'SSH bağlantısı kurulamıyor. Sunucuya ssh ile bağlanmaya çalışınca connection refused hatası alıyorum, port 22 kapalı görünüyor.' },
  { id: 'fatura', text: 'Fatura ödemesi yapıldı ama sunucu hâlâ askıda. Kredi kartı ile ödeme yaptım, fatura ödendi görünüyor.' },
  { id: 'disk', text: 'Disk doldu, sunucu yanıt vermiyor. Disk alanını nasıl büyütebilirim?' },
  { id: 'rdns', text: 'Reverse DNS kaydı nasıl eklenir? PTR kaydı gerekiyor, e-posta sunucusu için.' },
];

test('the closest earlier text comes first, with the words it shares', () => {
  const [first, ...rest] = similar('Sunucuma SSH ile bağlanamıyorum, port 22 kapalı mı? Connection refused diyor', docs);
  assert.equal(first.id, 'ssh');
  assert.ok(first.score > 0.3, `score ${first.score}`);
  for (const w of ['ssh', 'port', 'refused', 'connection']) assert.ok(first.shared.includes(w), `shares ${w}: ${first.shared}`);
  assert.equal(rest.every((r) => r.score <= first.score), true);
  // Capitals and Turkish letters do not matter.
  assert.equal(similar('FATURA ÖDEMESİ YAPILDI AMA SUNUCU ASKIDA', docs)[0].id, 'fatura');
  assert.equal(similar('fatura odemesi yapildi ama sunucu askida', docs)[0].id, 'fatura');
});

test('one shared word, an unrelated text and empty input offer nothing', () => {
  assert.deepEqual(similar('Sunucu çok yavaş açılıyor', docs).map((m) => m.id), [], '"sunucu" alone is in most texts and is one word');
  assert.deepEqual(similar('Hesabımı silmek istiyorum', docs), []);
  assert.deepEqual(similar('', docs), []);
  assert.deepEqual(similar('ssh port', []), []);
  assert.deepEqual(similar('merhaba lütfen teşekkürler', docs), [], 'only common words');
});

test('at most three results, best first; a text of one word matches on that word', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ id: `d${i}`, text: `disk alanı doldu büyütme ${i < 4 ? 'sunucu yanıt vermiyor' : 'yedek geri yükleme'}` }));
  const r = similar('Disk alanı doldu, sunucu yanıt vermiyor', many);
  assert.equal(r.length, similarityRule.top);
  assert.deepEqual(r.map((m) => m.id).sort(), ['d0', 'd1', 'd2', 'd3'].filter((id) => r.some((m) => m.id === id)).sort());
  assert.ok(r[0].score >= r[2].score);
  // A query of a single word needs only that word.
  assert.deepEqual(similar('rdns', [{ id: 'a', text: 'rdns kaydı' }, { id: 'b', text: 'disk' }]).map((m) => m.id), ['a']);
});
