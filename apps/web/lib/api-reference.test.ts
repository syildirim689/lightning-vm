import test from 'node:test';
import assert from 'node:assert/strict';
import { anchor, curl, exampleBody, javascript, python, type Endpoint } from './api-reference.ts';

const base: Endpoint = { key: 'POST /servers/:id/actions', method: 'POST', path: '/servers/:id/actions', tag: 'servers', auth: 'session', permissions: [], status: 200,
  allowed: true, summary: { tr: 'Güç', en: 'Power' }, idempotencyKey: true,
  body: [{ name: 'action', type: 'string', required: true, values: ['power_on', 'shutdown'], text: { tr: 'İşlem', en: 'Action' } }] };

test('example code fills path parameters, the idempotency header and a body from the required fields', () => {
  assert.deepEqual(exampleBody(base), { action: 'power_on' });
  const c = curl(base);
  assert.match(c, /curl -X POST "\$LVM_URL\/servers\/\$id\/actions"/);
  assert.match(c, /Idempotency-Key: \$\(uuidgen\)/);
  assert.match(c, /-d '\{"action":"power_on"\}'/);
  assert.match(javascript(base), /\$\{process\.env\.LVM_URL\}\/servers\/\$\{id\}\/actions/);
  assert.match(python(base), /requests\.post\(\n {4}f"\{LVM_URL\}\/servers\/\{id\}\/actions"/);
  assert.match(python(base), /^import uuid/);
});

test('nested fields become nested objects; a written example wins; GET has no body', () => {
  const nested = { ...base, body: [{ name: 'tls.mode', type: 'string', required: true, values: ['system'], text: { tr: '', en: '' } }] };
  assert.deepEqual(exampleBody(nested), { tls: { mode: 'system' } });
  assert.deepEqual(exampleBody({ ...base, example: { a: 1 } }), { a: 1 });
  const get = { ...base, method: 'GET', path: '/servers', body: undefined, idempotencyKey: undefined };
  assert.equal(curl(get), 'curl "$LVM_URL/servers" \\\n  -H "Authorization: Bearer $LVM_TOKEN"');
  assert.equal(anchor(get), 'get-servers');
  assert.equal(anchor(base), 'post-servers-id-actions');
});
