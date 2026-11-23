// The admin's setup checklist: built from the installation's state each time, so a regression brings a step back.
import test from 'node:test';
import assert from 'node:assert/strict';

const { steps } = await import('../dist/onboarding-rules.js');

const ready = {
  counts: { connection: 1, location: 1, pool: 1, image: 2, package: 3, ip: 1 },
  mail: { ready: true, last: { ok: true, at: '2026-11-23T08:00:00Z' } },
  backup: { lastOk: '2026-11-23T03:00:00Z', timer: true, schedule: 'daily' },
  monitoring: 'on',
  updates: { autoUpdate: 'on', channel: 'stable', updateAvailable: true, latest: 'v0.6.1' },
  billing: { enabled: true, gateways: 1 },
  twoFactor: { me: true, staffWithout: 0 },
};
const byKey = (f) => Object.fromEntries(steps(f).map((s) => [s.key, s]));

test('a fully set-up installation has every step done, the start steps first', () => {
  const s = steps(ready);
  assert.ok(s.every((x) => x.done), JSON.stringify(s.filter((x) => !x.done)));
  assert.deepEqual(s.map((x) => x.key), ['connection', 'location', 'pool', 'image', 'package', 'ip', 'mail', 'backup', 'twoFactor',
    'mailDelivers', 'backupSchedule', 'monitoring', 'updates', 'payments', 'staffTwoFactor']);
  assert.deepEqual(s.map((x) => x.group), [...Array(9).fill('start'), ...Array(6).fill('health')]);
});

test('mail that is set up but failed its last message is not done, and says when and why', () => {
  const s = byKey({ ...ready, mail: { ready: true, last: { ok: false, at: '2026-11-23T09:00:00Z', code: 'MAIL_AUTH_FAILED' } } });
  assert.equal(s.mail.done, true);
  assert.equal(s.mailDelivers.done, false);
  assert.deepEqual(s.mailDelivers.detail, { at: '2026-11-23T09:00:00Z', code: 'MAIL_AUTH_FAILED' });
  assert.equal(byKey({ ...ready, mail: { ready: true, last: null } }).mailDelivers.done, true, 'nothing sent yet is nothing failed');
  assert.equal(byKey({ ...ready, mail: { ready: false, last: null } }).mailDelivers, undefined, 'mail not set up: the start step says so');
});

test('backups count as scheduled only while the host timer is installed and the schedule is not off', () => {
  assert.equal(byKey({ ...ready, backup: { ...ready.backup, timer: false } }).backupSchedule.done, false);
  assert.deepEqual(byKey({ ...ready, backup: { ...ready.backup, timer: false } }).backupSchedule.detail, { schedule: 'off' });
  assert.equal(byKey({ ...ready, backup: { ...ready.backup, schedule: 'off' } }).backupSchedule.done, false);
});

test('monitoring that is off or half up is a step; when it could not be checked, nothing is claimed', () => {
  assert.equal(byKey({ ...ready, monitoring: 'partial' }).monitoring.done, false);
  assert.equal(byKey({ ...ready, monitoring: 'off' }).monitoring.done, false);
  assert.equal(byKey({ ...ready, monitoring: null }).monitoring, undefined);
});

test('updates are done with automatic updates on, or when the panel runs the newest version', () => {
  assert.equal(byKey({ ...ready, updates: { ...ready.updates, autoUpdate: 'off' } }).updates.done, false);
  assert.deepEqual(byKey({ ...ready, updates: { ...ready.updates, autoUpdate: 'off' } }).updates.detail, { channel: 'stable', auto: 'off', latest: 'v0.6.1' });
  assert.equal(byKey({ ...ready, updates: { ...ready.updates, autoUpdate: 'off', updateAvailable: false } }).updates.done, true);
  assert.equal(byKey({ ...ready, updates: { autoUpdate: null, channel: null, updateAvailable: null, latest: null } }).updates, undefined, 'no host agent data: no claim');
});

test('payment methods are a step only where billing is on', () => {
  assert.equal(byKey({ ...ready, billing: { enabled: true, gateways: 0 } }).payments.done, false);
  assert.equal(byKey({ ...ready, billing: { enabled: false, gateways: 0 } }).payments, undefined);
});

test('one staff member without two-factor brings the step back, with the count', () => {
  const s = byKey({ ...ready, twoFactor: { me: true, staffWithout: 2 } });
  assert.equal(s.staffTwoFactor.done, false);
  assert.deepEqual(s.staffTwoFactor.detail, { n: 2 });
  assert.equal(s.twoFactor.done, true, 'the viewer’s own step is separate');
});
