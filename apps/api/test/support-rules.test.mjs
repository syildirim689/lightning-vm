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
