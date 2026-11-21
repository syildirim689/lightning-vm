import test from 'node:test';
import assert from 'node:assert/strict';
import { anchor, buildRequest, curl, exampleBody, hiddenMark, javascript, maskSecrets, notRunnable, previewRequest, python, shownBody, type Endpoint } from './api-reference.ts';

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

test('running a request: only routes meant for it, and never one the account may not call', () => {
  assert.equal(notRunnable(base), null);
  assert.equal(notRunnable({ ...base, internal: true }), 'internal');
  assert.equal(notRunnable({ ...base, method: 'ALL' }), 'internal');
  assert.equal(notRunnable({ ...base, tokens: false }), 'panelOnly');
  assert.equal(notRunnable({ ...base, allowed: false }), 'notAllowed');
  assert.equal(notRunnable({ ...base, tokens: false, allowed: false }), 'panelOnly');
});

test('running a request: it is built from the documented route alone, and shown as it is sent', () => {
  const input = { params: { id: 'a1b2' }, query: {}, body: '{ "action": "power_on" }', idempotencyKey: 'try-0123456789' };
  const built = buildRequest(base, input);
  assert.deepEqual(built.request, { method: 'POST', url: '/api/servers/a1b2/actions', headers: { 'X-Lightning-Try': '1', 'Content-Type': 'application/json', 'X-Lightning-CSRF': '1', 'Idempotency-Key': 'try-0123456789' }, body: '{"action":"power_on"}' });
  assert.equal(previewRequest(built.request!, '(your session)'),
    'POST /api/servers/a1b2/actions\nX-Lightning-Try: 1\nContent-Type: application/json\nX-Lightning-CSRF: 1\nIdempotency-Key: try-0123456789\nCookie: (your session)\n\n{\n  "action": "power_on"\n}');
  // A path value stays one segment of this route: nothing typed there reaches another address.
  for (const [id, url] of [['../../admin/users', '/api/servers/..%2F..%2Fadmin%2Fusers/actions'], ['a b?x=1#y', '/api/servers/a%20b%3Fx%3D1%23y/actions'], ['https://evil.example/', '/api/servers/https%3A%2F%2Fevil.example%2F/actions']]) {
    assert.equal(buildRequest(base, { ...input, params: { id } }).request!.url, url);
  }
  for (const id of ['', '   ', '.', '..', 'x'.repeat(201), 'a\nb', 'a\u0000b']) assert.equal(buildRequest(base, { ...input, params: { id } }).problems![0].field, 'id', JSON.stringify(id));
  // What is missing or broken is named, and then nothing is built.
  assert.deepEqual(buildRequest(base, { params: {}, query: {}, body: '{oops' }).problems, [{ field: 'id', code: 'REQUIRED' }, { field: 'body', code: 'INVALID_JSON' }, { field: 'Idempotency-Key', code: 'REQUIRED' }]);
  // A GET: no body, no header beyond what the browser adds; only the documented query fields, the required ones asked for.
  const list: Endpoint = { ...base, key: 'GET /servers', method: 'GET', path: '/servers', body: undefined, idempotencyKey: undefined,
    query: [{ name: 'search', type: 'string', text: { tr: '', en: '' } }, { name: 'poolId', type: 'uuid', required: true, text: { tr: '', en: '' } }] };
  assert.deepEqual(buildRequest(list, { params: {}, query: { search: ' a&b=c ', poolId: 'p1', role: 'admin' }, body: '{"ignored":true}' }).request, { method: 'GET', url: '/api/servers?search=a%26b%3Dc&poolId=p1', headers: { 'X-Lightning-Try': '1' } });
  assert.deepEqual(buildRequest(list, { params: {}, query: {}, body: '' }).problems, [{ field: 'poolId', code: 'REQUIRED' }]);
  // A change without a body still carries the header the API asks of every change.
  assert.deepEqual(buildRequest({ ...base, method: 'DELETE', path: '/projects/:id', idempotencyKey: undefined }, { params: { id: 'p' }, query: {}, body: '' }).request, { method: 'DELETE', url: '/api/projects/p', headers: { 'X-Lightning-Try': '1', 'X-Lightning-CSRF': '1' } });
});

test('running a request: what looks like a secret in an answer is not shown', () => {
  const jwt = `eyJhbGciOiJIUzI1NiJ9.${'a'.repeat(20)}.${'b'.repeat(20)}`;
  const answer = { id: 'x', name: 'laptop', token: 'lvm_abcdefghijklmnopqrstuvwxyz', passwordSet: true, tokenCount: 3, password: '', secret: null,
    nested: { rootPassword: 'hunter2hunter2', apiKey: 'k', note: 'lvm_abcdefghijklmnopqrstuvwxyz012345', list: ['plain', 'whsec_0123456789abcdef', jwt] },
    credentials: { username: 'svc', anything: 'x' }, backupCodes: ['1111', '2222'], pem: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----', code: 'QUOTA_EXCEEDED', message: 'Quota exceeded' };
  const m = maskSecrets(answer);
  assert.deepEqual(m.value, { id: 'x', name: 'laptop', token: hiddenMark, passwordSet: true, tokenCount: 3, password: '', secret: null,
    nested: { rootPassword: hiddenMark, apiKey: hiddenMark, note: hiddenMark, list: ['plain', hiddenMark, hiddenMark] },
    credentials: { username: hiddenMark, anything: hiddenMark }, backupCodes: [hiddenMark, hiddenMark], pem: hiddenMark, code: 'QUOTA_EXCEEDED', message: 'Quota exceeded' });
  assert.equal(m.hidden, 11);
  assert.deepEqual(maskSecrets([{ a: 1 }, 'x']).value, [{ a: 1 }, 'x']);
  // The body as shown: JSON pretty and masked; plain text masked by shape; anything else not shown at all.
  const shown = shownBody('application/json; charset=utf-8', JSON.stringify({ token: 'lvm_abcdefghijklmnopqrstuvwxyz', ok: true }), false);
  assert.deepEqual([shown.kind, shown.hidden, shown.text.includes('lvm_'), shown.text.includes('"ok": true')], ['json', 1, false, true]);
  const text = shownBody('text/plain', 'key lvm_abcdefghijklmnopqrstuvwxyz and sk_live_0123456789abcdef end', false);
  assert.deepEqual([text.kind, text.hidden, text.text], ['text', 2, `key ${hiddenMark} and ${hiddenMark} end`]);
  // A cut-off or broken JSON body cannot be searched by name: none of it is shown. Nor is a page of HTML.
  assert.deepEqual(shownBody('application/json', '{"password":"hunter2hunter2","rest":"…', true), { kind: 'other', text: '', hidden: 0 });
  assert.deepEqual(shownBody('application/json', '{"password":"hunter2hunter2"', false), { kind: 'other', text: '', hidden: 0 });
  assert.deepEqual(shownBody('text/html; charset=utf-8', '<h1>Bad Gateway</h1>', false), { kind: 'other', text: '', hidden: 0 });
  assert.deepEqual(shownBody('application/pdf', '%PDF-1.7 …', false), { kind: 'other', text: '', hidden: 0 });
  assert.deepEqual(shownBody('application/json', '', false), { kind: 'empty', text: '', hidden: 0 });
});
