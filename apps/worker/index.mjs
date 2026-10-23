import { Worker } from 'bullmq';
import pg from 'pg';
import { Redis } from 'ioredis';
import { writeFile } from 'node:fs/promises';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
const log = (level, event) => console.log(JSON.stringify({ level, service: 'worker', event, time: new Date().toISOString() }));
pool.on('error', () => log('error', 'postgres_unavailable'));
// BullMQ 6 treats ioredis as optional; in ESM it must receive a constructed client.
const redis = new Redis({ host: process.env.REDIS_HOST || 'redis', db: Number(process.env.REDIS_DB) || 0, password: process.env.REDIS_PASSWORD, maxRetriesPerRequest: null });
const worker = new Worker('operations', async job => {
  log('warn', 'unsupported_operation');
  throw new Error('VMware provisioning is not implemented; operation rejected');
}, { connection: redis, concurrency: 1 });
worker.on('error', () => log('error', 'queue_error'));
worker.on('failed', () => log('error', 'operation_failed'));
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

async function close() { if (closing) return; closing = true; clearInterval(timer); await worker.close(); events.disconnect(); redis.disconnect(); await pool.end(); }
process.on('SIGTERM', close); process.on('SIGINT', close);
log('info', 'started');
