import test from 'node:test';
import assert from 'node:assert/strict';
import { serverHints } from '../dist/server-hint-rules.js';

const now = Date.parse('2026-11-23T12:00:00Z');
const daysAgo = (n) => new Date(now - n * 86_400_000).toISOString();
const base = {
  id: 's1', state: 'ready', deleting: false, createdAt: daysAgo(10),
  backups: { allowed: true, available: true, lastReady: daysAgo(2) },
  firewall: { supported: true, attached: 1 },
  rootPassword: { kept: false, allowed: true },
  snapshots: { allowed: true, old: 0 },
};
const codes = (f) => serverHints(f, now).map((h) => h.code);

test('a well kept server has nothing to say', () => {
  assert.deepEqual(codes(base), []);
});

test('no backup, or none for over 30 days: said with how old the last one is', () => {
  const never = serverHints({ ...base, backups: { ...base.backups, lastReady: null } }, now);
  assert.deepEqual(never.map((h) => [h.code, h.params.days]), [['NO_BACKUP', null]]);
  assert.deepEqual(never[0].action, { section: 'backups' });
  const old = serverHints({ ...base, backups: { ...base.backups, lastReady: daysAgo(45) } }, now);
  assert.equal(old[0].params.days, 45);
  assert.deepEqual(codes({ ...base, backups: { ...base.backups, lastReady: daysAgo(29) } }), []);
});

test('backups the viewer may not use, or a location without backups, are not pointed at', () => {
  assert.deepEqual(codes({ ...base, backups: { allowed: false, available: true, lastReady: null } }), []);
  assert.deepEqual(codes({ ...base, backups: { allowed: true, available: false, lastReady: null } }), []);
});

test('the first day after an order: no backup and the kept password are not pointed out yet; an open firewall is', () => {
  const fresh = { ...base, createdAt: daysAgo(0.5), backups: { ...base.backups, lastReady: null }, rootPassword: { kept: true, allowed: true }, firewall: { supported: true, attached: 0 } };
  assert.deepEqual(codes(fresh), ['NO_FIREWALL']);
});

test('no firewall only where a firewall can be attached', () => {
  assert.deepEqual(codes({ ...base, firewall: { supported: true, attached: 0 } }), ['NO_FIREWALL']);
  assert.deepEqual(codes({ ...base, firewall: { supported: false, attached: 0 } }), []);
});

test('the panel still keeping the root password, for a viewer who may forget it', () => {
  assert.deepEqual(codes({ ...base, rootPassword: { kept: true, allowed: true } }), ['ROOT_PASSWORD_KEPT']);
  assert.deepEqual(codes({ ...base, rootPassword: { kept: true, allowed: false } }), []);
});

test('old snapshots are counted', () => {
  const h = serverHints({ ...base, snapshots: { allowed: true, old: 3 } }, now);
  assert.deepEqual(h.map((x) => [x.code, x.params.n, x.params.days]), [['SNAPSHOTS_OLD', 3, 30]]);
});

test('nothing on a server that is not ready or is in the trash; keys name the hint and the server', () => {
  const all = { ...base, backups: { ...base.backups, lastReady: null }, firewall: { supported: true, attached: 0 }, rootPassword: { kept: true, allowed: true }, snapshots: { allowed: true, old: 1 } };
  assert.deepEqual(codes({ ...all, state: 'provisioning' }), []);
  assert.deepEqual(codes({ ...all, deleting: true }), []);
  assert.deepEqual(serverHints(all, now).map((h) => h.key), ['hint:NO_BACKUP:s1', 'hint:NO_FIREWALL:s1', 'hint:ROOT_PASSWORD_KEPT:s1', 'hint:SNAPSHOTS_OLD:s1']);
});
