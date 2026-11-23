// The admin's setup checklist (GET /admin/onboarding; the admin dashboard): what a new installation still needs
// before customers can order ("start"), then what keeps it healthy once it runs ("health"). Every item is read from
// the installation's real state each time, so a step that was done and stops being true (mail starts failing, the
// backup timer is removed, a staff member turns off two-factor) comes back. Pure (unit tests:
// test/onboarding-rules.test.mjs); smart.ts gathers the facts.

export type Facts = {
  counts: { connection: number; location: number; pool: number; image: number; package: number; ip: number };
  mail: { ready: boolean; last: { ok: boolean; at: string; code?: string | null } | null };
  backup: { lastOk: string | null; timer: boolean; schedule: string | null };
  monitoring: 'on' | 'off' | 'partial' | null; // null: not known (the check itself failed)
  updates: { autoUpdate: string | null; channel: string | null; updateAvailable: boolean | null; latest: string | null };
  billing: { enabled: boolean; gateways: number };
  twoFactor: { me: boolean; staffWithout: number };
};
export type Step = { key: string; group: 'start' | 'health'; done: boolean; link: string; detail?: Record<string, string | number> };

export function steps(f: Facts): Step[] {
  const start: Step[] = [
    { key: 'connection', group: 'start', done: f.counts.connection > 0, link: '/admin/vmware' },
    { key: 'location', group: 'start', done: f.counts.location > 0, link: '/admin/catalog?tab=locations' },
    { key: 'pool', group: 'start', done: f.counts.pool > 0, link: '/admin/catalog?tab=pools' },
    { key: 'image', group: 'start', done: f.counts.image > 0, link: '/admin/catalog?tab=images' },
    { key: 'package', group: 'start', done: f.counts.package > 0, link: '/admin/catalog?tab=packages' },
    { key: 'ip', group: 'start', done: f.counts.ip > 0, link: '/admin/catalog?tab=ip' },
    { key: 'mail', group: 'start', done: f.mail.ready, link: '/admin/settings?tab=mail' },
    { key: 'backup', group: 'start', done: !!f.backup.lastOk, link: '/admin/system' },
    { key: 'twoFactor', group: 'start', done: f.twoFactor.me, link: '/account?tab=security' },
  ];
  const health: Step[] = [];
  // Mail that is set up but whose last message failed: the settings are there, the mail is not.
  if (f.mail.ready) health.push({ key: 'mailDelivers', group: 'health', done: !f.mail.last || f.mail.last.ok, link: '/admin/settings?tab=mail',
    ...(f.mail.last && { detail: { at: f.mail.last.at, ...(f.mail.last.code && { code: f.mail.last.code }) } }) });
  health.push({ key: 'backupSchedule', group: 'health', done: f.backup.timer && f.backup.schedule !== 'off', link: '/admin/system',
    detail: { schedule: f.backup.timer ? (f.backup.schedule ?? 'daily') : 'off' } });
  if (f.monitoring) health.push({ key: 'monitoring', group: 'health', done: f.monitoring === 'on', link: '/admin/system', detail: { state: f.monitoring } });
  if (f.updates.channel !== null) health.push({ key: 'updates', group: 'health', done: f.updates.autoUpdate === 'on' || f.updates.updateAvailable === false, link: '/admin/system',
    detail: { channel: f.updates.channel, auto: f.updates.autoUpdate ?? 'off', ...(f.updates.updateAvailable && f.updates.latest && { latest: f.updates.latest }) } });
  // Payment methods matter only where the panel bills.
  if (f.billing.enabled) health.push({ key: 'payments', group: 'health', done: f.billing.gateways > 0, link: '/admin/settings?tab=payments', detail: { n: f.billing.gateways } });
  health.push({ key: 'staffTwoFactor', group: 'health', done: f.twoFactor.staffWithout === 0, link: '/admin/users', detail: { n: f.twoFactor.staffWithout } });
  return [...start, ...health];
}
