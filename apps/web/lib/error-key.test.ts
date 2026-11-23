import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { errorKey, FALLBACK_KEYS } from './error-key.ts';

const known = (c: string) => ['NOT_FOUND', 'NETWORK', 'SESSION_FIXED'].includes(c);

test('a code with a sentence is said as it is', () => {
  assert.deepEqual(errorKey({ code: 'NOT_FOUND', status: 404 }, known), { key: 'NOT_FOUND' });
  assert.deepEqual(errorKey({ code: 'NETWORK' }, known), { key: 'NETWORK' });
});

test('a code without a sentence is named, never turned into "unknown"', () => {
  assert.deepEqual(errorKey({ code: 'BRAND_NEW_CODE', status: 409 }, known), { key: 'UNTRANSLATED', values: { code: 'BRAND_NEW_CODE' } });
  assert.equal((errorKey({ code: 'X'.repeat(200) }, known).values!.code as string).length, 60);
});

test('an answer without a code gives its HTTP status; only nothing at all is unknown', () => {
  assert.deepEqual(errorKey({ code: 'UNKNOWN', status: 502 }, known), { key: 'SERVER_STATUS', values: { status: 502 } });
  assert.deepEqual(errorKey({ code: 'UNKNOWN', status: 413 }, known), { key: 'CLIENT_STATUS', values: { status: 413 } });
  assert.deepEqual(errorKey({ code: 'UNKNOWN' }, known), { key: 'UNKNOWN' });
  assert.deepEqual(errorKey(null, known), { key: 'UNKNOWN' });
  assert.deepEqual(errorKey(new Error('boom'), known), { key: 'UNKNOWN' });
});

test('every fallback sentence exists in both languages with the same placeholders', () => {
  for (const lang of ['en', 'tr']) {
    const errors = JSON.parse(readFileSync(new URL(`../messages/${lang}.json`, import.meta.url), 'utf8')).errors as Record<string, string>;
    for (const k of FALLBACK_KEYS) assert.ok(errors[k]?.trim(), `${lang}: errors.${k}`);
    assert.match(errors.UNTRANSLATED, /\{code\}/);
    assert.match(errors.SERVER_STATUS, /\{status\}/);
    assert.match(errors.CLIENT_STATUS, /\{status\}/);
  }
});
