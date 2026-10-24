import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Backup, restore and update results are written on the host by scripts/install.sh (it keeps working
// when the API is down or being replaced) and mounted read-only here.
const dir = process.env.MAINTENANCE_DIR ?? '/maintenance';

export type Run = { time: string; kind: 'backup' | 'restore' | 'update'; status: 'ok' | 'failed' | 'postponed'; code?: string; reason?: string;
  version?: string; from?: string; to?: string; rolledBack?: boolean; file?: string; bytes?: number; copied?: boolean };

export function history(): Run[] {
  let text = '';
  try { text = readFileSync(join(dir, 'history.jsonl'), 'utf8'); } catch { return []; }
  return text.split('\n').flatMap((line) => { try { return line ? [JSON.parse(line) as Run] : []; } catch { return []; } });
}

export function settings(): Record<string, string> {
  try { return JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')); } catch { return {}; }
}

export function summary() {
  const runs = history();
  // A postponed automatic update did nothing; it stays in the history but is not the "last" result.
  const last = (kind: Run['kind'], status?: Run['status']) => [...runs].reverse().find((r) => r.kind === kind && r.status !== 'postponed' && (!status || r.status === status)) ?? null;
  return { version: process.env.APP_VERSION || 'dev', settings: settings(), lastBackup: last('backup'), lastSuccessfulBackup: last('backup', 'ok'),
    lastUpdate: last('update'), lastRestore: last('restore'), history: runs.slice(-20).reverse() };
}
