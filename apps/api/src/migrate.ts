import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';

const dir = join(__dirname, '..', 'migrations');
const lockId = 7_301_204; // arbitrary constant: one migrator at a time across containers

// Applies migrations/NNN_name.sql in order, each in its own transaction, recording them in schema_migrations.
export async function runMigrations(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [lockId]);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    for (const file of readdirSync(dir).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort()) {
      const version = file.slice(0, -4);
      if (done.has(version)) continue;
      try {
        await client.query('BEGIN');
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        applied.push(version);
      } catch (err) {
        await client.query('ROLLBACK');
        throw Object.assign(new Error(`migration ${version} failed`), { cause: err });
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [lockId]).catch(() => {});
    client.release();
  }
  return applied;
}
