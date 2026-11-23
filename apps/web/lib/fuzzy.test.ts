import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchScore } from './fuzzy.ts';

test('a query inside the text matches best, as before; nothing typed matches nothing', () => {
  assert.equal(matchScore('web-3', 'web-3 10.0.0.5 · ali@example.test'), 3);
  assert.equal(matchScore('10.0.0.5', 'web-3 10.0.0.5'), 3);
  assert.equal(matchScore('#1042', '#1042 Disk dolu'), 3);
  assert.equal(matchScore('  ', 'anything'), 0);
});

test('words in any order', () => {
  assert.equal(matchScore('açık fatura', 'Faturalar · açık'), 2);
});

test('one slip in a word: missing, extra, wrong or swapped letters; also the start of a longer word', () => {
  assert.equal(matchScore('sevrer', 'Servers'), 1); // swapped
  assert.equal(matchScore('srver', 'Servers'), 1); // missing
  assert.equal(matchScore('serrver', 'Server list'), 1); // extra
  assert.equal(matchScore('snapshat', 'Snapshots'), 1); // wrong, as the start of a longer word
  assert.equal(matchScore('faturlar', 'Faturalar'), 1);
});

test('long words allow two slips; short words and words with digits must be exact', () => {
  assert.equal(matchScore('firewlls', 'Firewalls'), 1);
  assert.equal(matchScore('fierwlls', 'Firewalls'), 1);
  assert.equal(matchScore('wbe', 'web-3'), 0, 'three letters: exact only');
  assert.equal(matchScore('10.0.0.6', 'web-3 10.0.0.5'), 0, 'an address is never "close"');
  assert.equal(matchScore('web-4', 'web-3'), 0);
  assert.equal(matchScore('xyzzyx', 'Servers'), 0);
});

test('Turkish İ, I, ı and i, capitals and accents are not slips', () => {
  assert.equal(matchScore('IĞDIR', 'ığdır-1'), 3);
  assert.equal(matchScore('istanbul', 'İstanbul DC'), 3);
  assert.equal(matchScore('yedekler', 'Yedekler'), 3);
  assert.equal(matchScore('ayarlr', 'Ayarlar'), 1);
});

test('every word has to match', () => {
  assert.equal(matchScore('web zzzz', 'web-3'), 0);
});
