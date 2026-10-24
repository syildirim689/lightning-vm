import { Queue, Worker } from 'bullmq';
import { processFirewall, processOperation, reconcile } from './operations.mjs';
import { processIso } from './iso.mjs';
import { samplePower } from './power.mjs';
import { scanPorts } from './abuse.mjs';
import pg from 'pg';
import { Redis } from 'ioredis';
import { writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
// Names this copy in the heartbeat table (the container's host name in Docker).
const instance = process.env.WORKER_NAME || hostname();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
const log = (level, event, fields = {}) => console.log(JSON.stringify({ level, service: 'worker', env: process.env.APP_ENV || 'production', event, time: new Date().toISOString(), ...fields }));
pool.on('error', () => log('error', 'postgres_unavailable'));
// BullMQ 6 treats ioredis as optional; in ESM it must receive a constructed client.
const redis = new Redis({ host: process.env.REDIS_HOST || 'redis', db: Number(process.env.REDIS_DB) || 0, password: process.env.REDIS_PASSWORD, maxRetriesPerRequest: null });
// Results go to the API's notification queue; a lost notification never fails the operation.
const notifications = new Queue('notifications', { connection: redis });
const notify = (event, to, data) => notifications.add('notify', { event, to, data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v ?? '')])) },
  { attempts: 3, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: true, removeOnFail: 100 }).catch(() => log('error', 'notify_enqueue_failed', { event }));
// Reverse DNS records are written by the API (it holds the DNS settings); a lost job only leaves a PTR to fix by hand.
const rdnsQueue = new Queue('rdns', { connection: redis });
const rdns = (data) => rdnsQueue.add('rdns', data, { attempts: 5, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: true, removeOnFail: 100 }).catch(() => log('error', 'rdns_enqueue_failed', { action: data.action }));
const worker = new Worker('operations', (job) => processOperation(pool, job, log, notify, rdns), { connection: redis, concurrency: 4 });
const operations = new Queue('operations', { connection: redis });
// Firewall changes are applied one at a time, so an older job can never overwrite newer rules.
const firewallWorker = new Worker('firewalls', (job) => processFirewall(pool, job, log, notify), { connection: redis.duplicate(), concurrency: 1 });
const firewalls = new Queue('firewalls', { connection: redis });
// One firewall job at a time across every worker copy, not just within this one.
await firewalls.setGlobalConcurrency(1).catch(() => log('error', 'firewall_concurrency_unset'));
// ISO library: browsing answers the API while it waits; copies run for minutes to hours.
const isoWorker = new Worker('isos', (job) => processIso(pool, job, log, notify), { connection: redis.duplicate(), concurrency: 3, lockDuration: 120_000 });
isoWorker.on('error', (e) => log('error', 'iso_queue_error', { error: String(e?.message).slice(0, 200) }));
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
    // Firewall versions not yet applied (a lost job, or the API could not queue): queued again.
    const { rows: fw } = await pool.query(`SELECT id, firewall_version FROM servers WHERE firewall_applied_version < firewall_version AND firewall_error IS NULL
      AND vm_moref IS NOT NULL AND state NOT IN ('deleted', 'deleting', 'provisioning') AND updated_at < now() - make_interval(secs => $1)`, [Number(process.env.RECOVERY_STALE_SECONDS) || 90]);
    for (const r of fw) await firewalls.add('apply', { serverId: r.id }, { attempts: 5, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: true, jobId: `fw-${r.id}-${r.firewall_version}` });
  } catch (e) { log('error', 'recovery_failed', { code: e.code, error: String(e.message).slice(0, 200) }); }
}
const recoveryTimer = setInterval(recover, (Number(process.env.RECOVERY_SECONDS) || 60) * 1000);

// Reconciliation every RECONCILE_MINUTES (default 5) and on admin request; a Redis lock keeps one run at a time.
async function reconcileOnce() {
  if (!(await redis.set('lock:reconcile', '1', 'EX', 600, 'NX'))) return;
  try { await reconcile(pool, log); } catch (e) { log('error', 'reconcile_failed', { code: e.code }); } finally { await redis.del('lock:reconcile'); }
}
const reconcileTimer = setInterval(reconcileOnce, (Number(process.env.RECONCILE_MINUTES) || 5) * 60000);
// Energy samples (power.mjs); one copy samples at a time.
async function powerOnce(wait = false) {
  // A requested sample waits (up to a minute) for one already running; the timer just skips.
  for (let i = 0; !(await redis.set('lock:power', '1', 'EX', 240, 'NX')); i++) { if (!wait || i >= 60) return; await new Promise((r) => setTimeout(r, 1000)); }
  try { await samplePower(pool, log, notify); } catch (e) { log('error', 'power_failed', { code: e.code, error: String(e.message).slice(0, 200) }); } finally { await redis.del('lock:power'); }
}
const powerTimer = setInterval(powerOnce, (Number(process.env.POWER_SAMPLE_MINUTES) || 5) * 60000);
// "Measure now" from the energy page.
const powerWorker = new Worker('power', () => powerOnce(true), { connection: redis.duplicate(), concurrency: 1 });
// Port scan of every server address (abuse.mjs) at the admin's interval, and "scan now".
async function scanOnce(wait = false) {
  // A requested scan waits (up to a minute) for one already running; the timer just skips.
  for (let i = 0; !(await redis.set('lock:portscan', '1', 'EX', 1800, 'NX')); i++) { if (!wait || i >= 60) return; await new Promise((r) => setTimeout(r, 1000)); }
  try { await scanPorts(pool, log, notify); } catch (e) { log('error', 'port_scan_failed', { error: String(e.message).slice(0, 200) }); } finally { await redis.del('lock:portscan'); }
}
let lastScan = 0;
const scanTimer = setInterval(async () => {
  const { rows: [s] } = await pool.query("SELECT value FROM settings WHERE key = 'abuse'").catch(() => ({ rows: [] }));
  if (Date.now() - lastScan >= (Number(s?.value?.scanMinutes) || 30) * 60000) { lastScan = Date.now(); await scanOnce(); }
}, 60000);
const abuseWorker = new Worker('abuse', () => scanOnce(true), { connection: redis.duplicate(), concurrency: 1 });
const maintenance = new Worker('maintenance', () => reconcileOnce(), { connection: redis.duplicate(), concurrency: 1 });
worker.on('error', (e) => log('error', 'queue_error', { error: String(e?.message).slice(0, 200) }));

async function heartbeat() {
  try {
    if (!worker.isRunning()) throw new Error('worker stopped');
    await redis.ping();
    // One row per copy (several workers in a cluster); rows of copies gone for a day are dropped.
    await pool.query('INSERT INTO worker_heartbeats(name) VALUES ($1) ON CONFLICT(name) DO UPDATE SET last_seen=now()', [instance]);
    await pool.query("DELETE FROM worker_heartbeats WHERE last_seen < now() - interval '1 day'");
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

async function close() { if (closing) return; closing = true; clearInterval(timer); clearInterval(recoveryTimer); clearInterval(reconcileTimer); clearInterval(powerTimer); clearInterval(scanTimer); await worker.close(); await firewallWorker.close(); await isoWorker.close(); await powerWorker.close(); await abuseWorker.close(); await firewalls.close(); await rdnsQueue.close(); await maintenance.close(); await operations.close(); events.disconnect(); redis.disconnect(); await pool.end(); }
process.on('SIGTERM', close); process.on('SIGINT', close);
log('info', 'started');
