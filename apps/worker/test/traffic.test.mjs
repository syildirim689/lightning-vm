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

// Over the allowance on three servers: a platform without shaping, an adapter error, and one that can be slowed.
test('one server that cannot be slowed does not stop the others, the lifting or the warnings', async () => {
  const { connection, fail, fakeAdapter, fakeDb } = await import('./harness.mjs');
  const { countTraffic } = await import('../traffic.mjs');
  const gb = 1024 ** 3, row = (id) => ({ id, name: id, owner_id: 'o', traffic_gb: 1, traffic_warned: null, traffic_throttled: false, month: '2026-11', used: 2 * gb });
  const db = fakeDb({ routes: [
    [/^SELECT s\.id, s\.name, s\.owner_id/, () => [row('prox'), row('broken'), row('fine')]],
    [/^SELECT s\.vm_moref, c\.\*/, ([id]) => [{ ...connection({ kind: id === 'prox' ? 'proxmox' : 'vcenter' }), vm_moref: `vm-${id}` }]],
    [/^SELECT s\.id, s\.state FROM servers s WHERE s\.traffic_throttled/, () => [{ id: 'stuck', state: 'ready' }, { id: 'lifted', state: 'ready' }]]] });
  const calls = fakeAdapter((_path, body) => (body.platform === 'proxmox' ? fail('PLATFORM_NOT_SUPPORTED') : ['vm-broken', 'vm-stuck'].includes(body.vm) ? fail('VMWARE_ERROR') : {}));
  const sent = [], logged = [];
  await countTraffic(db, [], async (event, _to, d) => { if (event === 'server.traffic') sent.push([d.serverId, d.throttled]); }, (_level, event, f) => logged.push([event, f.serverId]));
  assert.equal(calls.find((c) => c.body.vm === 'vm-prox').base, 'http://proxmox:8080');
  assert.deepEqual(db.ran(/SET traffic_throttled = true/).map((q) => q.params), [['fine']], 'marked only where the limit is on');
  assert.deepEqual(db.ran(/SET traffic_throttled = false/).map((q) => q.params), [['lifted']], 'a failed lift keeps its mark for the next run');
  assert.deepEqual(sent, [['prox', ''], ['broken', ''], ['fine', '10']], 'everyone is warned; only a real limit is announced');
  assert.deepEqual(logged, [['traffic_throttle_failed', 'broken'], ['traffic_unthrottle_failed', 'stuck']]);
});
