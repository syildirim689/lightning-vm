// Quiet hours: windows inside a day and across midnight, in the person's time zone; input checked.
import test from 'node:test';
import assert from 'node:assert/strict';

const { inQuietHours, validQuietHours, alwaysSent } = await import('../dist/quiet-hours.js');

test('a window across midnight, in the given time zone', () => {
  const q = { start: '22:00', end: '07:00', tz: 'Europe/Istanbul' }; // UTC+3
  assert.equal(inQuietHours(q, new Date('2026-10-26T20:30:00Z')), true);  // 23:30 there
  assert.equal(inQuietHours(q, new Date('2026-10-26T03:59:00Z')), true);  // 06:59
  assert.equal(inQuietHours(q, new Date('2026-10-26T04:00:00Z')), false); // 07:00
  assert.equal(inQuietHours(q, new Date('2026-10-26T12:00:00Z')), false);
  assert.equal(inQuietHours(null), false);
});

test('a window inside the day', () => {
  const q = { start: '12:00', end: '13:30', tz: 'UTC' };
  assert.equal(inQuietHours(q, new Date('2026-10-26T12:15:00Z')), true);
  assert.equal(inQuietHours(q, new Date('2026-10-26T13:30:00Z')), false);
});

test('input: times as HH:MM, a real time zone, start and end differ; security notices are never held', () => {
  assert.deepEqual(validQuietHours({ start: '23:00', end: '07:00', tz: 'Europe/Istanbul' }), { start: '23:00', end: '07:00', tz: 'Europe/Istanbul' });
  assert.equal(validQuietHours(null), null);
  for (const bad of [{ start: '24:00', end: '07:00', tz: 'UTC' }, { start: '07:00', end: '07:00', tz: 'UTC' }, { start: '07:00', end: '08:00', tz: 'Mars/Base' }, 'x'])
    assert.equal(validQuietHours(bad), 'invalid');
  assert.equal(alwaysSent('auth.sign_in'), true);
  assert.equal(alwaysSent('server.ready'), false);
});
