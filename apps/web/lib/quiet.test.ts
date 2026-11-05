import test from 'node:test';
import assert from 'node:assert/strict';
import { clockIn, inQuietHours } from './quiet.ts';

test('quiet hours within a day and past midnight', () => {
  assert.equal(inQuietHours('12:00', '09:00', '17:00'), true);
  assert.equal(inQuietHours('17:00', '09:00', '17:00'), false);
  assert.equal(inQuietHours('23:30', '23:00', '08:00'), true);
  assert.equal(inQuietHours('07:59', '23:00', '08:00'), true);
  assert.equal(inQuietHours('08:00', '23:00', '08:00'), false);
  assert.equal(inQuietHours('12:00', '23:00', '08:00'), false);
});

test('the clock is read in the given time zone', () => {
  assert.equal(clockIn('UTC', new Date('2026-01-01T05:07:00Z')), '05:07');
  assert.equal(clockIn('Europe/Istanbul', new Date('2026-01-01T22:30:00Z')), '01:30');
});
