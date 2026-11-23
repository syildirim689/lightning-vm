import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLatest, keepEdits } from './latest.ts';

test('an answer that was overtaken by a newer request is not the latest; the newest one is', () => {
  const l = createLatest();
  const first = l.begin();
  const second = l.begin();
  assert.equal(first(), false);
  assert.equal(second(), true);
});

test('a slow first answer arriving after the second still does not count', async () => {
  const l = createLatest();
  const shown: string[] = [];
  const ask = async (value: string, ms: number) => { const isLatest = l.begin(); await new Promise((r) => setTimeout(r, ms)); if (isLatest()) shown.push(value); };
  await Promise.all([ask('old', 30), ask('new', 5)]);
  assert.deepEqual(shown, ['new']);
});

test('drop: nothing started before counts (the step was left)', () => {
  const l = createLatest();
  const a = l.begin();
  l.drop();
  assert.equal(a(), false);
  assert.equal(l.begin()(), true);
});

test('keepEdits: the saved answer replaces the form only when nothing was typed while saving', () => {
  const sent = { name: 'a' };
  const answer = { name: 'a', updatedAt: 1 };
  assert.equal(keepEdits<object>(sent, answer)(sent), answer);
  const typed = { name: 'ab' };
  assert.equal(keepEdits<object>(sent, answer)(typed), typed);
});
