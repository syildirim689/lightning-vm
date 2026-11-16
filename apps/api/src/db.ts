import { Pool } from 'pg';
import Redis from 'ioredis';
import { logEvent } from './log';

// DB_POOL_MAX: connections per API process (default 20); keep the sum over all processes below Postgres max_connections.
const poolMax = Number.parseInt(process.env.DB_POOL_MAX ?? '', 10);
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000, max: poolMax > 0 ? poolMax : 20 });
export const redis = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: Number(process.env.REDIS_PORT) || 6379,
  db: Number(process.env.REDIS_DB) || 0,
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: 1,
  connectTimeout: 3000,
});
redis.on('error', () => logEvent('error', 'redis_unavailable'));
pool.on('error', () => logEvent('error', 'postgres_unavailable'));

let closing = false;
// Extra connections (a QueueEvents subscriber, say) close with the rest.
export const onClose: (() => Promise<unknown>)[] = [];
export async function closeConnections() { if (closing) return; closing = true; await Promise.allSettled(onClose.map((f) => f())); redis.disconnect(); await pool.end(); }

// Search as people type it: no capitals, and plain letters for Turkish ones (İ, I, ı = i; ş = s; ...), so
// "sirket" finds "Şirket". foldSql wraps a column, foldText the words searched for.
export const foldSql = (column: string) => `lower(translate(${column}, 'İIıŞşĞğÜüÖöÇç', 'iiissgguuoocc'))`;
export const foldText = (s: string) => s.replace(/[İIı]/g, 'i').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
