// The step machine across attempts: what a retry does after a failed, vanished or unanswered step, and what a final
// failure puts back. PostgreSQL and the adapter are stand-ins (harness.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { attempt, connection, fail, fakeAdapter, fakeDb, ids } from './harness.mjs';
import { adapterBase, addedDisk, cloudInit, forgetRestoreHold, processOperation, reconcile, warningCodes } from '../operations.mjs';

const vmOf = (powerState, moref = 'vm-1') => ({ vm: { moref, powerState, toolsRunning: powerState === 'poweredOn', ips: ['203.0.113.20'] } });
const resizeParams = { vcpu: 4, memoryMb: 8192, diskGb: 80, powerOn: true, from: { vcpu: 2, memoryMb: 4096, diskGb: 40, priceMonthly: '10.00', packageId: 'pkg-old' } };

test('a resize whose task failed is issued again by the retry, with the server still off; it is not reported done', async () => {
  const db = fakeDb({ op: { kind: 'resize', params: resizeParams } });
  let state = 'poweredOn', resizes = 0;
  const calls = fakeAdapter((path, body) => {
    if (path === '/v1/vm/find') return vmOf(state);
    if (path === '/v1/vm/power') { state = body.action === 'on' ? 'poweredOn' : 'poweredOff'; return { task: '' }; }
    if (path === '/v1/vm/resize') return { task: ++resizes === 1 ? 'task-1' : '' };
    if (path === '/v1/task') return { state: 'error', code: 'TASK_FAILED', error: 'host busy' };
  });
  const first = await attempt(processOperation, db);
  assert.equal(first.code, 'TASK_FAILED');
  assert.equal(db.op.status, 'pending');
  assert.equal(db.op.step, 'resize', 'the step stays at resize');
  assert.equal(db.op.provider_task_id, null, 'the failed task is forgotten');
  assert.equal(state, 'poweredOff', 'not started between attempts');
  assert.equal(db.ran(/^UPDATE servers SET vcpu/).length, 0);

  assert.equal(await attempt(processOperation, db), null);
  assert.equal(resizes, 2, 'the resize was asked for again');
  assert.equal(calls.to('/v1/task').length, 1, 'the failed task is not polled again');
  assert.deepEqual(db.ran(/^UPDATE servers SET vcpu/).map((q) => q.params), [[ids.server, 4, 8192, 80]]);
  assert.equal(state, 'poweredOn');
  assert.equal(db.op.status, 'succeeded');
});

test('a resize that finally fails starts the server again, restores every field "from" carries and withdraws the invoice the API added later', async () => {
  const later = { ...resizeParams, invoiceId: 'inv-1', from: { ...resizeParams.from, trafficGb: null, priceHourly: '0.0137' } };
  const db = fakeDb({ op: { kind: 'resize', step: 'resize', params: resizeParams }, // loaded at the job's start: no invoice id yet
    routes: [[/^SELECT step, params FROM operations/, () => [{ step: 'resize', params: later }]]] });
  const calls = fakeAdapter((path) => (path === '/v1/vm/find' ? vmOf('poweredOff') : path === '/v1/vm/resize' ? fail('DISK_HAS_SNAPSHOTS') : {}));
  const err = await attempt(processOperation, db);
  assert.equal(err.message, 'DISK_HAS_SNAPSHOTS');
  assert.equal(db.op.status, 'failed');
  assert.deepEqual(calls.to('/v1/vm/power').map((c) => c.body.action), ['on']);
  assert.deepEqual(db.ran(/^UPDATE servers SET price_monthly/)[0].params, [ids.server, '10.00', 'pkg-old', true, null, true, '0.0137']);
  assert.deepEqual(db.ran(/^UPDATE invoices SET status = 'cancelled'/)[0].params, ['inv-1']);
});

test('"from" without allowance and hourly price leaves those columns alone; a resize that was done keeps its price', async () => {
  const db = fakeDb({ op: { kind: 'resize', step: 'resize', params: { ...resizeParams, invoiceId: 'inv-1' } } });
  fakeAdapter((path) => (path === '/v1/vm/find' ? vmOf('poweredOff') : path === '/v1/vm/resize' ? fail('DISK_HAS_SNAPSHOTS') : {}));
  await attempt(processOperation, db);
  assert.deepEqual(db.ran(/^UPDATE servers SET price_monthly/)[0].params.slice(3), [false, null, false, null]);

  // Resized, then the start failed for good (step "on"): the VM has the new shape, so the new price and invoice stand.
  const done = fakeDb({ op: { kind: 'resize', step: 'on', params: { ...resizeParams, invoiceId: 'inv-1' } } });
  fakeAdapter((path) => (path === '/v1/vm/find' ? vmOf('poweredOff') : path === '/v1/vm/power' ? fail('INSUFFICIENT_RESOURCES') : {}));
  assert.equal((await attempt(processOperation, done)).message, 'INSUFFICIENT_RESOURCES');
  assert.equal(done.ran(/^UPDATE servers SET price_monthly/).length, 0);
  assert.equal(done.ran(/^UPDATE invoices/).length, 0);
});

test('a backup whose disk-copy task vanished is not marked ready: the copy is issued again', async () => {
  const backup = { id: '55555555-5555-4555-8555-555555555555', datastore_moref: 'ds-9', path: 'a/b.vmdk' };
  const db = fakeDb({ op: { kind: 'backup_create', params: { backupId: backup.id } }, server: { disk_gb: 40 }, routes: [[/^SELECT \* FROM backups/, () => [backup]]] });
  let snapshots = [], copies = 0;
  const calls = fakeAdapter((path, body) => {
    if (path === '/v1/vm/snapshots') return { snapshots };
    if (path === '/v1/vm/snapshot') { snapshots = body.action === 'create' ? [{ id: 'snapshot-1', name: body.name }] : []; return { task: '' }; }
    if (path === '/v1/vm/disk-copy') return { task: ++copies === 1 ? 'task-copy' : '' };
    if (path === '/v1/task') return { state: 'unknown', code: 'TASK_NOT_FOUND' };
  });
  const first = await attempt(processOperation, db);
  assert.equal(first.code, 'TASK_FAILED');
  assert.ok(!first.permanent, 'retryable');
  assert.equal(db.op.provider_task_id, null);
  assert.equal(db.ran(/^UPDATE backups SET status = 'ready'/).length, 0);

  assert.equal(await attempt(processOperation, db), null);
  assert.equal(copies, 2);
  assert.equal(calls.to('/v1/vm/snapshot').filter((c) => c.body.action === 'create').length, 1, 'the snapshot is not taken twice');
  assert.equal(db.ran(/^UPDATE backups SET status = 'ready'/).length, 1);
  assert.deepEqual(snapshots, [], 'the backup snapshot is removed');
});

test('a vanished task is judged by the real object where asking again is not safe', async () => {
  // Removing a snapshot: gone from the list is done (a second removal would fail with SNAPSHOT_NOT_FOUND).
  const del = fakeDb({ op: { kind: 'snapshot_delete', step: 'snapshot', provider_task_id: 'task-7', params: { snapshot: 'snapshot-3' } } });
  let calls = fakeAdapter((path) => (path === '/v1/task' ? { state: 'unknown', code: 'TASK_NOT_FOUND' } : path === '/v1/vm/snapshots' ? { snapshots: [] } : vmOf('poweredOn')));
  assert.equal(await attempt(processOperation, del), null);
  assert.equal(calls.to('/v1/vm/snapshot').length, 0);
  // Still listed: the id is dropped and the retry removes it.
  const again = fakeDb({ op: { kind: 'snapshot_delete', step: 'snapshot', provider_task_id: 'task-7', params: { snapshot: 'snapshot-3' } } });
  calls = fakeAdapter((path) => (path === '/v1/task' ? { state: 'unknown', code: 'TASK_NOT_FOUND' } : path === '/v1/vm/snapshots' ? { snapshots: [{ id: 'snapshot-3', name: 'x' }] } : path === '/v1/vm/snapshot' ? { task: '' } : vmOf('poweredOn')));
  assert.equal((await attempt(processOperation, again)).code, 'TASK_FAILED');
  assert.equal(await attempt(processOperation, again), null);
  assert.equal(calls.to('/v1/vm/snapshot').length, 1);
  // Power on: the VM's own state decides.
  const on = fakeDb({ op: { kind: 'power_on', step: 'on', provider_task_id: 'task-8' } });
  calls = fakeAdapter((path) => (path === '/v1/task' ? { state: 'unknown', code: 'TASK_NOT_FOUND' } : vmOf('poweredOff')));
  assert.equal((await attempt(processOperation, on)).code, 'TASK_FAILED', 'still off: not a success');
  assert.equal(on.op.provider_task_id, null);
});

test('the disk a disk_add made: never the system disk or a held one; by "before" when known, else by size', () => {
  const disks = [{ key: 2000, system: true, sizeGb: 40 }, { key: 2001, sizeGb: 20 }, { key: 2002, sizeGb: 50 }, { key: 2003, sizeGb: 20 }];
  assert.equal(addedDisk(disks, [2001], { sizeGb: 20 }).key, 2003);
  assert.equal(addedDisk(disks, [2001, 2003], { sizeGb: 20 }), null);
  assert.equal(addedDisk(disks, [2001], { before: [2000, 2001, 2002] }).key, 2003);
  assert.equal(addedDisk(disks, [], { before: [2000, 2001, 2002, 2003] }), null);
  assert.equal(addedDisk([{ key: 2000, system: true, sizeGb: 20 }], [], { sizeGb: 20 }), null);
});

test('a disk_add retry adopts the disk its earlier call made instead of adding a second one', async () => {
  const params = { diskId: '66666666-6666-4666-8666-666666666666', sizeGb: 20 };
  const routes = [[/^SELECT device_key FROM server_disks/, () => [{ device_key: 2001 }]]];
  const disks = [{ key: 2000, system: true, sizeGb: 40 }, { key: 2001, sizeGb: 20 }, { key: 2002, sizeGb: 20 }];
  // The platform answered {task: ""} after creating; then the attempt failed. Step "disk", no task id.
  const db = fakeDb({ op: { kind: 'disk_add', step: 'disk', params }, routes });
  let calls = fakeAdapter((path) => (path === '/v1/vm/disks' ? { disks } : {}));
  assert.equal(await attempt(processOperation, db), null);
  assert.equal(calls.to('/v1/vm/disk-add').length, 0);
  assert.deepEqual(db.ran(/^UPDATE server_disks SET device_key/)[0].params, [params.diskId, 2002]);
  // Nothing to adopt (the earlier call never arrived): the disk is added and found as the new key.
  const none = fakeDb({ op: { kind: 'disk_add', step: 'disk', params }, routes });
  const list = disks.slice(0, 2);
  calls = fakeAdapter((path) => { if (path === '/v1/vm/disks') return { disks: [...list] }; if (path === '/v1/vm/disk-add') { list.push({ key: 2005, sizeGb: 20 }); return { task: '' }; } });
  assert.equal(await attempt(processOperation, none), null);
  assert.equal(calls.to('/v1/vm/disk-add').length, 1);
  assert.deepEqual(none.ran(/^UPDATE server_disks SET device_key/)[0].params, [params.diskId, 2005]);
});

test('removing a disk deletes its row and lowers the price in one statement', async () => {
  const db = fakeDb({ op: { kind: 'disk_remove', params: { diskId: 'd-1', key: 2001, hourlySubtract: '0.0027' } }, routes: [[/^SELECT \* FROM server_disks/, () => [{ id: 'd-1', price_monthly: '2.00' }]]] });
  fakeAdapter(() => ({ task: '' }));
  assert.equal(await attempt(processOperation, db), null);
  const both = db.ran(/DELETE FROM server_disks/);
  assert.equal(both.length, 1);
  assert.match(both[0].sql, /^WITH gone AS \(DELETE FROM server_disks WHERE id = \$2 RETURNING price_monthly\)\s+UPDATE servers s SET price_monthly = greatest\(0, s\.price_monthly - gone\.price_monthly\)/);
  assert.ok(both[0].sql.includes("price_hourly = CASE WHEN s.billing_mode = 'hourly' AND s.price_hourly IS NOT NULL AND $3::numeric IS NOT NULL THEN greatest(0, s.price_hourly - $3::numeric) ELSE s.price_hourly END"));
  assert.deepEqual(both[0].params, [ids.server, 'd-1', '0.0027']);
  assert.equal(db.ran(/^UPDATE servers SET price_monthly/).length, 0);
});

test('cancelling a create waits for the running clone before it looks for the VM to destroy', async () => {
  const db = fakeDb({ op: { kind: 'create', step: 'clone', provider_task_id: 'task-clone', cancel_requested: true }, server: { vm_moref: null } });
  let polls = 0, vm = null;
  const calls = fakeAdapter((path) => {
    if (path === '/v1/task') { if (++polls < 3) return { state: 'running' }; vm = 'vm-9'; return { state: 'success', vm }; } // the VM is defined when the copy ends
    if (path === '/v1/vm/find') return { vm: vm ? vmOf('poweredOff', vm).vm : null };
    if (path === '/v1/vm/destroy') { vm = null; return { task: '' }; }
  });
  assert.equal((await attempt(processOperation, db)).message, 'CANCELLED');
  assert.equal(polls, 3);
  assert.deepEqual(calls.to('/v1/vm/destroy').map((c) => c.body.vm), ['vm-9']);
  assert.equal(db.op.status, 'cancelled');
  assert.equal(db.ran(/^UPDATE servers SET state = 'deleted'/).length, 1);

  // Past the deadline with the clone still running: nothing is marked deleted; the cancel is left failed for staff.
  const late = fakeDb({ op: { kind: 'create', step: 'clone', provider_task_id: 'task-clone', cancel_requested: true, late: true }, server: { vm_moref: null } });
  fakeAdapter((path) => (path === '/v1/task' ? { state: 'running' } : { vm: null }));
  await attempt(processOperation, late);
  assert.equal(late.op.status, 'failed');
  assert.equal(late.ran(/^UPDATE servers SET state = 'deleted'/).length, 0);
});

test('a clean shutdown of a server that is already off succeeds; a guest that ignores it fails with SHUTDOWN_TIMEOUT', async () => {
  const off = fakeDb({ op: { kind: 'shutdown' } });
  fakeAdapter((path) => (path === '/v1/vm/power' ? fail('TOOLS_NOT_RUNNING') : vmOf('poweredOff')));
  assert.equal(await attempt(processOperation, off), null);
  assert.equal(off.op.status, 'succeeded');

  const on = fakeDb({ op: { kind: 'shutdown' } });
  fakeAdapter((path) => (path === '/v1/vm/power' ? fail('TOOLS_NOT_RUNNING') : vmOf('poweredOn')));
  assert.equal((await attempt(processOperation, on)).message, 'TOOLS_NOT_RUNNING', 'running without a guest agent is still refused');

  const deaf = fakeDb({ op: { kind: 'shutdown' } });
  fakeAdapter((path) => (path === '/v1/vm/power' ? { task: '' } : vmOf('poweredOn')));
  assert.equal((await attempt(processOperation, deaf)).message, 'SHUTDOWN_TIMEOUT');
  assert.equal(deaf.op.status, 'failed');
  assert.equal(deaf.op.error_code, 'SHUTDOWN_TIMEOUT');
});

test('a reset of a stopped server starts it', async () => {
  const db = fakeDb({ op: { kind: 'reset' } });
  let state = 'poweredOff';
  const calls = fakeAdapter((path, body) => {
    if (path === '/v1/vm/power') { if (body.action === 'reset') return { task: 'task-r' }; state = 'poweredOn'; return { task: '' }; }
    if (path === '/v1/task') return { state: 'error', code: 'INVALID_STATE' };
    return vmOf(state);
  });
  assert.equal(await attempt(processOperation, db), null);
  assert.deepEqual(calls.to('/v1/vm/power').map((c) => c.body.action), ['reset', 'on']);
  assert.equal(db.op.status, 'succeeded');
});

test('a delete retried after its transaction committed still clears the PTR records and deletes the backup files', async () => {
  let released = [{ address: '203.0.113.20', ptr: null }], backups = [{ datastore_moref: 'ds-9', path: 'a/b.vmdk' }], crash = true;
  const db = fakeDb({ op: { kind: 'delete' }, routes: [
    [/^DELETE FROM ip_allocations/, () => { const r = released; released = []; return r; }],
    [/^UPDATE backups SET status = 'deleted'/, () => { const r = backups; backups = []; return r; }],
    [/^UPDATE operations SET status = 'succeeded'/, () => { if (crash) { crash = false; throw new Error('connection lost'); } db.op.status = 'succeeded'; }]] });
  const calls = fakeAdapter((path) => (path === '/v1/vm/find' ? { vm: null } : {}));
  const cleared = [];
  const rdns = async (job) => { cleared.push(job); };
  assert.ok(await attempt(processOperation, db, { rdns }), 'the first attempt dies after the commit');
  assert.deepEqual(cleared, []);
  assert.equal(await attempt(processOperation, db, { rdns }), null);
  assert.deepEqual(cleared, [{ action: 'clear', addresses: ['203.0.113.20'] }]);
  assert.deepEqual(calls.to('/v1/backup/delete').at(-1).body.name, 'a/b.vmdk');
  assert.equal(calls.to('/v1/backup/delete').length, 2, 'asked again on the retry (already gone is success)');
});

test('reconcile closes findings that no longer hold and gives a returned VM its earlier state', async () => {
  const [a, b, c] = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
  const db = fakeDb({ routes: [
    [/^SELECT DISTINCT c\.\*/, () => [connection()]],
    [/^SELECT s\.id, s\.state, s\.power_state/, () => [{ id: a, state: 'ready', power_state: 'poweredOn', vm_moref: 'vm-a' }, { id: b, state: 'missing', power_state: 'unknown', vm_moref: 'vm-b' }, { id: c, state: 'error', power_state: 'poweredOff', vm_moref: 'vm-c' }]],
    [/^SELECT 'lvm-' \|\| id/, () => [a, b, c].map((id) => ({ name: `lvm-${id}` }))]] });
  fakeAdapter(() => ({ vms: [{ name: `lvm-${a}`, moref: 'vm-a', powerState: 'poweredOn' }, { name: `lvm-${b}`, moref: 'vm-b', powerState: 'poweredOff' }, { name: 'lvm-stray', moref: 'vm-s', powerState: 'poweredOff' }] }));
  await reconcile(db, () => {});
  const findings = db.ran(/^INSERT INTO reconciliation_findings/).map((q) => [q.params[1], q.params[2] ?? q.params[3], q.params[4]]);
  assert.deepEqual(findings, [['power_drift', b, { recorded: 'unknown', actual: 'poweredOff' }], ['vm_missing', c, { was: 'error' }], ['orphan_vm', 'vm-s', { name: 'lvm-stray' }]]);
  assert.match(db.ran(/^INSERT INTO reconciliation_findings/)[0].sql, /detail = reconciliation_findings\.detail \|\| EXCLUDED\.detail/, 'a later run keeps the recorded earlier state');
  // b is back: its state comes from the finding (or its error code), never a flat "ready".
  const back = db.ran(/^UPDATE servers s SET state = COALESCE/);
  assert.deepEqual(back.map((q) => q.params), [[b]]);
  assert.match(back[0].sql, /detail->>'was' IN \('ready', 'error'\)[\s\S]*CASE WHEN s\.error_code IS NULL THEN 'ready' ELSE 'error' END/);
  assert.equal(db.ran(/SET state = 'ready'/).length, 0);
  // Open findings other than: c missing, b drifted, the stray VM. (a's old drift, b's missing, strays gone: closed.)
  const closed = db.ran(/^UPDATE reconciliation_findings SET resolved_at = now\(\) WHERE connection_id = \$1/);
  assert.deepEqual(closed.map((q) => q.params), [[ids.conn, [c], [b], ['vm-s'], []]]);
  assert.equal(db.ran(/^UPDATE servers SET vm_moref/).length, 0, 'the ids match: nothing is re-bound');
});

test('reconcile re-binds a server whose VM is listed under another id, before it counts as ready again', async () => {
  const [a, b] = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
  // a went missing as VM 102 and is back under its name as 103; 102 is b's VM by now (Proxmox gave the number out again).
  const db = fakeDb({ routes: [
    [/^SELECT DISTINCT c\.\*/, () => [connection({ kind: 'proxmox' })]],
    [/^SELECT s\.id, s\.state, s\.power_state/, () => [{ id: a, state: 'missing', power_state: 'unknown', vm_moref: '102' }, { id: b, state: 'ready', power_state: 'poweredOn', vm_moref: '102' }]],
    [/^SELECT 'lvm-' \|\| id/, () => [a, b].map((id) => ({ name: `lvm-${id}` }))]] });
  fakeAdapter(() => ({ vms: [{ name: `lvm-${a}`, moref: '103', powerState: 'poweredOff' }, { name: `lvm-${b}`, moref: '102', powerState: 'poweredOn' }] }));
  await reconcile(db, () => {});
  assert.deepEqual(db.ran(/^UPDATE servers SET vm_moref/).map((q) => q.params), [[a, '103', '102']]);
  const finding = db.ran(/^INSERT INTO reconciliation_findings/).find((q) => q.params[1] === 'vm_id_changed');
  assert.deepEqual(finding.params.slice(1), ['vm_id_changed', a, '103', { recorded: '102', actual: '103' }]);
  const order = db.log.map((q) => q.sql);
  assert.ok(order.findIndex((s) => /^UPDATE servers SET vm_moref/.test(s)) < order.findIndex((s) => /^UPDATE servers s SET state = COALESCE/.test(s)), 'the id first, then the state');
  assert.deepEqual(db.ran(/^UPDATE reconciliation_findings SET resolved_at/)[0].params[4], [a], 'the finding stays open for this run');
});

test('after a restore the worker starts nothing and reconcile only reports, until the hold is released', async () => {
  let held = true;
  const hold = [/^SELECT 1 FROM maintenance_state/, () => (held ? [{}] : [])];
  forgetRestoreHold();
  try {
    const db = fakeDb({ op: { kind: 'delete', step: 'queued' }, routes: [hold] });
    const calls = fakeAdapter(() => ({ vm: null }));
    const logged = [];
    await processOperation(db, { id: db.op.id, attemptsMade: 0, opts: { attempts: 6 } }, (level, event) => logged.push(event));
    assert.deepEqual([db.op.status, db.op.attempts, calls.length], ['pending', 0, 0], 'the operation is as the backup held it');
    assert.deepEqual(logged, ['operation_held']);

    const [a, b] = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
    const rec = fakeDb({ routes: [hold,
      [/^SELECT DISTINCT c\.\*/, () => [connection()]],
      [/^SELECT s\.id, s\.state, s\.power_state/, () => [{ id: a, state: 'ready', power_state: 'poweredOn', vm_moref: 'vm-1' }, { id: b, state: 'ready', power_state: 'poweredOn', vm_moref: 'vm-2' }]],
      [/^SELECT 'lvm-' \|\| id/, () => [a, b].map((id) => ({ name: `lvm-${id}` }))]] });
    fakeAdapter(() => ({ vms: [{ name: `lvm-${a}`, moref: 'vm-9', powerState: 'poweredOff' }] }));
    await reconcile(rec, () => {});
    assert.deepEqual(rec.ran(/^INSERT INTO reconciliation_findings/).map((q) => q.params[1]), ['vm_id_changed', 'power_drift', 'vm_missing']);
    assert.equal(rec.ran(/^UPDATE servers/).length, 0, 'no server row is changed while the hold is on');

    // Released: the same operation runs.
    held = false;
    forgetRestoreHold();
    assert.equal(await attempt(processOperation, db), null);
    assert.equal(db.op.status, 'succeeded');
  } finally { forgetRestoreHold(); }
});

test('a deadline that passes while an issued task runs undoes nothing: the task is waited for, and its outcome decides', async () => {
  // The deadline is over (late) when the resize task is issued and while it runs.
  const db = fakeDb({ op: { kind: 'resize', step: 'resize', late: false, params: { ...resizeParams, invoiceId: 'inv-1' } } });
  let state = 'poweredOff', polls = 0;
  fakeAdapter((path, body) => {
    if (path === '/v1/vm/find') return vmOf(state);
    if (path === '/v1/vm/power') { state = body.action === 'on' ? 'poweredOn' : 'poweredOff'; return { task: '' }; }
    if (path === '/v1/vm/resize') { db.op.late = true; return { task: 'task-r' }; }
    if (path === '/v1/task') return ++polls < 4 ? { state: 'running' } : { state: 'success' };
  });
  assert.equal(await attempt(processOperation, db), null);
  assert.equal(polls, 4, 'waited past the deadline');
  assert.equal(db.op.status, 'succeeded');
  assert.deepEqual(db.ran(/^UPDATE servers SET vcpu/).map((q) => q.params), [[ids.server, 4, 8192, 80]]);
  assert.equal(db.ran(/^UPDATE servers SET price_monthly/).length + db.ran(/^UPDATE invoices/).length, 0);
  assert.equal(state, 'poweredOn');

  // The deadline still stops what is not issued yet: a resize picked up late is not started, and its price goes back.
  const early = fakeDb({ op: { kind: 'resize', step: 'resize', late: true, params: resizeParams } });
  const none = fakeAdapter((path) => (path === '/v1/vm/find' ? vmOf('poweredOff') : {}));
  assert.equal((await attempt(processOperation, early)).message, 'TIMEOUT');
  assert.equal(none.to('/v1/vm/resize').length, 0);
  assert.equal(early.ran(/^UPDATE servers SET price_monthly/).length, 1);
});

test('a task whose outcome cannot be learned ends the operation as OUTCOME_UNKNOWN: price, invoice and rows stay, staff are told', async () => {
  const told = [];
  const notify = async (event, to, data) => { told.push([event, data.code]); };
  // Still running at the hard limit past the deadline.
  const db = fakeDb({ op: { kind: 'resize', step: 'resize', provider_task_id: 'task-r', late: true, abandoned: true, params: { ...resizeParams, invoiceId: 'inv-1' } } });
  let calls = fakeAdapter((path) => (path === '/v1/task' ? { state: 'running' } : vmOf('poweredOff')));
  assert.equal((await attempt(processOperation, db, { notify })).message, 'OUTCOME_UNKNOWN');
  assert.deepEqual([db.op.status, db.op.error_code, db.op.provider_task_id], ['failed', 'OUTCOME_UNKNOWN', 'task-r'], 'the task id is kept for a retry to read');
  assert.equal(db.ran(/^UPDATE servers SET price_monthly/).length + db.ran(/^UPDATE invoices/).length, 0, 'the billing state is as the operation wrote it');
  assert.equal(calls.to('/v1/vm/power').length, 0, 'not started under a task that may still run');
  assert.deepEqual(told, [['server.failed', 'OUTCOME_UNKNOWN'], ['admin.operation_failed', 'OUTCOME_UNKNOWN']]);

  // The adapter cannot be asked about the task any more, on the last attempt: the same, for an extra disk.
  const params = { diskId: '66666666-6666-4666-8666-666666666666', sizeGb: 20 };
  const disk = fakeDb({ op: { kind: 'disk_add', step: 'disk', provider_task_id: 'task-d', params } });
  calls = fakeAdapter((path) => { if (path === '/v1/task') throw new Error('connection refused'); return { disks: [{ key: 2000, system: true, sizeGb: 40 }] }; });
  const first = await attempt(processOperation, disk);
  assert.deepEqual([first.code, disk.op.status], ['VMWARE_SERVICE_UNAVAILABLE', 'pending'], 'retried while attempts are left');
  assert.equal((await attempt(processOperation, disk, { last: true })).message, 'OUTCOME_UNKNOWN');
  assert.deepEqual([disk.op.status, disk.op.error_code, disk.op.provider_task_id], ['failed', 'OUTCOME_UNKNOWN', 'task-d']);
  assert.equal(disk.ran(/^UPDATE server_disks SET status = 'failed'/).length, 0, 'the row is not marked failed (its owner could delete it and its price while the disk exists)');

  // A task that answered with an error is a known outcome: the undo runs as before.
  const failed = fakeDb({ op: { kind: 'disk_add', step: 'disk', provider_task_id: 'task-d', late: true, params } });
  fakeAdapter((path) => (path === '/v1/task' ? { state: 'error', code: 'INSUFFICIENT_RESOURCES', error: 'no room' } : { disks: [] }));
  assert.equal((await attempt(processOperation, failed)).message, 'INSUFFICIENT_RESOURCES');
  assert.equal(failed.ran(/^UPDATE server_disks SET status = 'failed'/).length, 1);
});

test('every request about a server names the VM it expects; a copy names its source, an order from an image none', async () => {
  const name = `lvm-${ids.server}`;
  const db = fakeDb({ op: { kind: 'snapshot_create', params: { name: 'before upgrade' } } });
  let calls = fakeAdapter((path) => (path === '/v1/vm/snapshot' ? { task: '' } : { snapshots: [] }));
  assert.equal(await attempt(processOperation, db), null);
  assert.deepEqual(calls.to('/v1/vm/snapshot').map((c) => [c.body.vm, c.body.expectName]), [['vm-1', name]]);
  const off = fakeDb({ op: { kind: 'power_off' } });
  calls = fakeAdapter((path) => (path === '/v1/vm/find' ? vmOf('poweredOff') : { task: '' }));
  assert.equal(await attempt(processOperation, off), null);
  assert.deepEqual(calls.to('/v1/vm/power').map((c) => [c.body.vm, c.body.expectName]), [['vm-1', name]]);
  // The adapter's refusal is final: the number belongs to another VM, a retry would not change that.
  const other = fakeDb({ op: { kind: 'power_off' } });
  fakeAdapter((path) => (path === '/v1/vm/find' ? vmOf('poweredOn') : fail('VM_MISMATCH')));
  assert.equal((await attempt(processOperation, other)).message, 'VM_MISMATCH');
  assert.equal(other.op.status, 'failed');

  const source = '77777777-7777-4777-8777-777777777777';
  const server = { vm_moref: null, pool_id: 'pool-1', datastore_morefs: ['ds-1'], compute_moref: 'c-1', template_moref: '100', clone_from_moref: '107', clone_from_server_id: source };
  const inventory = [[/FROM vmware_datastores/, () => [{ moref: 'ds-1' }]], [/FROM vmware_compute/, () => [{ resource_pool: 'rp-1' }]], [/^SELECT 1 FROM servers WHERE id = \$1 AND owner_id/, () => [{}]]];
  const answers = (path) => (path === '/v1/vm/clone' ? { vm: 'vm-9' } : vmOf('poweredOn', 'vm-9'));
  const copy = fakeDb({ op: { kind: 'create' }, server, routes: inventory });
  calls = fakeAdapter(answers);
  assert.equal(await attempt(processOperation, copy), null);
  assert.deepEqual(calls.to('/v1/vm/clone').map((c) => [c.body.template, c.body.expectName]), [['107', `lvm-${source}`]]);
  const plain = fakeDb({ op: { kind: 'create' }, server: { ...server, clone_from_moref: null, clone_from_server_id: null }, routes: inventory });
  calls = fakeAdapter(answers);
  assert.equal(await attempt(processOperation, plain), null);
  assert.deepEqual(calls.to('/v1/vm/clone').map((c) => [c.body.template, 'expectName' in c.body]), [['100', false]]);
});

test('the customer\'s SSH keys are root\'s: disable_root is off and the keys stay top-level for the adapters that read them', () => {
  const u = JSON.parse(cloudInit({ id: ids.server, name: 'web1', address: '203.0.113.20', prefix: 24, gateway: '203.0.113.1', dns: ['1.1.1.1'], ssh_public_keys: ['ssh-ed25519 AAAA me'], image_family: 'linux' }).userdata.replace('#cloud-config\n', ''));
  assert.equal(u.disable_root, false);
  assert.deepEqual(u.ssh_authorized_keys, ['ssh-ed25519 AAAA me']);
  assert.equal(u.ssh_pwauth, false);
});

test('each platform has its adapter; an unknown or absent kind is VMware\'s', () => {
  assert.equal(adapterBase('proxmox'), 'http://proxmox:8080');
  assert.equal(adapterBase('incus'), 'http://incus:8080');
  assert.equal(adapterBase(undefined), 'http://vmware:8080');
});

test('what a clone did not do is kept on the operation and logged; a repeated attempt does not list it twice', async () => {
  assert.deepEqual(warningCodes({ warnings: ['EXTRA_ADDRESSES_NOT_CONFIGURED', 'EXTRA_ADDRESSES_NOT_CONFIGURED', 'not a code', 7] }), ['EXTRA_ADDRESSES_NOT_CONFIGURED']);
  assert.deepEqual([warningCodes({}), warningCodes({ warnings: 'X' })], [[], []]);
  const db = fakeDb({ op: { kind: 'create' }, server: { vm_moref: null, datastore_morefs: ['ds-1'], compute_moref: 'c-1' },
    routes: [[/FROM vmware_datastores/, () => [{ moref: 'ds-1' }]], [/FROM vmware_compute/, () => [{ resource_pool: 'rp-1' }]]] });
  fakeAdapter((path) => (path === '/v1/vm/clone' ? { task: 'UPID:x|105', existed: false, warnings: ['EXTRA_ADDRESSES_NOT_CONFIGURED'] } : path === '/v1/task' ? fail('TASK_FAILED', 'stopped here') : { vm: null }));
  const logged = [];
  for (let i = 0; i < 2; i++) await processOperation(db, { id: db.op.id, attemptsMade: 0, opts: { attempts: 6 } }, (level, event, fields) => logged.push([level, event, fields.warnings])).catch(() => {});
  assert.deepEqual(db.op.params.warnings, ['EXTRA_ADDRESSES_NOT_CONFIGURED']);
  assert.deepEqual(logged.filter((l) => l[1] === 'operation_warnings')[0], ['warn', 'operation_warnings', ['EXTRA_ADDRESSES_NOT_CONFIGURED']]);
});

test('a copy is built only from its source server as it is now: gone, handed over or on another VM, nothing is cloned', async () => {
  const source = '77777777-7777-4777-8777-777777777777';
  const server = { vm_moref: null, pool_id: 'pool-1', datastore_morefs: ['ds-1'], compute_moref: 'c-1', template_moref: 'tpl-1', clone_from_moref: '107', clone_from_server_id: source };
  const inventory = [[/FROM vmware_datastores/, () => [{ moref: 'ds-1' }]], [/FROM vmware_compute/, () => [{ resource_pool: 'rp-1' }]]];
  const answers = (path) => (path === '/v1/vm/clone' ? { vm: 'vm-9' } : vmOf('poweredOn', 'vm-9'));
  // The source row no longer matches (another owner, deleted, reinstalled onto another VM): the stand-in answers no row.
  const gone = fakeDb({ op: { kind: 'create' }, server, routes: inventory });
  let calls = fakeAdapter(answers);
  assert.equal((await attempt(processOperation, gone)).message, 'CLONE_SOURCE_GONE');
  assert.equal(gone.op.status, 'failed', 'permanent: not retried');
  assert.equal(calls.to('/v1/vm/clone').length, 0);
  assert.deepEqual(gone.ran(/^SELECT 1 FROM servers WHERE id = \$1 AND owner_id = \$2 AND pool_id = \$3 AND vm_moref = \$4 AND state = 'ready'/)[0].params, [source, ids.owner, 'pool-1', '107']);
  // An order from before the source was recorded (no source id) is not built from a bare VM id either.
  const unbound = fakeDb({ op: { kind: 'create' }, server: { ...server, clone_from_server_id: null }, routes: [...inventory, [/^SELECT 1 FROM servers WHERE id = \$1 AND owner_id/, (p) => (p[0] ? [{}] : [])]] });
  calls = fakeAdapter(answers);
  assert.equal((await attempt(processOperation, unbound)).message, 'CLONE_SOURCE_GONE');
  assert.equal(calls.to('/v1/vm/clone').length, 0);
  // Still the copy owner's ready server on that VM: cloned from it.
  const ok = fakeDb({ op: { kind: 'create' }, server, routes: [...inventory, [/^SELECT 1 FROM servers WHERE id = \$1 AND owner_id/, () => [{}]]] });
  calls = fakeAdapter(answers);
  assert.equal(await attempt(processOperation, ok), null);
  assert.deepEqual(calls.to('/v1/vm/clone').map((c) => c.body.template), ['107']);
  // An ordinary order asks nothing about a source.
  const plain = fakeDb({ op: { kind: 'create' }, server: { ...server, clone_from_moref: null, clone_from_server_id: null }, routes: inventory });
  calls = fakeAdapter(answers);
  assert.equal(await attempt(processOperation, plain), null);
  assert.deepEqual(calls.to('/v1/vm/clone').map((c) => c.body.template), ['tpl-1']);
  assert.equal(plain.ran(/^SELECT 1 FROM servers WHERE id = \$1 AND owner_id/).length, 0);
});

test('a cancel asked for while a resize task runs waits for its real outcome: the resize that landed keeps its price', async () => {
  const db = fakeDb({ op: { kind: 'resize', params: { ...resizeParams, invoiceId: 'inv-1' } } });
  let state = 'poweredOff', polls = 0;
  const calls = fakeAdapter((path, body) => {
    if (path === '/v1/vm/find') return vmOf(state);
    if (path === '/v1/vm/power') { state = body.action === 'on' ? 'poweredOn' : 'poweredOff'; return { task: '' }; }
    if (path === '/v1/vm/resize') { db.op.cancel_requested = true; return { task: 'task-r' }; } // the cancel lands once the task is issued
    if (path === '/v1/task') return ++polls < 3 ? { state: 'running' } : { state: 'success' };
  });
  assert.equal(await attempt(processOperation, db), null);
  assert.equal(polls, 3, 'the task was waited for, not abandoned');
  assert.equal(db.op.status, 'succeeded');
  assert.deepEqual(db.ran(/^UPDATE servers SET vcpu/).map((q) => q.params), [[ids.server, 4, 8192, 80]]);
  assert.equal(db.ran(/^UPDATE servers SET price_monthly/).length, 0, 'the price is not put back');
  assert.equal(db.ran(/^UPDATE invoices/).length, 0);
  assert.equal(calls.to('/v1/vm/resize').length, 1);

  // A worker restart finds the stored task and the cancel request: it still waits (the first check does not end it).
  const resumed = fakeDb({ op: { kind: 'resize', step: 'resize', provider_task_id: 'task-r', cancel_requested: true, params: resizeParams } });
  fakeAdapter((path) => (path === '/v1/task' ? { state: 'success' } : path === '/v1/vm/find' ? vmOf('poweredOn') : { task: '' }));
  assert.equal(await attempt(processOperation, resumed), null);
  assert.equal(resumed.ran(/^UPDATE servers SET vcpu/).length, 1);
  assert.equal(resumed.ran(/^UPDATE servers SET price_monthly/).length, 0);

  // The task it waited for failed: that is the real outcome, and only then is the price put back.
  const failed = fakeDb({ op: { kind: 'resize', step: 'resize', provider_task_id: 'task-r', cancel_requested: true, params: resizeParams } });
  fakeAdapter((path) => (path === '/v1/task' ? { state: 'error', code: 'INSUFFICIENT_RESOURCES', error: 'no room' } : path === '/v1/vm/find' ? vmOf('poweredOff') : {}));
  assert.equal((await attempt(processOperation, failed)).message, 'INSUFFICIENT_RESOURCES');
  assert.equal(failed.ran(/^UPDATE servers SET price_monthly/).length, 1);
});

test('a cancel asked for before the resize task is issued stops it there: nothing is changed and the old price returns', async () => {
  const db = fakeDb({ op: { kind: 'resize', params: resizeParams } });
  let state = 'poweredOn';
  const calls = fakeAdapter((path, body) => {
    if (path === '/v1/vm/find') return vmOf(state);
    if (path === '/v1/vm/power') { state = body.action === 'on' ? 'poweredOn' : 'poweredOff'; if (body.action !== 'on') db.op.cancel_requested = true; return { task: '' }; } // cancelled while it is being stopped
  });
  assert.equal((await attempt(processOperation, db)).message, 'CANCELLED');
  assert.equal(calls.to('/v1/vm/resize').length, 0);
  assert.equal(db.op.status, 'failed');
  assert.equal(db.ran(/^UPDATE servers SET vcpu/).length, 0);
  assert.deepEqual(db.ran(/^UPDATE servers SET price_monthly/)[0].params.slice(0, 3), [ids.server, '10.00', 'pkg-old']);
  assert.equal(state, 'poweredOn', 'started again as it was');
});

test('a disk_add cancelled while its task runs ends with the disk it made, not with a failed row for a disk that exists', async () => {
  const params = { diskId: '66666666-6666-4666-8666-666666666666', sizeGb: 20 };
  const db = fakeDb({ op: { kind: 'disk_add', params } });
  const list = [{ key: 2000, system: true, sizeGb: 40 }];
  const calls = fakeAdapter((path) => {
    if (path === '/v1/vm/disks') return { disks: [...list] };
    if (path === '/v1/vm/disk-add') { db.op.cancel_requested = true; return { task: 'task-d' }; }
    if (path === '/v1/task') { list.push({ key: 2001, sizeGb: 20 }); return { state: 'success' }; }
  });
  assert.equal(await attempt(processOperation, db), null);
  assert.deepEqual(db.ran(/^UPDATE server_disks SET device_key/)[0].params, [params.diskId, 2001]);
  assert.equal(db.ran(/^UPDATE server_disks SET status = 'failed'/).length, 0);
  assert.equal(calls.to('/v1/task').length, 1);
  // Cancelled before the worker picked it up: nothing is issued and the row is marked failed (its removal credits the price once, api disks.ts).
  const early = fakeDb({ op: { kind: 'disk_add', step: 'queued', cancel_requested: true, params } });
  const none = fakeAdapter(() => ({}));
  assert.equal((await attempt(processOperation, early)).message, 'CANCELLED');
  assert.equal(none.length, 0);
  assert.equal(early.ran(/^UPDATE server_disks SET status = 'failed'/).length, 1);
});
