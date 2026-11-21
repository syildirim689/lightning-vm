import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latestFailure, nextStep, retryable, type FailedOperation } from './next-step.ts';

test('a temporary failure of a power action or a snapshot is offered again', () => {
  for (const kind of ['power_on', 'shutdown', 'reset', 'snapshot_create'])
    for (const code of ['TIMEOUT', 'VMWARE_SERVICE_UNAVAILABLE', 'ENGINE_BUSY', 'SERVER_BUSY', 'STORAGE_UNREACHABLE', 'SHUTDOWN_TIMEOUT'])
      assert.deepEqual(nextStep(kind, code), { step: 'retry' }, `${kind} ${code}`);
});

test('nothing that builds, destroys, restores or costs is ever retried, however temporary the code', () => {
  for (const kind of ['create', 'delete', 'reinstall', 'resize', 'snapshot_revert', 'backup_restore', 'backup_create', 'disk_add', 'migrate', 'image_create', 'power_off', 'something_new']) {
    assert.equal(retryable(kind), false, kind);
    assert.deepEqual(nextStep(kind, 'TIMEOUT'), { step: 'support', staff: false }, kind);
  }
});

test('an unknown outcome, a VM that is not ours and a changed server go to staff, never to retry', () => {
  for (const code of ['OUTCOME_UNKNOWN', 'VM_MISMATCH', 'SERVER_CHANGED'])
    for (const kind of ['power_on', 'shutdown', 'snapshot_create', 'resize', 'create'])
      assert.deepEqual(nextStep(kind, code), { step: 'support', staff: true }, `${kind} ${code}`);
});

test('money and limits point to billing and to the quota, whatever the operation', () => {
  for (const code of ['INSUFFICIENT_BALANCE', 'BALANCE_TOO_LOW', 'UNPAID_INVOICE', 'BILLING_HOLD']) {
    assert.deepEqual(nextStep('power_on', code), { step: 'billing' });
    assert.deepEqual(nextStep('resize', code), { step: 'billing' });
  }
  for (const code of ['QUOTA_EXCEEDED', 'PROJECT_QUOTA_EXCEEDED', 'LIMIT_REACHED', 'VDC_LIMIT']) {
    assert.deepEqual(nextStep('create', code), { step: 'quota' });
    assert.deepEqual(nextStep('snapshot_create', code), { step: 'quota' });
  }
});

test('a code nobody listed, a permanent one or none at all falls back to support', () => {
  for (const code of ['TASK_FAILED', 'VMWARE_ERROR', 'INTERNAL_ERROR', 'TOOLS_NOT_RUNNING', 'INVALID_STATE', 'VM_NOT_FOUND', 'BRAND_NEW_CODE', '', null, undefined])
    assert.deepEqual(nextStep('power_on', code), { step: 'support', staff: false }, String(code));
});

const now = Date.parse('2026-11-18T12:00:00Z');
const op = (over: Partial<FailedOperation>): FailedOperation => ({ id: 'o1', kind: 'power_on', status: 'failed', errorCode: 'TIMEOUT', createdAt: '2026-11-18T11:00:00Z', finishedAt: '2026-11-18T11:05:00Z', ...over });

test('the notice is about the newest operation only, while it still matters', () => {
  assert.equal(latestFailure([op({})], 'ready', now)?.id, 'o1');
  // Something newer succeeded, is running or was cancelled: the older failure is history.
  assert.equal(latestFailure([op({ id: 'new', status: 'succeeded', errorCode: null }), op({})], 'ready', now), null);
  assert.equal(latestFailure([op({ id: 'new', status: 'running', errorCode: null, finishedAt: null }), op({})], 'ready', now), null);
  assert.equal(latestFailure([op({ status: 'cancelled', errorCode: 'CANCELLED' })], 'ready', now), null);
  // Older than a day: gone, unless the server is still in its error state.
  const old = op({ createdAt: '2026-11-10T11:00:00Z', finishedAt: '2026-11-10T11:05:00Z' });
  assert.equal(latestFailure([old], 'ready', now), null);
  assert.equal(latestFailure([old], 'error', now)?.id, 'o1');
  // No finish time recorded: the start counts. No operations, or a failure without a code: nothing.
  assert.equal(latestFailure([op({ finishedAt: null })], 'ready', now)?.id, 'o1');
  assert.equal(latestFailure([], 'error', now), null);
  assert.equal(latestFailure([op({ errorCode: null })], 'error', now), null);
});
