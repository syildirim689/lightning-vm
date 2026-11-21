// The periodic digest's rules at their edges: when the next one is due (weekly and daily, zones with half-hour
// offsets, both clock changes, a moment exactly on the hour), what opened and closed between two digests, when a
// digest is empty, the words in both languages, and that every finding the panel can raise has a line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { nextSlot, validSchedule, changes, seenOf, isEmpty, digestText, labels, labelOf, defaultSchedule, MAX_SEEN } = await import('../dist/digest-rules.js');
const { validTimeZone } = await import('../dist/time-zone.js');

const at = (iso) => Date.parse(iso);
const iso = (t) => new Date(t).toISOString();
const weekly = (day, hour, timezone = 'UTC') => ({ frequency: 'weekly', day, hour, timezone });
const daily = (hour, timezone = 'UTC') => ({ frequency: 'daily', day: 1, hour, timezone });

test('weekly: the next time the clock passes the hour on the weekday, strictly after the moment asked', () => {
  // 2026-11-16 is a Monday.
  assert.equal(iso(nextSlot(weekly(1, 8), at('2026-11-16T07:59:00Z'))), '2026-11-16T08:00:00.000Z');
  assert.equal(iso(nextSlot(weekly(1, 8), at('2026-11-16T08:00:00Z'))), '2026-11-23T08:00:00.000Z', 'exactly on the hour: the next week, not again now');
  assert.equal(iso(nextSlot(weekly(1, 8), at('2026-11-16T08:00:01Z'))), '2026-11-23T08:00:00.000Z');
  assert.equal(iso(nextSlot(weekly(1, 8), at('2026-11-16T12:00:00Z'))), '2026-11-23T08:00:00.000Z', 'later the same day is not due again');
  assert.equal(iso(nextSlot(weekly(7, 23), at('2026-11-16T12:00:00Z'))), '2026-11-22T23:00:00.000Z');
  assert.equal(iso(nextSlot(weekly(2, 0), at('2026-11-16T23:59:59Z'))), '2026-11-17T00:00:00.000Z');
});

test('the hour is the person\'s own: other zones, also those offset by half an hour', () => {
  assert.equal(iso(nextSlot(weekly(1, 8, 'Europe/Istanbul'), at('2026-11-15T12:00:00Z'))), '2026-11-16T05:00:00.000Z');
  assert.equal(iso(nextSlot(weekly(1, 8, 'America/New_York'), at('2026-11-16T05:00:00Z'))), '2026-11-16T13:00:00.000Z');
  assert.equal(iso(nextSlot(weekly(1, 8, 'Asia/Kolkata'), at('2026-11-15T12:00:00Z'))), '2026-11-16T02:30:00.000Z', 'UTC+5:30');
  assert.equal(iso(nextSlot(daily(6, 'Asia/Kathmandu'), at('2026-11-16T00:00:00Z'))), '2026-11-16T00:15:00.000Z', 'UTC+5:45');
  // Monday 00:00 in Auckland is still Sunday in UTC.
  assert.equal(iso(nextSlot(weekly(1, 0, 'Pacific/Auckland'), at('2026-11-14T00:00:00Z'))), '2026-11-15T11:00:00.000Z');
});

test('daily: once a day, at the hour', () => {
  assert.equal(iso(nextSlot(daily(8), at('2026-11-16T07:00:00Z'))), '2026-11-16T08:00:00.000Z');
  assert.equal(iso(nextSlot(daily(8), at('2026-11-16T08:00:00Z'))), '2026-11-17T08:00:00.000Z');
  assert.equal(iso(nextSlot(daily(0), at('2026-11-16T08:00:00Z'))), '2026-11-17T00:00:00.000Z');
  // Followed for a month: always 24 hours apart in a zone without a clock change.
  let t = at('2026-11-01T00:00:00Z');
  for (let i = 0; i < 30; i++) { const n = nextSlot(daily(9, 'Europe/Istanbul'), t); if (i) assert.equal(n - t, 86_400_000); t = n; }
});

test('clock changes: an hour that does not exist is the first moment after the gap; one that comes twice is taken once', () => {
  // Berlin, 29 March 2026: 02:00 becomes 03:00. A digest set for 02:00 goes out at 03:00 local (01:00 UTC).
  assert.equal(iso(nextSlot(daily(2, 'Europe/Berlin'), at('2026-03-28T12:00:00Z'))), '2026-03-29T01:00:00.000Z');
  assert.equal(iso(nextSlot(weekly(7, 2, 'Europe/Berlin'), at('2026-03-23T12:00:00Z'))), '2026-03-29T01:00:00.000Z');
  // And the day after it is 02:00 again (00:00 UTC in summer time).
  assert.equal(iso(nextSlot(daily(2, 'Europe/Berlin'), at('2026-03-29T01:00:00Z'))), '2026-03-30T00:00:00.000Z');
  // Berlin, 25 October 2026: 03:00 becomes 02:00, so 02:00 comes twice (00:00 and 01:00 UTC). Only the first counts.
  const first = nextSlot(daily(2, 'Europe/Berlin'), at('2026-10-24T12:00:00Z'));
  assert.equal(iso(first), '2026-10-25T00:00:00.000Z');
  assert.equal(iso(nextSlot(daily(2, 'Europe/Berlin'), first)), '2026-10-26T01:00:00.000Z', 'not the second 02:00 an hour later');
  // A weekly digest stays on its local hour across the change.
  assert.equal(iso(nextSlot(weekly(1, 8, 'Europe/Berlin'), at('2026-10-19T06:00:00Z'))), '2026-10-26T07:00:00.000Z');
});

test('a schedule is checked field by field; what is left out takes the default (Monday 08:00, weekly)', () => {
  assert.deepEqual(validSchedule({ timezone: 'Europe/Istanbul' }, validTimeZone), { ...defaultSchedule, timezone: 'Europe/Istanbul' });
  assert.deepEqual(defaultSchedule, { frequency: 'weekly', day: 1, hour: 8 });
  assert.deepEqual(validSchedule({ frequency: 'daily', day: 7, hour: 23, timezone: 'UTC' }, validTimeZone), { frequency: 'daily', day: 7, hour: 23, timezone: 'UTC' });
  assert.deepEqual(validSchedule({ frequency: 'hourly', day: 0, hour: 24, timezone: 'Mars/Olympus' }, validTimeZone), { fields: { frequency: 'INVALID_VALUE', day: 'INVALID_VALUE', hour: 'INVALID_VALUE', timezone: 'INVALID_VALUE' } });
  assert.deepEqual(validSchedule({ day: '1', hour: 8.5, timezone: 'UTC' }, validTimeZone), { fields: { day: 'INVALID_VALUE', hour: 'INVALID_VALUE' } });
  assert.deepEqual(validSchedule(null, validTimeZone), { fields: { timezone: 'INVALID_VALUE' } });
});

const f = (key, code = 'IDLE_SERVER', severity = 'info', params = { name: key, avg: 1 }) => ({ key, code, severity, params });

test('opened and closed are told against what was seen at the last digest; the first digest compares with nothing', () => {
  assert.deepEqual(changes(null, [f('a')]), { opened: [], closed: [] });
  const now = [f('a'), f('c')];
  const r = changes(seenOf([f('a'), f('b')]), now);
  assert.deepEqual(r.opened.map((x) => x.key), ['c']);
  assert.deepEqual(r.closed.map((x) => x.key), ['b']);
  assert.deepEqual(r.closed[0], { key: 'b', code: 'IDLE_SERVER', params: { name: 'b', avg: 1 } }, 'a closed finding keeps the words it had');
  assert.deepEqual(changes([], []), { opened: [], closed: [] });
  assert.equal(seenOf(Array.from({ length: MAX_SEEN + 50 }, (_, i) => f(`k${i}`))).length, MAX_SEEN);
});

const staff = (over = {}) => ({ kind: 'staff', since: '2026-11-09T08:00:00.000Z', first: false, findings: [], opened: [], closed: [], risk: null, failedOperations: null, capacity: [], ...over });
const customer = (over = {}) => ({ kind: 'customer', since: '2026-11-09T08:00:00.000Z', first: false, findings: [], opened: [], closed: [], forecast: [], renewal: null, ...over });

test('a digest with nothing to say is empty; any one thing makes it worth sending', () => {
  assert.equal(isEmpty(staff()), true);
  assert.equal(isEmpty(staff({ risk: { accounts: 0, top: [] }, failedOperations: 0 })), true);
  assert.equal(isEmpty(staff({ findings: [f('a', 'CONNECTION_DOWN', 'danger')] })), false);
  assert.equal(isEmpty(staff({ findings: [f('a', 'POOL_FILLING', 'warning')] })), false);
  // A standing note alone is not a weekly message: listed by the first digest, and when it is new.
  assert.equal(isEmpty(staff({ findings: [f('a')] })), true);
  assert.equal(isEmpty(staff({ findings: [f('a')], first: true })), false);
  assert.equal(isEmpty(staff({ findings: [f('a')], opened: [f('a')] })), false);
  assert.equal(isEmpty(customer({ findings: [f('2fa', 'ENABLE_2FA')] })), true);
  assert.equal(isEmpty(staff({ closed: [{ key: 'a', code: 'WORKER_DOWN' }] })), false, 'something closed is news');
  assert.equal(isEmpty(staff({ failedOperations: 2 })), false);
  assert.equal(isEmpty(staff({ risk: { accounts: 1, top: [] } })), false);
  assert.equal(isEmpty(customer()), true);
  assert.equal(isEmpty(customer({ forecast: [{ currency: 'TRY', accrued: '0.00', forecast: '0.00', budget: null, state: null }] })), true, 'a month that costs nothing is nothing to report');
  assert.equal(isEmpty(customer({ forecast: [{ currency: 'TRY', accrued: '12.00', forecast: '80.00', budget: null, state: null }] })), false);
  assert.equal(isEmpty(customer({ renewal: { date: '2026-11-20', amount: '80.00', currency: 'TRY' } })), false);
});

test('the staff digest in words: findings by severity, changes, risk, failed operations, capacity', () => {
  const pool = f('pool:1:vcpu', 'POOL_NEARLY_FULL', 'danger', { pool: 'Istanbul', resource: 'vcpu', used: 93, unit: '' });
  const forecast = f('forecast:1', 'POOL_FORECAST', 'warning', { pool: 'Istanbul', days: 12, resource: 'memoryMb' });
  const d = staff({ findings: [f('x', 'MAIL_NOT_CONFIGURED', 'info', {}), forecast, pool], opened: [pool], closed: [{ key: 'w', code: 'WORKER_DOWN', params: { minutes: 7 } }],
    risk: { accounts: 2, top: [{ email: 'a@example.test', amount: '240.00', currency: 'TRY' }] }, failedOperations: 3, capacity: [pool, forecast] });
  const en = digestText('en', d);
  assert.equal(en.title, 'Panel digest: 3 open findings');
  assert.deepEqual(en.body.split('\n'), [
    'Since 2026-11-09.',
    'Open findings: 1 critical, 1 warning, 1 informational',
    '(!) Istanbul: vCPU 93% used',
    '- Istanbul: at this rate memory is full in about 12 days',
    '- Outgoing e-mail is not set up',
    'Opened since the last digest: 1',
    '+ Istanbul: vCPU 93% used',
    'Closed since the last digest: 1',
    '✓ The background worker has not answered for 7 minutes',
    'Accounts at payment risk: 2',
    '- a@example.test: 240.00 TRY',
    'Failed operations: 3',
    'Capacity:',
    '- Istanbul: vCPU 93% used',
    '- Istanbul: at this rate memory is full in about 12 days',
  ]);
  const tr = digestText('tr', d, true);
  assert.equal(tr.title, 'Önizleme: Panel özeti: 3 açık bulgu');
  assert.match(tr.body, /^2026-11-09 tarihinden bugüne\.\nAçık bulgular: 1 kritik, 1 uyarı, 1 bilgi\n\(!\) Istanbul: vCPU %93 dolu/);
  assert.match(tr.body, /Ödeme riski altındaki hesaplar: 2\n- a@example\.test: 240\.00 TRY\nBaşarısız işlemler: 3\nKapasite:/);
  // The first digest does not speak of changes; one with no findings says so.
  assert.doesNotMatch(digestText('en', staff({ first: true, failedOperations: 1 })).body, /last digest/);
  assert.equal(digestText('en', staff({ failedOperations: 1 })).title, 'Panel digest: no open findings');
  assert.match(digestText('en', staff({ failedOperations: 1 })).body, /No open findings\.\nNothing opened or closed since the last digest\.\nFailed operations: 1$/);
  assert.equal(digestText('en', staff({ findings: [pool] })).title, 'Panel digest: 1 open finding');
});

test('the customer digest in words: findings, the month, the renewal', () => {
  const d = customer({ first: true, findings: [f('anomaly:1', 'USAGE_ANOMALY_CPU_HIGH', 'warning', { name: 'web-1', recent: 92, usual: 20, baseline: 40 })],
    forecast: [{ currency: 'TRY', accrued: '41.50', forecast: '96.00', budget: '90.00', state: 'over' }, { currency: 'USD', accrued: '3.00', forecast: '9.00', budget: null, state: null }],
    renewal: { date: '2026-11-20', amount: '80.00', currency: 'TRY' } });
  assert.deepEqual(digestText('en', d).body.split('\n'), [
    'Since 2026-11-09.',
    'Open findings: 1 warning',
    '- web-1: CPU far above usual (92%, usually 20%)',
    'This month: 41.50 TRY so far, 96.00 TRY forecast by month end; budget 90.00 TRY (over)',
    'This month: 3.00 USD so far, 9.00 USD forecast by month end',
    'Upcoming renewal: 2026-11-20, 80.00 TRY',
  ]);
  assert.equal(digestText('tr', d).title, 'Hesap özetiniz: 1 açık bulgu');
  assert.match(digestText('tr', d).body, /Bu ay: şimdiye kadar 41\.50 TRY, ay sonu tahmini 96\.00 TRY; bütçe 90\.00 TRY \(aşılıyor\)\n.*\nYaklaşan yenileme: 2026-11-20, 80\.00 TRY$/);
});

test('long lists are cut with a count of the rest; a finding without a line still shows its code', () => {
  const many = Array.from({ length: 11 }, (_, i) => f(`k${i}`, 'IDLE_SERVER', 'info', { name: `srv-${i}`, avg: 1 }));
  const lines = digestText('en', staff({ findings: many })).body.split('\n');
  assert.equal(lines.filter((x) => x.startsWith('- srv-')).length, 8);
  assert.ok(lines.includes('… and 3 more'));
  assert.equal(labelOf('en', 'SOMETHING_NEW', {}), 'SOMETHING_NEW');
  assert.equal(typeof labelOf('tr', 'POOL_FILLING', {}), 'string', 'missing parameters do not throw');
});

test('every finding the panel can raise has a line in both languages', () => {
  const source = readFileSync(new URL('../src/insights.ts', import.meta.url), 'utf8');
  const codes = new Set([...source.matchAll(/add\((?:[^,\n]*?\? )?'([A-Z][A-Z0-9_]+)'(?: : '([A-Z][A-Z0-9_]+)')?/g)].flatMap((m) => [m[1], m[2]].filter(Boolean)));
  // Built from metric and direction, and handed over by the payment risk rules (payment-risk-rules.ts, kind).
  for (const c of ['USAGE_ANOMALY_CPU_HIGH', 'USAGE_ANOMALY_CPU_LOW', 'USAGE_ANOMALY_NETWORK_HIGH', 'CARD_EXPIRES_BEFORE_RENEWAL', 'RENEWAL_NOT_COVERED']) codes.add(c);
  assert.ok(codes.size >= 40, `only ${codes.size} codes found in insights.ts`);
  const missing = [...codes].filter((c) => !labels[c]);
  assert.deepEqual(missing, [], 'insight codes without a digest line (apps/api/src/digest-rules.ts, labels)');
  for (const [code, l] of Object.entries(labels)) for (const lang of ['tr', 'en']) assert.equal(typeof l[lang]({}), 'string', `${code} ${lang}`);
});
