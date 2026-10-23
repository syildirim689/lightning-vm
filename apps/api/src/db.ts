import { Pool } from 'pg';
import Redis from 'ioredis';
import { logEvent } from './log';

export const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000, max: 5 });
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
export async function closeConnections() { if (closing) return; closing = true; redis.disconnect(); await pool.end(); }
