import { Queue, Worker } from 'bullmq';
import { processOperation, reconcile } from './operations.mjs';
import pg from 'pg';
import { Redis } from 'ioredis';
import { writeFile } from 'node:fs/promises';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
const log = (level, event, fields = {}) => console.log(JSON.stringify({ level, service: 'worker', event, time: new Date().toISOString(), ...fields }));
pool.on('error', () => log('error', 'postgres_unavailable'));
// BullMQ 6 treats ioredis as optional; in ESM it must receive a constructed client.
const redis = new Redis({ host: process.env.REDIS_HOST || 'redis', db: Number(process.env.REDIS_DB) || 0, password: process.env.REDIS_PASSWORD, maxRetriesPerRequest: null });
const worker = new Worker('operations', (job) => processOperation(pool, job, log), { connection: redis, concurrency: 4 });
const operations = new Queue('operations', { connection: redis });
const jobOptions = { attempts: 6, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: true };

// Recovery: an operation still open in PostgreSQL but without a queued job (Redis lost it, the API
// could not enqueue, or a crash between commit and enqueue) is queued again. The job id is the
// operation id, so an operation that still has a live job is not queued twice.
async function recover() {
  try {
    const { rows } = await pool.query("SELECT id FROM operations WHERE status IN ('pending', 'running') AND updated_at < now() - make_interval(secs => $1)",
      [Number(process.env.RECOVERY_STALE_SECONDS) || 90]);
    let count = 0;
    for (const { id } of rows) {
      if (await operations.getJob(id)) continue; // still queued, delayed for a retry or running (a long wait)
      await operations.add('operation', {}, { ...jobOptions, jobId: id });
      count++;
    }
    if (count) log('info', 'operations_recovered', { count });
  } catch { log('error', 'recovery_failed'); }
}
const recoveryTimer = setInterval(recover, (Number(process.env.RECOVERY_SECONDS) || 60) * 1000);

// Reconciliation every RECONCILE_MINUTES (default 5) and on admin request; a Redis lock keeps one run at a time.
async function reconcileOnce() {
  if (!(await redis.set('lock:reconcile', '1', 'EX', 600, 'NX'))) return;
  try { await reconcile(pool, log); } catch (e) { log('error', 'reconcile_failed', { code: e.code }); } finally { await redis.del('lock:reconcile'); }
}
const reconcileTimer = setInterval(reconcileOnce, (Number(process.env.RECONCILE_MINUTES) || 5) * 60000);
const maintenance = new Worker('maintenance', () => reconcileOnce(), { connection: redis.duplicate(), concurrency: 1 });
worker.on('error', () => log('error', 'queue_error'));

async function heartbeat() {
  try {
    if (!worker.isRunning()) throw new Error('worker stopped');
    await redis.ping();
    await pool.query("INSERT INTO worker_heartbeats(name) VALUES ('default') ON CONFLICT(name) DO UPDATE SET last_seen=now()");
    await writeFile('/tmp/lightning-worker-heartbeat', String(Date.now()));
  } catch { log('error', 'heartbeat_failed'); }
}
await heartbeat();
const timer = setInterval(heartbeat, 30000);
let closing = false;

// Console gateway events (Redis stream) become audit records. Consumer-group acks make each event
// land once; entries left unacked by a crash are re-read first on the next start.
const events = redis.duplicate(); // XREADGROUP blocks, so it gets its own connection
const outcomes = { opened: 'success', closed: 'success', failed: 'failure', denied: 'denied' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ensureGroup = () => events.xgroup('CREATE', 'console:events', 'audit', '0', 'MKSTREAM').catch((e) => { if (!String(e).includes('BUSYGROUP')) throw e; });
async function copyConsoleEvents() {
  let cursor = '0';
  while (!closing) {
    try {
      if (cursor === '0') await ensureGroup(); // also after Redis lost the stream or the group
      const res = await events.xreadgroup('GROUP', 'audit', 'worker', 'COUNT', 100, 'BLOCK', 5000, 'STREAMS', 'console:events', cursor);
      const entries = res?.[0]?.[1] ?? [];
      if (cursor === '0' && entries.length === 0) cursor = '>';
      for (const [id, kv] of entries) {
        const f = {};
        for (let i = 0; i < kv.length; i += 2) f[kv[i]] = kv[i + 1];
        const { event, userId, vm, at, ...metadata } = f;
        await pool.query('INSERT INTO audit_events (actor_id, action, outcome, resource_id, metadata, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
          [uuid.test(userId ?? '') ? userId : null, `console.${event}`, outcomes[event] ?? 'failure', vm || null, metadata, at ?? new Date().toISOString()]);
        await events.xack('console:events', 'audit', id);
      }
    } catch {
      log('error', 'console_events_failed');
      cursor = '0'; // unacked entries stay pending; read them again rather than only new ones
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
copyConsoleEvents();

async function close() { if (closing) return; closing = true; clearInterval(timer); clearInterval(recoveryTimer); clearInterval(reconcileTimer); await worker.close(); await maintenance.close(); await operations.close(); events.disconnect(); redis.disconnect(); await pool.end(); }
process.on('SIGTERM', close); process.on('SIGINT', close);
log('info', 'started');
