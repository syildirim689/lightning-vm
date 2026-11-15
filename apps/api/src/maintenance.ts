import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

// ---- Requests to the host agent (scripts/install.sh agent / run-requests) ----
// The panel writes one small key=value file; the agent validates it again and runs install.sh. Results come
// back through the read-only mount: status.json (the current or last request), runs/<id>.log, releases.json.
const requests = process.env.MAINTENANCE_REQUESTS_DIR ?? '/maintenance-requests';
export type Action = 'check' | 'update' | 'backup' | 'auto-update' | 'domain' | 'monitoring' | 'terminal' | 'host' | 'os';
export type AgentStatus = { id: string; action: Action; by: string; state: 'running' | 'succeeded' | 'failed' | 'rejected'; startedAt: string; finishedAt: string; exitCode: number | null; code: string };

const readJson = <T>(file: string): T | null => { try { return JSON.parse(readFileSync(join(dir, file), 'utf8')) as T; } catch { return null; } };
export const releases = () => readJson<{ checkedAt: string; channel: string; branch?: string; current: string; commit?: string; latest: string; updateAvailable: boolean; error: string;
  releases: { version: string; date: string; notes: string }[] }>('releases.json');
export const agentStatus = () => readJson<AgentStatus>('status.json');
// This server's name, clock, time and DNS servers as the agent last recorded them (scripts/install.sh host).
export type HostInfo = { checkedAt: string; time: number; hostname: string; fqdn: string; timezone: string; ntp: string; ntpSynced: string; ntpServers: string; dnsServers: string;
  resolvers: string; timesyncd: boolean; resolved: boolean; os: string; kernel: string; uptime: number };
export const hostInfo = () => readJson<HostInfo>('host.json');

// This server's operating system updates as the agent last recorded them (scripts/install.sh os).
export type OsInfo = { checkedAt: string; manager: 'apt' | 'none'; total: number; security: number; held: number; packages: { name: string; to: string; from: string; security: boolean }[];
  rebootRequired: boolean; rebootPackages: string; autoSecurity: boolean; listsAt: string; changedAt: string; bootId: string; kernel: string };
export const osInfo = () => readJson<OsInfo>('os.json');
// The running kernel's boot id (containers share the host's kernel): it changes with every restart of the server.
export const bootId = () => { try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return ''; } };

// The last lines of a run's log (the installer's own TR/EN progress lines; no secrets are printed there).
export function runLog(id: string, lines = 80) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return [];
  try { return readFileSync(join(dir, 'runs', `${id}.log`), 'utf8').split('\n').filter(Boolean).slice(-lines); } catch { return []; }
}

export function pendingRequests() {
  try { return readdirSync(requests).filter((f) => f.endsWith('.req')).length; } catch { return -1; } // -1: the drop folder is missing
}

export function queueRequest(fields: Record<string, string>, files: Record<string, string> = {}) {
  const id = randomUUID();
  const body = Object.entries({ ...fields, id }).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  // Larger content (a certificate and key) goes next to the request as <id>.<name>, written before the request appears.
  for (const [name, content] of Object.entries(files)) writeFileSync(join(requests, `${id}.${name}`), content, { mode: 0o600 });
  // Written under a temporary name and renamed, so the agent never reads half a file.
  writeFileSync(join(requests, `.${id}.tmp`), body, { mode: 0o600 });
  renameSync(join(requests, `.${id}.tmp`), join(requests, `${id}.req`));
  return id;
}
