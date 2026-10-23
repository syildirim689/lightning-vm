import { Worker } from 'bullmq';
import pg from 'pg';
import { Redis } from 'ioredis';
import { writeFile } from 'node:fs/promises';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
const log = (level, event) => console.log(JSON.stringify({ level, service: 'worker', event, time: new Date().toISOString() }));
pool.on('error', () => log('error', 'postgres_unavailable'));
// BullMQ 6 treats ioredis as optional; in ESM it must receive a constructed client.
const redis = new Redis({ host: process.env.REDIS_HOST || 'redis', password: process.env.REDIS_PASSWORD, maxRetriesPerRequest: null });
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
async function close() { if (closing) return; closing = true; clearInterval(timer); await worker.close(); redis.disconnect(); await pool.end(); }
process.on('SIGTERM', close); process.on('SIGINT', close);
log('info', 'started');
