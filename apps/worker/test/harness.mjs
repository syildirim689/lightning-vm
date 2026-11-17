// What the step-machine tests stand on: a PostgreSQL stand-in that keeps one operation's row (step, task id, status)
// across attempts like the real table does, and an adapter stand-in behind fetch. Imported before operations.mjs, so the
// poll intervals below are read by it. No database, no network.
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'lvm-worker-test-'));
const key = randomBytes(32);
writeFileSync(join(dir, 'master_key'), key.toString('base64'));
writeFileSync(join(dir, 'token'), 'test-token');
Object.assign(process.env, { MASTER_KEY_FILE: join(dir, 'master_key'), VMWARE_SERVICE_TOKEN_FILE: join(dir, 'token'), TASK_POLL_MS: '1', SHUTDOWN_POLL_MS: '1', READINESS_POLL_MS: '1' });

// The format decrypt() reads: v1:base64(iv | ciphertext | tag), bound to its context.
export function encrypt(text, context) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(context));
  return 'v1:' + Buffer.concat([iv, c.update(text, 'utf8'), c.final(), c.getAuthTag()]).toString('base64');
}

export const ids = { op: '11111111-1111-4111-8111-111111111111', server: '22222222-2222-4222-8222-222222222222', conn: '33333333-3333-4333-8333-333333333333', owner: '44444444-4444-4444-8444-444444444444' };
export const connection = (over = {}) => ({ id: ids.conn, kind: 'vcenter', host: 'vc.example', port: 443, username: 'u', password_enc: encrypt('pw', over.id ?? ids.conn), tls_mode: 'system', ...over });

// routes: [[regex, (params, sql) => rows | { rows, rowCount }]], tried before the built-in ones. Unknown statements answer nothing.
export function fakeDb({ op = {}, server = {}, conn = connection(), routes = [] } = {}) {
  const db = { log: [],
    op: { id: ids.op, kind: 'power_on', status: 'pending', step: null, provider_task_id: null, params: {}, attempts: 0, cancel_requested: false, late: false, ...op, server_id: ids.server },
    server: { id: ids.server, name: 'web1', owner_id: ids.owner, vm_moref: 'vm-1', connection_id: conn.id, address: '203.0.113.20', price_monthly: '10.00', ...server } };
  const own = [
    [/^SELECT \* FROM operations/, () => [structuredClone(db.op)]],
    [/^SELECT step, params FROM operations/, () => [structuredClone(db.op)]],
    [/^SELECT provider_task_id, deadline_at/, () => [{ provider_task_id: db.op.provider_task_id, late: db.op.late }]],
    [/^SELECT cancel_requested/, () => [{ cancel_requested: db.op.cancel_requested, late: db.op.late }]],
    [/^SELECT deadline_at \+/, () => [{ abandoned: !!db.op.abandoned }]], // waitTask: the hard limit past the deadline
    [/FROM servers s JOIN resource_pools p ON p\.id = s\.pool_id JOIN os_images/, () => [structuredClone(db.server)]],
    [/^SELECT \* FROM vmware_connections/, () => [conn]],
    [/^UPDATE operations SET step = \$2/, (p) => { db.op.step = p[1]; }],
    [/^UPDATE operations SET provider_task_id = \$2/, (p) => { db.op.provider_task_id = p[1]; }],
    [/^UPDATE operations SET status = 'running'/, () => { db.op.status = 'running'; db.op.attempts++; }],
    [/^UPDATE operations SET status = 'succeeded'/, () => { db.op.status = 'succeeded'; db.op.step = 'done'; }],
    [/^UPDATE operations SET status = 'pending'/, (p) => { db.op.status = 'pending'; db.op.error_code = p[1]; }],
    [/^UPDATE operations SET status = \$2/, (p) => { db.op.status = p[1]; db.op.error_code = p[2]; }],
    [/^UPDATE operations SET params = params \|\| jsonb_build_object\('warnings'/, (p) => { db.op.params.warnings = [...new Set([...(db.op.params.warnings ?? []), ...JSON.parse(p[1])])]; }],
    [/^UPDATE operations SET params = params \|\| jsonb_build_object\('released'/, (p) => { Object.assign(db.op.params, { released: JSON.parse(p[1]), backups: JSON.parse(p[2]) }); }],
  ];
  db.query = async (sql, params = []) => {
    sql = sql.trim();
    db.log.push({ sql, params });
    for (const [re, fn] of [...routes, ...own]) if (re.test(sql)) { const r = (await fn(params, sql)) ?? []; return Array.isArray(r) ? { rows: r, rowCount: r.length } : r; }
    return { rows: [], rowCount: 0 };
  };
  db.connect = async () => ({ query: db.query, release() {} });
  db.ran = (re) => db.log.filter((q) => re.test(q.sql));
  return db;
}

export const fail = (code, message = '') => ({ __fail: code, message });

// handler(path, body) answers the adapter's JSON, or fail('CODE') for an error answer; calls are kept in .calls.
export function fakeAdapter(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname, body = JSON.parse(init.body);
    calls.push({ path, body, base: new URL(url).origin });
    const out = (await handler(path, body, calls)) ?? {};
    return out.__fail ? { ok: false, json: async () => ({ code: out.__fail, message: out.message }) } : { ok: true, json: async () => out };
  };
  calls.to = (path) => calls.filter((c) => c.path === path);
  return calls;
}

// One BullMQ attempt: the outcome instead of a throw. `last` makes it the final attempt.
export async function attempt(processOperation, db, { last = false, notify, rdns } = {}) {
  try { await processOperation(db, { id: db.op.id, attemptsMade: last ? 5 : 0, opts: { attempts: 6 } }, () => {}, notify, rdns); return null; }
  catch (e) { return e; }
}
