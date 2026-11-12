// The API reference is read from the controllers and joined with api-docs/: every route has words in both
// languages, every entry has a route, and the OpenAPI document is well formed.
process.env.DATABASE_URL = 'postgresql://nobody:nobody@127.0.0.1:1/none';
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = '1';
process.env.BETTER_AUTH_SECRET = 'unit-test-only-better-auth-secret-0123456789';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

const { closeConnections } = await import('../dist/main.js');
const { routesOf, reference, endpoints, openApi } = await import('../dist/api-reference.js');
const { docs } = await import('../dist/api-docs/index.js');
const { tags } = await import('../dist/api-docs/tags.js');
after(() => closeConnections());

const routes = routesOf(reference.controllers);

test('routes are read from the controllers, with their guard and permissions', () => {
  assert.ok(routes.length > 350, `only ${routes.length} routes found`);
  const keys = new Set(routes.map((r) => r.key));
  assert.equal(keys.size, routes.length, 'a route is declared twice');
  const scan = routes.find((r) => r.key === 'POST /admin/vmware/scans');
  assert.deepEqual([scan.auth, scan.permissions, scan.status], ['permission', ['vmware.manage'], 201]);
  assert.equal(routes.find((r) => r.key === 'GET /health').auth, 'public');
  assert.equal(routes.find((r) => r.key === 'GET /servers').auth, 'session');
});

test('every route has an entry and every entry a route', () => {
  const keys = new Set(routes.map((r) => r.key));
  const missing = routes.filter((r) => !docs[r.key]).map((r) => r.key);
  const orphans = Object.keys(docs).filter((k) => !keys.has(k));
  assert.deepEqual(missing, [], 'routes without words in api-docs/');
  assert.deepEqual(orphans, [], 'api-docs/ entries without a route');
});

test('entries are complete in both languages', () => {
  const problems = [];
  const text = (t, where) => { if (!t?.tr?.trim() || !t?.en?.trim()) problems.push(where); };
  for (const [key, d] of Object.entries(docs)) {
    if (!tags[d.tag]) problems.push(`${key}: unknown tag ${d.tag}`);
    text(d.summary, `${key}: summary`);
    if (d.details) text(d.details, `${key}: details`);
    if (d.returns) text(d.returns, `${key}: returns`);
    for (const f of [...(d.params ?? []), ...(d.query ?? []), ...(d.body ?? [])]) {
      if (!f.name || !f.type) problems.push(`${key}: field without name or type`);
      text(f.text, `${key}: ${f.name}`);
    }
    // Every path parameter is described.
    for (const [, p] of key.matchAll(/:(\w+)/g)) if (!(d.params ?? []).some((x) => x.name === p)) problems.push(`${key}: :${p} not described`);
  }
  assert.deepEqual(problems, []);
});

test('who may call what follows the permissions', () => {
  const customer = endpoints(['server.power']);
  assert.equal(customer.find((e) => e.key === 'POST /admin/vmware/scans').allowed, false);
  assert.equal(customer.find((e) => e.key === 'GET /servers').allowed, true);
  assert.equal(endpoints(['*']).every((e) => e.allowed), true);
});

test('the OpenAPI document has every public route with its parameters', () => {
  const spec = openApi('https://panel.example/api', 'en', endpoints(['*']));
  assert.equal(spec.openapi, '3.1.0');
  const op = spec.paths['/admin/vmware/scans/{id}/cancel']?.post;
  assert.ok(op, 'cancel route missing');
  assert.ok(op.parameters.some((p) => p.in === 'path' && p.name === 'id'));
  assert.ok(!spec.paths['/health'], 'internal routes are left out');
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const [, o] of Object.entries(ops)) {
      for (const [, name] of path.matchAll(/\{(\w+)\}/g)) assert.ok(o.parameters?.some((p) => p.in === 'path' && p.name === name), `${path}: {${name}} not declared`);
    }
  }
  const tr = openApi('https://panel.example/api', 'tr', endpoints(['*']));
  assert.notEqual(tr.paths['/servers'].get.summary, spec.paths['/servers'].get.summary);
});
