import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Holder, UNDO_CAP_MS, UNDO_MS } from './undo.ts';

const recorder = () => {
  const sent: { id: string; keepalive: boolean }[] = [];
  return { sent, commit: (id: string) => async ({ keepalive }: { keepalive: boolean }) => { sent.push({ id, keepalive }); } };
};

test('an undone removal is never sent', async () => {
  const h = new Holder(); const r = recorder();
  assert.equal(h.hold('k1', r.commit('k1')), true);
  assert.equal(h.undo('k1'), true);
  assert.equal(h.release('k1'), null);
  assert.deepEqual(r.sent, []);
});

test('a removal is sent once, when its message goes, and cannot be undone afterwards', async () => {
  const h = new Holder(); const r = recorder();
  h.hold('k1', r.commit('k1'));
  await h.release('k1');
  assert.equal(h.release('k1'), null, 'a second close sends nothing more');
  assert.equal(h.undo('k1'), false, 'too late to undo');
  assert.deepEqual(r.sent, [{ id: 'k1', keepalive: false }]);
});

test('pressing remove twice on the same item holds it once', () => {
  const h = new Holder(); const r = recorder();
  assert.equal(h.hold('k1', r.commit('k1')), true);
  assert.equal(h.hold('k1', r.commit('k1')), false);
  assert.equal(h.size, 1);
});

test('leaving the page sends everything still waiting, with keepalive, and nothing that was undone', async () => {
  const h = new Holder(); const r = recorder();
  h.hold('a', r.commit('a')); h.hold('b', r.commit('b')); h.hold('c', r.commit('c'));
  h.undo('b');
  await Promise.all(h.releaseAll());
  assert.deepEqual(r.sent, [{ id: 'a', keepalive: true }, { id: 'c', keepalive: true }]);
  assert.equal(h.size, 0);
  assert.deepEqual(h.releaseAll(), []);
});

test('a failed request is the caller’s to report; the item is not held again by itself', async () => {
  const h = new Holder();
  h.hold('x', async () => { throw { code: 'NETWORK' }; });
  await assert.rejects(h.release('x')!, { code: 'NETWORK' });
  assert.equal(h.has('x'), false);
});

test('the undo window is a few seconds, and a message kept open cannot hold a removal for long', () => {
  assert.ok(UNDO_MS >= 5_000 && UNDO_MS <= 10_000);
  assert.ok(UNDO_CAP_MS > UNDO_MS && UNDO_CAP_MS <= 60_000);
});
