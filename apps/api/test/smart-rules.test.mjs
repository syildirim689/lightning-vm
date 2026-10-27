// Right-sizing, the health score and this month's cost forecast.
import test from 'node:test';
import assert from 'node:assert/strict';

const { sizing, health, monthCost } = await import('../dist/smart-rules.js');
const week = { samples: 2000, days: 7 };

test('sizing waits for enough data, then finds idle, oversized and saturated servers', () => {
  assert.equal(sizing(4, null).advice, null);
  assert.equal(sizing(4, { avg: 1, p95: 2, samples: 10, days: 1 }).advice, null);
  assert.deepEqual(sizing(4, { avg: 1, p95: 3, ...week }), { advice: 'idle', suggestedVcpu: 1 });
  assert.deepEqual(sizing(8, { avg: 6, p95: 20, ...week }), { advice: 'down', suggestedVcpu: 3 });
  assert.equal(sizing(1, { avg: 6, p95: 20, ...week }).advice, null);
  assert.deepEqual(sizing(2, { avg: 70, p95: 95, ...week }), { advice: 'up', suggestedVcpu: 4 });
  assert.equal(sizing(4, { avg: 40, p95: 60, ...week }).advice, null);
});

test('health starts at 100 and each problem lowers it, with its reason', () => {
  const ok = { state: 'ready', powerState: 'poweredOn', abuseOpen: 0, failedOps24h: 0, cpuP95: 40, advice: null };
  assert.deepEqual(health(ok), { score: 100, grade: 'good', factors: [] });
  const bad = health({ ...ok, abuseOpen: 3, failedOps24h: 1, cpuP95: 97 });
  assert.equal(bad.score, 100 - 30 - 10 - 15);
  assert.equal(bad.grade, 'poor');
  assert.deepEqual(bad.factors.map((f) => f.code), ['ABUSE_OPEN', 'OPS_FAILED', 'CPU_SATURATED']);
  assert.equal(health({ ...ok, state: 'error' }).score, 40);
});

test('the month is prorated by the days each item exists', () => {
  const now = new Date(Date.UTC(2026, 3, 16)); // April: 30 days, 15 have passed
  const c = monthCost([{ price: 30, createdAt: new Date(Date.UTC(2026, 0, 1)) }, { price: 30, createdAt: new Date(Date.UTC(2026, 3, 11)) }], now);
  assert.deepEqual(c, { monthly: 60, accrued: 15 + 5, forecast: 30 + 20, daysLeft: 15 });
});

test('labels: tags are trimmed, de-duplicated without case and limited; notes have a cap', async () => {
  const { cleanLabels } = await import('../dist/smart-rules.js');
  assert.deepEqual(cleanLabels({ tags: [' web ', 'Web', 'prod  db', ''], notes: ' hi ' }), { tags: ['Web', 'prod db'], notes: 'hi' });
  assert.deepEqual(cleanLabels({ tags: ['İstanbul-1'] }), { tags: ['İstanbul-1'], notes: '' });
  assert.deepEqual(cleanLabels({ tags: ['-bad'] }), { fields: { tags: 'INVALID_TAG' } });
  assert.deepEqual(cleanLabels({ tags: [...Array(11)].map((_, i) => `t${i}`) }), { fields: { tags: 'TOO_MANY' } });
  assert.deepEqual(cleanLabels({ tags: 'web', notes: 'x'.repeat(2001) }), { fields: { tags: 'INVALID_VALUE', notes: 'TOO_LONG' } });
});

test('a power schedule needs an action, weekdays, a time and a real time zone', async () => {
  const { cleanSchedule } = await import('../dist/smart-rules.js');
  assert.deepEqual(cleanSchedule({ action: 'shutdown', days: [5, 1, 1, '3'], time: '20:30', timezone: 'Europe/Istanbul' }),
    { action: 'shutdown', days: [1, 3, 5], time: '20:30', timezone: 'Europe/Istanbul', enabled: true });
  assert.deepEqual(cleanSchedule({ action: 'reset', days: [0], time: '24:00', timezone: 'Mars/Base' }),
    { fields: { action: 'INVALID_VALUE', days: 'REQUIRED', time: 'INVALID_VALUE', timezone: 'INVALID_VALUE' } });
  assert.equal(cleanSchedule({ action: 'power_on', days: [7], time: '08:00', timezone: 'UTC', enabled: false }).enabled, false);
  assert.equal(cleanSchedule({ action: 'snapshot', days: [1], time: '02:00', timezone: 'UTC' }).keep, 3, 'three automatic snapshots by default');
  assert.deepEqual(cleanSchedule({ action: 'snapshot', days: [1], time: '02:00', timezone: 'UTC', keep: 0 }), { fields: { keep: 'OUT_OF_RANGE' } });
});

test('a GitHub .keys file: valid keys kept with fingerprints, junk lines dropped, at most 20', async () => {
  const { parseKeyList } = await import('../dist/smart-rules.js');
  const k = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMa0iBTtZu9kbSNXzg5M6pZ1rn8F1143iWq3JIcGimfn';
  const out = parseKeyList(`${k}\r\n<html>nope</html>\n\nssh-dss AAAA\n${k} laptop`);
  assert.equal(out.length, 2);
  assert.match(out[0].fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(out[0].fingerprint, out[1].fingerprint);
  assert.equal(parseKeyList(Array(30).fill(k).join('\n')).length, 20);
});

test('Alertmanager alerts become bilingual notices; resolved ones say so; at most 20', async () => {
  const { alertNotices } = await import('../dist/smart-rules.js');
  const out = alertNotices({ version: '4', alerts: [
    { status: 'firing', labels: { alertname: 'LightningWorkerHeartbeatStale', severity: 'critical' }, annotations: { summary: 'Worker iki dakikadır yaşam sinyali vermiyor / worker heartbeat older than 2 minutes' }, fingerprint: 'abc' },
    { status: 'resolved', labels: { alertname: 'DiskFull' }, annotations: { summary: 'Disk almost full' } },
  ] });
  assert.equal(out[0].titleTr, 'Kritik alarm: LightningWorkerHeartbeatStale');
  assert.equal(out[0].bodyTr, 'Worker iki dakikadır yaşam sinyali vermiyor');
  assert.equal(out[0].bodyEn, 'worker heartbeat older than 2 minutes');
  assert.equal(out[1].titleEn, 'Resolved: DiskFull');
  assert.equal(out[1].bodyTr, 'Disk almost full');
  assert.deepEqual(alertNotices({}), []);
  assert.equal(alertNotices({ alerts: Array(30).fill({ labels: { alertname: 'X' } }) }).length, 20);
});
