// Prometheus metrics, computed from PostgreSQL and Redis at scrape time (the database is the truth).
// Labels are only admin-defined names and fixed enums, never user, server or request ids, so the
// number of series stays bounded.
import { Gauge, Histogram } from 'prom-client';
import { Queue } from 'bullmq';
import { pool, redis } from './db';
import { capacityOf } from './catalog';
import { summary } from './maintenance';

type G = Gauge<string>;
// A failed collection leaves the gauge empty ("no data"), never at a stale value.
function gauge(name: string, help: string, labelNames: string[], fill: (g: G) => Promise<void>) {
  return new Gauge({ name, help, labelNames, async collect() { this.reset(); await fill(this).catch(() => undefined); } });
}
const rows = async (sql: string) => (await pool.query(sql)).rows;

export const httpDuration = new Histogram({ name: 'lightning_api_http_request_duration_seconds', help: 'API request duration by route template',
  labelNames: ['method', 'route', 'status'], buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] });

gauge('lightning_dependency_up', 'Whether the API reaches the dependency (0 means no data, not a healthy zero)', ['dependency'], async (g) => {
  g.set({ dependency: 'postgres' }, await pool.query('SELECT 1').then(() => 1, () => 0));
  g.set({ dependency: 'redis' }, await redis.ping().then(() => 1, () => 0));
});

gauge('lightning_worker_heartbeat_age_seconds', 'Seconds since the worker last reported', [], async (g) => {
  const [r] = await rows("SELECT extract(epoch FROM now() - max(last_seen)) AS age FROM worker_heartbeats");
  if (r?.age != null) g.set(Number(r.age));
});

const queues = ['operations', 'maintenance'].map((name) => new Queue(name, { connection: redis }));
gauge('lightning_queue_jobs', 'Jobs in the queue by state', ['queue', 'state'], async (g) => {
  for (const q of queues) {
    const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
    for (const [state, n] of Object.entries(counts)) g.set({ queue: q.name, state }, n);
  }
});

gauge('lightning_operations_open', 'Open server operations by status', ['status'], async (g) => {
  for (const s of ['pending', 'running']) g.set({ status: s }, 0);
  for (const r of await rows("SELECT status, count(*)::int AS n FROM operations WHERE status IN ('pending', 'running') GROUP BY status")) g.set({ status: r.status }, r.n);
});
gauge('lightning_operations_oldest_pending_seconds', 'Age of the oldest pending operation (job waiting time)', [], async (g) => {
  const [r] = await rows("SELECT coalesce(extract(epoch FROM now() - min(created_at)), 0) AS age FROM operations WHERE status = 'pending'");
  g.set(Number(r.age));
});
gauge('lightning_operations_stuck', 'Running operations without progress for 15 minutes', [], async (g) => {
  const [r] = await rows("SELECT count(*)::int AS n FROM operations WHERE status = 'running' AND updated_at < now() - interval '15 minutes'");
  g.set(r.n);
});
gauge('lightning_operations_failed_24h', 'Operations that failed in the last 24 hours, by kind', ['kind'], async (g) => {
  for (const k of ['create', 'delete', 'power_on', 'shutdown', 'power_off', 'reset']) g.set({ kind: k }, 0);
  for (const r of await rows("SELECT kind, count(*)::int AS n FROM operations WHERE status = 'failed' AND finished_at > now() - interval '24 hours' GROUP BY kind")) g.set({ kind: r.kind }, r.n);
});

// "missing" = VMware has no such VM (no data), power = VM state, guest = OS readiness: kept apart.
gauge('lightning_servers', 'Servers by platform state, VMware power state and guest readiness', ['state', 'power', 'guest'], async (g) => {
  for (const r of await rows("SELECT state, coalesce(power_state, 'unknown') AS power, guest_ready, count(*)::int AS n FROM servers WHERE state <> 'deleted' GROUP BY 1, 2, 3"))
    g.set({ state: r.state, power: r.power, guest: r.guest_ready ? 'ready' : 'not_ready' }, r.n);
});

gauge('lightning_vmware_connection_up', 'Last discovery or reconciliation reached the ESXi/vCenter', ['connection'], async (g) => {
  for (const r of await rows('SELECT name, status FROM vmware_connections')) g.set({ connection: r.name }, r.status === 'ok' ? 1 : 0);
});
gauge('lightning_datastore_used_ratio', 'Datastore used space (0-1) from the last inventory', ['connection', 'datastore'], async (g) => {
  for (const r of await rows('SELECT c.name AS conn, d.name, d.capacity_bytes, d.free_bytes FROM vmware_datastores d JOIN vmware_connections c ON c.id = d.connection_id WHERE d.capacity_bytes > 0'))
    g.set({ connection: r.conn, datastore: r.name }, 1 - Number(r.free_bytes) / Number(r.capacity_bytes));
});
gauge('lightning_pool_capacity', 'Resource pool capacity layers', ['pool', 'resource', 'layer'], async (g) => {
  for (const p of await rows('SELECT * FROM resource_pools WHERE active')) {
    const c = await capacityOf(p);
    const set = (layer: string, v: { vcpu: number; memoryMb: number; storageGb?: number; diskGb?: number }) => {
      g.set({ pool: p.name, resource: 'vcpu', layer }, v.vcpu);
      g.set({ pool: p.name, resource: 'memory_mb', layer }, v.memoryMb);
      g.set({ pool: p.name, resource: 'storage_gb', layer }, v.storageGb ?? v.diskGb ?? 0);
    };
    set('offered', c.offered); set('reserved', c.reserved); set('available', c.available);
    set('used', { vcpu: c.used.vcpu, memoryMb: c.used.memoryMb, storageGb: c.used.storageProvisionedGb });
  }
});

gauge('lightning_console_events_24h', 'Console gateway events in the last 24 hours', ['event'], async (g) => {
  for (const e of ['opened', 'closed', 'failed', 'denied']) g.set({ event: e }, 0);
  for (const r of await rows("SELECT substr(action, 9) AS event, count(*)::int AS n FROM audit_events WHERE action LIKE 'console.%' AND created_at > now() - interval '24 hours' GROUP BY 1"))
    g.set({ event: r.event }, r.n);
});
gauge('lightning_db_connections', 'PostgreSQL connections to the panel database by state', ['state'], async (g) => {
  for (const r of await rows("SELECT coalesce(state, 'other') AS state, count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() GROUP BY 1")) g.set({ state: r.state }, r.n);
});

const at = (t?: string) => (t ? Date.parse(t) / 1000 : 0);
gauge('lightning_backup_last_success_timestamp_seconds', 'Time of the last successful backup (0: none)', [], async (g) => { g.set(at(summary().lastSuccessfulBackup?.time)); });
gauge('lightning_maintenance_last_ok', 'Whether the last backup/update/restore succeeded (absent: never ran)', ['kind'], async (g) => {
  const s = summary();
  for (const [kind, run] of [['backup', s.lastBackup], ['update', s.lastUpdate], ['restore', s.lastRestore]] as const)
    if (run) g.set({ kind }, run.status === 'ok' ? 1 : 0);
});
gauge('lightning_info', 'Running version', ['version'], async (g) => { g.set({ version: process.env.APP_VERSION || 'dev' }, 1); });
