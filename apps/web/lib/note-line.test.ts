import test from 'node:test';
import assert from 'node:assert/strict';
import { fold, noteLine } from './note-line.ts';

test('a card shows the note line that matched the search, else the first line', () => {
  const notes = '\nAna web sunucusu\nyedek: her gece 03:00, sorumlu Ayşe\n';
  assert.equal(noteLine(notes, ''), 'Ana web sunucusu');
  assert.equal(noteLine(notes, 'nope'), 'Ana web sunucusu');
  assert.equal(noteLine(notes, 'YEDEK'), 'yedek: her gece 03:00, sorumlu Ayşe');
  assert.equal(noteLine(notes, 'ayşe'), '…gece 03:00, sorumlu Ayşe');
});

test('search folds case the same for English and Turkish words', () => {
  assert.ok(fold('Invoice address').includes(fold('invoice')));
  assert.ok(fold('IĞDIR').includes(fold('ığdır')));
  assert.ok(fold('İstanbul').includes(fold('istanbul')));
  assert.equal(fold('Iİıi').length, 4);
});
