// The stack's services as the panel shows them (Admin → System → Server state → Services): what state each one is
// in, whether that state is a fault, which version it runs, and whether it may be restarted from the panel. The raw
// facts come from the host agent's snapshot (scripts/install.sh state → state.json); everything here is a pure
// function of them, so the rules are tested without Docker.
import { maskSecrets } from './log';

// One service in the agent's snapshot. Fields after `startedAt` were added after 0.5.1; an older snapshot lacks them
// and the rules below fall back to what `status` (Docker's "Exited (0) 3 minutes ago") says.
export type RawService = {
  service: string; state: string; health: string; status: string; cpu?: number; memory?: string; memoryPercent?: number; restarts?: number; startedAt?: string;
  exitCode?: number; finishedAt?: string; restartPolicy?: string; image?: string; imageVersion?: string; ports?: string;
  // 1: another service of the compose file waits for this one to finish successfully (depends_on: service_completed_successfully)
  awaited?: number;
  // 1: the service is in the compose file the agent runs (`docker compose config --services`), so the agent can restart it
  managed?: number;
};

// running: up, no health check · healthy: up and its check passes · starting: its check has not decided yet ·
// unhealthy: up but its check fails · restarting: Docker is starting it again after it stopped (a loop when it repeats) ·
// completed: a one-shot job that ended with exit code 0 · failed: ended with another code · stopped: a long-running
// service that ended with 0 (someone stopped it) · created: made but never started · paused.
export type Kind = 'running' | 'healthy' | 'starting' | 'unhealthy' | 'restarting' | 'completed' | 'failed' | 'stopped' | 'created' | 'paused';
const faults: Kind[] = ['unhealthy', 'restarting', 'failed', 'stopped', 'created', 'paused'];

// A one-shot job is meant to run once and end: another service waits for it to complete (depends_on:
// service_completed_successfully), or the compose file does not restart it (restart: "no") and it has ended. A
// service without a restart policy that is running (a simulator, say) is a service like any other while it runs.
// Derived from the definition, not from the name.
export function isOneShot(s: RawService) {
  return s.awaited === 1 || (s.restartPolicy === 'no' && s.state !== 'running' && s.state !== 'restarting' && s.state !== 'paused');
}

export function exitCodeOf(s: RawService): number | null {
  if (typeof s.exitCode === 'number' && Number.isFinite(s.exitCode)) return s.exitCode;
  const m = /^Exited \((-?\d+)\)/.exec(s.status ?? '');
  return m ? Number(m[1]) : null;
}

export function classify(s: RawService): { kind: Kind; fault: boolean; oneShot: boolean; exitCode: number | null } {
  const oneShot = isOneShot(s), exitCode = exitCodeOf(s);
  let kind: Kind;
  switch (s.state) {
    case 'running': kind = s.health === 'unhealthy' ? 'unhealthy' : s.health === 'starting' ? 'starting' : s.health === 'healthy' ? 'healthy' : 'running'; break;
    case 'restarting': kind = 'restarting'; break;
    case 'paused': kind = 'paused'; break;
    case 'created': kind = 'created'; break;
    case 'exited': case 'dead': kind = exitCode !== 0 || s.state === 'dead' ? 'failed' : oneShot ? 'completed' : 'stopped'; break;
    default: kind = 'failed';
  }
  // A one-shot job that was made but has not run yet is not a fault of its own (what it waits for would be).
  const fault = faults.includes(kind) && !(kind === 'created' && oneShot);
  return { kind, fault, oneShot, exitCode };
}

// ---- Versions ------------------------------------------------------------------------------------------------------
// Built from this repository (compose `build:`): the image carries the compose project's name and no tag
// ("lightning-vm-api"), or Docker shows the bare image id once the name moved to a newer build. Those run the
// panel's own version. Anything else is a published image: its tag, or the version its label states.
export function builtHere(image: string | undefined) {
  const i = image ?? '';
  return !i || /^sha256:/.test(i) || (!i.includes(':') && !i.includes('/') && !i.includes('@'));
}
export function imageTag(image: string | undefined) {
  const i = (image ?? '').split('@')[0];
  const slash = i.lastIndexOf('/'), colon = i.lastIndexOf(':');
  return colon > slash ? i.slice(colon + 1) : (i ? 'latest' : '');
}
export type Version = { panel: true; version: string; commit: string } | { panel: false; tag: string; label: string; reported: string };
export function versionOf(s: RawService, app: { version: string; commit: string }, reported: Record<string, string> = {}): Version {
  if (builtHere(s.image)) return { panel: true, version: app.version, commit: app.commit };
  const label = s.imageVersion && s.imageVersion !== '<no value>' ? s.imageVersion : '';
  return { panel: false, tag: imageTag(s.image), label, reported: reported[s.service] ?? '' };
}

// ---- Restarting from the panel -------------------------------------------------------------------------------------
// Decided per service (docs/operations.md, "Restarting a service"):
// - postgres and redis are refused: every other service holds connections to them, running operations and queued
//   jobs are cut mid-way, and the panel itself stops answering until they are back. From the server's command line.
// - api, web and proxy are allowed: the request is answered (202) before the host agent restarts anything, so the
//   request does not kill itself; the panel is unreachable for a few seconds and the page keeps asking.
// - a one-shot job is not restarted; it may be run again only when running it twice is harmless. migrate is: it
//   takes an advisory lock and applies only the migrations not yet recorded in schema_migrations.
// The host agent checks the same list again before it runs anything (scripts/install.sh service).
export const PROTECTED = ['postgres', 'redis'] as const;
export const RERUNNABLE = ['migrate'] as const;
export const INTERRUPTS_PANEL = ['api', 'web', 'proxy'] as const;
export const SERVICE_NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/;

export type Rule = { restart: boolean; run: boolean; refused: '' | 'SERVICE_PROTECTED' | 'SERVICE_ONE_SHOT' | 'SERVICE_NOT_MANAGED'; interrupts: 'panel' | 'operations' | 'terminal' | 'none' };
export function ruleOf(s: RawService): Rule {
  const name = s.service;
  const interrupts = (INTERRUPTS_PANEL as readonly string[]).includes(name) ? 'panel' : name === 'worker' ? 'operations' : name === 'terminal' ? 'terminal' : 'none';
  if (s.managed === 0) return { restart: false, run: false, refused: 'SERVICE_NOT_MANAGED', interrupts };
  if ((PROTECTED as readonly string[]).includes(name)) return { restart: false, run: false, refused: 'SERVICE_PROTECTED', interrupts: 'panel' };
  if (isOneShot(s)) {
    const run = (RERUNNABLE as readonly string[]).includes(name);
    return { restart: false, run, refused: run ? '' : 'SERVICE_ONE_SHOT', interrupts: 'none' };
  }
  return { restart: true, run: false, refused: '', interrupts };
}

// Checks a restart or run-again request against the agent's last snapshot: the name must be a service of the compose
// file the agent runs (an allow-list; no free text reaches a shell), and the rule above must allow the act.
export function checkServiceRequest(services: RawService[] | null, name: unknown, act: unknown):
  { ok: true; service: string; act: 'restart' | 'run' } | { ok: false; status: number; code: string; fields?: Record<string, string> } {
  const fields: Record<string, string> = {};
  if (act !== 'restart' && act !== 'run') fields.act = 'INVALID_VALUE';
  if (typeof name !== 'string' || !SERVICE_NAME.test(name)) fields.service = 'INVALID_VALUE';
  if (Object.keys(fields).length) return { ok: false, status: 400, code: 'VALIDATION_FAILED', fields };
  if (!services) return { ok: false, status: 409, code: 'HOST_STATE_MISSING' };
  const s = services.find((x) => x.service === name);
  if (!s) return { ok: false, status: 400, code: 'VALIDATION_FAILED', fields: { service: 'UNKNOWN_SERVICE' } };
  const rule = ruleOf(s);
  if (act === 'restart' && !rule.restart) return { ok: false, status: 409, code: rule.refused || 'SERVICE_ONE_SHOT' };
  if (act === 'run' && !rule.run) return { ok: false, status: 409, code: isOneShot(s) ? (rule.refused || 'SERVICE_ONE_SHOT') : 'SERVICE_NOT_ONE_SHOT' };
  return { ok: true, service: name as string, act: act as 'restart' | 'run' };
}

// ---- Log lines -----------------------------------------------------------------------------------------------------
// Service logs can hold secrets. What looks like one is masked here, on the server, before a line leaves the API
// (the agent masks the URL secrets already; this adds what a program may print about itself):
// Authorization and Cookie headers, Bearer tokens, passwords and keys written as key=value or "key": "value",
// the password in a connection string (scheme://user:password@host), JSON web tokens, and private key blocks.
const M = '[masked]';
export function redactLine(line: string) {
  return maskSecrets(line)
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----).*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, `$1${M}$2`)
    .replace(/\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?:(bearer|basic|token|digest)\s+)?[^\s"',;]+/gi, (_m, k: string, scheme?: string) => `${k}${scheme ? `${scheme} ` : ''}${M}`)
    .replace(/\b((?:set-)?cookie["']?\s*[:=]\s*["']?)[^"'\n]+/gi, `$1${M}`)
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${M}`)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:)[^\s@/"']+@/gi, `$1${M}@`)
    .replace(/(["']?\b[\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
      (_m, k: string, v: string) => `${k}${v.startsWith('"') ? `"${M}"` : v.startsWith("'") ? `'${M}'` : M}`)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, M);
}
