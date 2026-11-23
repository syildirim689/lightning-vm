// When a session ends and whether "stay signed in" can move it.
import test from 'node:test';
import assert from 'node:assert/strict';

const { sessionEnd } = await import('../dist/session-rules.js');

const h = 3_600_000;
const base = { createdAt: 0, expiresAt: 12 * h, ttlHours: 12, impersonated: false, directory: false, roleHours: null, remembered: true, stayedAt: null };

test('a remembered local sign-in ends when its cookie runs out, twelve hours after sign-in, and that can be renewed', () => {
  assert.deepEqual(sessionEnd({ ...base, expiresAt: 20 * h }), { at: 12 * h, kind: 'renewable', why: 'cookie' });
});

test('"stay signed in" moves the cookie end to twelve hours after the click', () => {
  assert.deepEqual(sessionEnd({ ...base, expiresAt: 30 * h, stayedAt: 11 * h }), { at: 23 * h, kind: 'renewable', why: 'cookie' });
  assert.deepEqual(sessionEnd({ ...base, expiresAt: 20 * h, stayedAt: 11 * h }), { at: 20 * h, kind: 'renewable', why: 'idle' }, 'the stored session ends first');
});

test('a sign-in without "remember me" has a browser-session cookie: only the stored session ends it', () => {
  assert.deepEqual(sessionEnd({ ...base, remembered: false, expiresAt: 40 * h }), { at: 40 * h, kind: 'renewable', why: 'idle' });
});

test('fixed ends win over renewable ones and say why', () => {
  assert.deepEqual(sessionEnd({ ...base, impersonated: true }), { at: 1 * h, kind: 'fixed', why: 'impersonation' });
  assert.deepEqual(sessionEnd({ ...base, directory: true, expiresAt: 30 * h, remembered: false }), { at: 12 * h, kind: 'fixed', why: 'directory' });
  assert.deepEqual(sessionEnd({ ...base, roleHours: 4 }), { at: 4 * h, kind: 'fixed', why: 'role' });
});

test('at the same moment the fixed end is the one told, since staying would not help', () => {
  assert.deepEqual(sessionEnd({ ...base, directory: true }), { at: 12 * h, kind: 'fixed', why: 'directory' });
});

test('a "sign in as" session is not a directory session even for a directory account', () => {
  assert.deepEqual(sessionEnd({ ...base, impersonated: true, directory: true, expiresAt: 30 * h }), { at: 1 * h, kind: 'fixed', why: 'impersonation' });
});

test('a role limit longer than the cookie leaves the cookie as the end', () => {
  assert.deepEqual(sessionEnd({ ...base, roleHours: 24, expiresAt: 30 * h }), { at: 12 * h, kind: 'renewable', why: 'cookie' });
});
