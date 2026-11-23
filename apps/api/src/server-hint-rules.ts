// "What next" on a server's page (GET /servers/:id/hints): a few things worth doing, read from the server's real
// state each time it is asked. Each says what it is based on and leads to the part of the page (or the page) where it
// is done; nothing is done without a click. Pure (unit tests: test/server-hint-rules.test.mjs); server-hints.ts
// gathers the facts.
//
// Not here, on purpose: how full the guest's disk is and whether the guest still accepts password logins. The
// platforms tell the panel neither, and a hint that guesses would be wrong as often as right.

export type HintFacts = {
  id: string;
  state: string; // servers.state
  deleting: boolean; // in the trash (delete_at set)
  createdAt: string;
  backups: { allowed: boolean; available: boolean; lastReady: string | null }; // allowed: for this viewer; available: the location keeps backups
  firewall: { supported: boolean; attached: number };
  rootPassword: { kept: boolean; allowed: boolean };
  snapshots: { allowed: boolean; old: number }; // old: snapshots older than snapshotDays
};
export const hintCodes = ['NO_BACKUP', 'NO_FIREWALL', 'ROOT_PASSWORD_KEPT', 'SNAPSHOTS_OLD'] as const;
export type Hint = { code: (typeof hintCodes)[number]; severity: 'warning' | 'info'; key: string;
  params: Record<string, string | number | null>; action: { section: 'backups' | 'firewalls' | 'rootPassword' | 'snapshots' } | { href: string } };

export const backupDays = 30; // a backup older than this does not count as one
export const snapshotDays = 30;
const day = 86_400_000;

export function serverHints(f: HintFacts, now = Date.now()): Hint[] {
  // A server that is being built, has failed or is on its way out has other, more urgent notices on the page.
  if (f.state !== 'ready' || f.deleting) return [];
  // Things that take a moment after an order (keeping the password to read it once, the first backup) are not
  // pointed out on the first day.
  const settled = now - Date.parse(f.createdAt) > day;
  const out: Hint[] = [];
  const add = (code: Hint['code'], severity: Hint['severity'], params: Hint['params'], action: Hint['action']) =>
    out.push({ code, severity, key: `hint:${code}:${f.id}`, params, action });
  if (f.backups.allowed && f.backups.available && settled) {
    const last = f.backups.lastReady ? Date.parse(f.backups.lastReady) : null;
    if (last === null || now - last > backupDays * day) {
      add('NO_BACKUP', 'warning', { days: last === null ? null : Math.floor((now - last) / day), limit: backupDays }, { section: 'backups' });
    }
  }
  if (f.firewall.supported && f.firewall.attached === 0) {
    add('NO_FIREWALL', 'warning', {}, { href: '/firewalls' });
  }
  if (f.rootPassword.kept && f.rootPassword.allowed && settled) {
    add('ROOT_PASSWORD_KEPT', 'info', {}, { section: 'rootPassword' });
  }
  if (f.snapshots.allowed && f.snapshots.old > 0) {
    add('SNAPSHOTS_OLD', 'info', { n: f.snapshots.old, days: snapshotDays }, { section: 'snapshots' });
  }
  return out;
}
