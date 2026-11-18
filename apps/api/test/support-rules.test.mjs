// Support rules: deadlines by priority, who waits after a message, reopening, attachments checked by content.
import test from 'node:test';
import assert from 'node:assert/strict';

const { dueFrom, afterMessage, reopenable, overdue, readAttachments, maxBytes } = await import('../dist/support-rules.js');
const now = new Date('2026-10-26T10:00:00Z');

test('deadlines follow the priority; overdue once passed', () => {
  assert.equal(dueFrom(now, 'urgent').toISOString(), '2026-10-26T11:00:00.000Z');
  assert.equal(dueFrom(now, 'low').toISOString(), '2026-10-27T10:00:00.000Z');
  assert.equal(overdue(new Date('2026-10-26T09:59:00Z'), now), true);
  assert.equal(overdue(null, now), false);
});

test('a staff answer waits on the customer; a customer message waits on staff with a new deadline; internal notes change nothing', () => {
  assert.deepEqual(afterMessage({ status: 'open', priority: 'high' }, 'staff', false, now), { status: 'answered', dueAt: null });
  assert.deepEqual(afterMessage({ status: 'answered', priority: 'high' }, 'customer', false, now), { status: 'customer_reply', dueAt: new Date('2026-10-26T14:00:00Z') });
  assert.equal(afterMessage({ status: 'open', priority: 'high' }, 'customer', false, now).status, 'open');
  assert.equal(afterMessage({ status: 'open', priority: 'high' }, 'staff', true, now), null);
});

test('closed tickets can be reopened for 30 days', () => {
  assert.equal(reopenable(new Date('2026-10-01T10:00:00Z'), now), true);
  assert.equal(reopenable(new Date('2026-09-20T10:00:00Z'), now), false);
});

test('attachments: allowed types whose first bytes match, at most 3, at most 2 MB each', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(10)]).toString('base64');
  const ok = readAttachments([{ name: 'shot.png', type: 'image/png', data: png }, { name: '../app.log', type: 'text/plain', data: Buffer.from('line 1\n').toString('base64') }]);
  assert.equal(ok.error, null);
  assert.deepEqual(ok.files.map((f) => f.name), ['shot.png', '.._app.log']);
  assert.equal(readAttachments([{ name: 'evil.png', type: 'image/png', data: Buffer.from('MZ\x90\x00').toString('base64') }]).error, 'FILE_TYPE_NOT_ALLOWED');
  assert.equal(readAttachments([{ name: 'x.exe', type: 'application/x-msdownload', data: 'AA==' }]).error, 'FILE_TYPE_NOT_ALLOWED');
  assert.equal(readAttachments([{ name: 'big.txt', type: 'text/plain', data: Buffer.alloc(maxBytes + 1, 97).toString('base64') }]).error, 'FILE_TOO_LARGE');
  assert.equal(readAttachments([1, 2, 3, 4]).error, 'TOO_MANY_FILES');
  assert.deepEqual(readAttachments(undefined), { files: [], error: null });
});

test('a ticket\'s diagnostics: the server as the database had it, its last five operations, nothing secret', async () => {
  const { ticketDiagnostics } = await import('../dist/support-rules.js');
  const op = (n, extra = {}) => ({ kind: 'power_on', status: 'succeeded', error_code: null, created_at: `2026-11-1${n}T08:00:00.123456+00:00`, finished_at: `2026-11-1${n}T08:00:09+00:00`, ...extra });
  const row = { id: 's1', name: 'web-1', state: 'ready', power: 'poweredOn', platform: 'proxmox', location: 'İstanbul', plan: 'S2', vcpu: 2, memory_mb: 4096, disk_gb: 80, image: 'Ubuntu 24.04',
    addresses: ['203.0.113.10', '2001:db8::10'], locked: true, pending_deletion: false, created_at: new Date('2026-10-01T09:30:00Z'), traffic_gb: null, traffic_throttled: false, traffic_bytes: 12e9,
    operations: [op(7, { kind: 'reset', status: 'failed', error_code: 'TASK_FAILED' }), op(6, { status: 'running', finished_at: null }), op(5), op(4), op(3), op(2)], unpaid: 2,
    // What the row must never carry over, even if a later query selected it.
    notes: 'root pw on the sticky note', root_password_enc: 'x', app_token_hash: 'y', owner_id: 'u1' };
  const d = ticketDiagnostics(row, now);
  assert.deepEqual(d, { capturedAt: '2026-10-26T10:00:00.000Z',
    server: { id: 's1', name: 'web-1', state: 'ready', power: 'poweredOn', platform: 'proxmox', location: 'İstanbul', plan: 'S2', vcpu: 2, memoryMb: 4096, diskGb: 80, image: 'Ubuntu 24.04',
      addresses: ['203.0.113.10', '2001:db8::10'], locked: true, pendingDeletion: false, createdAt: '2026-10-01T09:30:00.000Z' },
    operations: [
      { kind: 'reset', status: 'failed', errorCode: 'TASK_FAILED', createdAt: '2026-11-17T08:00:00.123Z', finishedAt: '2026-11-17T08:00:09.000Z' },
      { kind: 'power_on', status: 'running', errorCode: null, createdAt: '2026-11-16T08:00:00.123Z', finishedAt: null },
      ...[5, 4, 3].map((n) => ({ kind: 'power_on', status: 'succeeded', errorCode: null, createdAt: `2026-11-1${n}T08:00:00.123Z`, finishedAt: `2026-11-1${n}T08:00:09.000Z` })),
    ],
    unpaidInvoices: 2 });
  assert.ok(!/sticky|root_password|token|notes|owner/.test(JSON.stringify(d)));
  // A custom shape with a monthly allowance, about to be deleted, with no address or operation yet.
  const bare = ticketDiagnostics({ ...row, plan: null, image: null, addresses: [], operations: null, unpaid: null, power: null, pending_deletion: true, locked: false,
    traffic_gb: 500, traffic_throttled: true, traffic_bytes: 512.34e9 }, now);
  assert.deepEqual([bare.server.plan, bare.server.image, bare.server.addresses, bare.server.power, bare.server.pendingDeletion, bare.server.locked, bare.operations, bare.unpaidInvoices],
    [null, null, [], 'unknown', true, false, [], 0]);
  assert.deepEqual(bare.server.traffic, { allowanceGb: 500, usedGb: 512.3, throttled: true });
});
