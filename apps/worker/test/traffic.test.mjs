import test from 'node:test';
import assert from 'node:assert/strict';
import { counted, warning } from '../traffic.mjs';

test('each traffic sample is counted once, by its time', () => {
  const s = [{ t: '2026-10-27T10:00:00Z', rx: 1, tx: 2 }, { t: '2026-10-27T10:00:20Z', rx: 10, tx: 0 }, { t: '2026-10-27T10:00:40Z', rx: 0, tx: 5 }];
  assert.deepEqual(counted(s, null), { rx: 11 * 1024 * 20, tx: 7 * 1024 * 20, last: new Date('2026-10-27T10:00:40Z') });
  assert.deepEqual(counted(s, '2026-10-27T10:00:20Z'), { rx: 0, tx: 5 * 1024 * 20, last: new Date('2026-10-27T10:00:40Z') });
  assert.deepEqual(counted(s, '2026-10-27T10:00:40Z'), { rx: 0, tx: 0, last: new Date('2026-10-27T10:00:40Z') });
});

test('an allowance is warned at 80 % and 100 %, once each per month', () => {
  const gb = 1024 ** 3;
  assert.equal(warning(79 * gb, 100, null, '2026-10'), null);
  assert.equal(warning(80 * gb, 100, null, '2026-10'), 80);
  assert.equal(warning(85 * gb, 100, '2026-10:80', '2026-10'), null);
  assert.equal(warning(100 * gb, 100, '2026-10:80', '2026-10'), 100);
  assert.equal(warning(120 * gb, 100, '2026-10:100', '2026-10'), null);
  assert.equal(warning(90 * gb, 100, '2026-09:100', '2026-10'), 80, 'a new month warns again');
  assert.equal(warning(900 * gb, null, null, '2026-10'), null, 'unlimited');
});
