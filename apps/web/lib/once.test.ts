import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOnce, sameKey } from './once.ts';

const later = <T,>(v: T, ms = 10) => new Promise<T>((r) => setTimeout(() => r(v), ms));

test('a second press while the first runs sends nothing and gets the first answer', async () => {
  const once = createOnce();
  let sent = 0;
  const press = () => once.run('pay', () => { sent++; return later('paid'); });
  const [a, b] = await Promise.all([press(), press()]);
  assert.equal(sent, 1);
  assert.equal(a, 'paid');
  assert.equal(b, 'paid');
});

test('after the answer, the same press runs again (a deliberate retry)', async () => {
  const once = createOnce();
  let sent = 0;
  await once.run('x', () => { sent++; return later(1); });
  assert.equal(once.busy('x'), false);
  await once.run('x', () => { sent++; return later(2); });
  assert.equal(sent, 2);
});

test('different keys (the same button on two rows) both run', async () => {
  const once = createOnce();
  let sent = 0;
  await Promise.all([once.run('a', () => { sent++; return later(1); }), once.run('b', () => { sent++; return later(2); })]);
  assert.equal(sent, 2);
});

test('a failure frees the key and reaches both presses', async () => {
  const once = createOnce();
  const fail = () => once.run('f', () => later(0).then(() => { throw new Error('no'); }));
  const results = await Promise.allSettled([fail(), fail()]);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
  assert.equal(once.busy('f'), false);
});

test('sameKey: equal variables give equal keys; undefined and null are the same', () => {
  assert.equal(sameKey({ a: 1, b: [2] }), sameKey({ a: 1, b: [2] }));
  assert.notEqual(sameKey({ a: 1 }), sameKey({ a: 2 }));
  assert.equal(sameKey(undefined), sameKey(null));
});
