import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The rule-based helpers on their screens. Runs after app.spec.ts (files run in name order, one worker) on the
// deployment that suite has set up: its administrator, and the catalog its tests opened for sale. What the helpers
// say depends on weeks of usage history a fresh deployment does not have, so each test first shows the true state of
// such a deployment ("not enough data"), and then the answer of the one API route in question is replaced by a
// prepared one, to see the screen with findings in it. Everything else the page asks for is the real API.
// The tests do not build on each other: one that fails does not keep the others from running.
test.use({ locale: 'en-US' });

const admin = { email: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test', password: process.env.E2E_ADMIN_PASSWORD ?? 'e2e admin passphrase 2026' };
const csrf = { 'x-lightning-csrf': '1' };
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> | undefined;

// The administrator's session. After app.spec.ts this address has signed in too often to do it again within minutes
// (sign-in is limited per address), so that file leaves its session for the ones after it; run alone, this file signs in.
async function signInAdmin(page: Page) {
  if (!cookies) { try { cookies = JSON.parse(readFileSync(join(tmpdir(), 'lightning-e2e-admin-session.json'), 'utf8')); } catch { /* run alone */ } }
  if (cookies) {
    await page.context().addCookies(cookies);
    if ((await page.request.get('/api/auth/me')).ok()) { await page.goto('/admin'); return; }
    // A session left by an earlier run of another deployment: not this one's.
    await page.context().clearCookies();
    cookies = undefined;
  }
  await page.goto('/login');
  await page.getByLabel(/E-posta|Email/).fill(admin.email);
  await page.getByLabel(/Parola|Password/).fill(admin.password);
  await page.getByRole('button', { name: /^(Giriş yap|Sign in)$/ }).click();
  await expect(page).toHaveURL(/\/admin$/);
  cookies = await page.context().cookies();
}
const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
async function noSidewaysScroll(page: Page, label: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { message: `${label}: no sideways scrolling`, timeout: 5_000 }).toBeLessThanOrEqual(1);
}
// A ready server of the administrator's own: one that is there already, or the smallest package ordered now.
async function ownServer(page: Page): Promise<string> {
  type Row = { id: string; name: string; state: string };
  const mine = async () => ((await (await page.request.get('/api/servers')).json()) as { servers: Row[] }).servers;
  const ready = (await mine()).find((s) => s.state === 'ready');
  if (ready) return ready.id;
  const offered = await (await page.request.get('/api/catalog')).json() as { packages: { id: string; name: string; poolIds: string[]; imageIds: string[] }[] };
  const tiny = offered.packages.find((x) => x.name.includes('E2E Tiny')) ?? offered.packages[0];
  expect(tiny, 'a package to order (the catalog test of app.spec.ts opens one for sale)').toBeTruthy();
  const keys = (await (await page.request.get('/api/ssh-keys')).json() as { keys: { id: string }[] }).keys;
  const sshKey = keys[0]?.id ?? (await (await page.request.post('/api/ssh-keys', { headers: csrf,
    data: { name: 'e2e-smart', publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMa0iBTtZu9kbSNXzg5M6pZ1rn8F1143iWq3JIcGimfn e2e' } })).json() as { id: string }).id;
  const ordered = await page.request.post('/api/servers', { headers: { ...csrf, 'idempotency-key': `e2e-smart-${Date.now()}` },
    data: { type: 'package', poolId: tiny.poolIds[0], packageId: tiny.id, imageId: tiny.imageIds[0], name: 'e2e-smart', sshKeyIds: [sshKey] } });
  expect(ordered.status(), await ordered.text()).toBe(202);
  const id = (await ordered.json() as { serverId: string }).serverId;
  await expect.poll(async () => (await mine()).find((s) => s.id === id)?.state, { timeout: 180_000, intervals: [2_000] }).toBe('ready');
  return id;
}

test('smart: the usage watch says what it compared, a finding says its numbers and can be hidden; staff see unusual use beside the abuse findings', async ({ page }) => {
  test.skip(!process.env.E2E_VCSIM_HOST, 'needs compose.simulator.yaml and E2E_VCSIM_HOST');
  test.setTimeout(300_000);
  await signInAdmin(page);
  const id = await ownServer(page);

  // A new server on a new deployment: no history, and the block says so instead of guessing.
  await page.goto(`/servers/${id}`);
  const watch = page.locator('[data-section="Usage watch"]');
  await expect(watch).toContainText(/Not enough data yet: (no history|\d+ days? of history), 5 are needed before anything is concluded\./);
  await expect(watch.getByRole('button', { name: /Hide/ })).toHaveCount(0);

  // The same block with a finding in it.
  const finding = { id: '5b1f6f0e-6a53-4c0e-9d57-0d6f3a1f7c11', metric: 'cpu', direction: 'high', openedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), lastSeen: new Date().toISOString(),
    detail: { recent: 96, usual: 10, scale: 5, z: 17.2, baseline: 46, days: 10, hint: 'cpu_pinned' } };
  let hidden = false;
  await page.route(`**/api/servers/${id}/anomalies`, (route) => json(route, { measured: true, days: 10, minDays: 5, enough: true, anomalies: hidden ? [] : [finding], hidden: hidden ? 1 : 0 }));
  await page.reload();
  await expect(watch.getByText('CPU use is far above usual')).toBeVisible();
  await expect(watch).toContainText('Last 3 hours: 96% on average. Usual at this time of day: 10% (from 46 hours of history over 10 days).');
  await expect(watch).toContainText('Since 2 hours ago');
  await page.setViewportSize({ width: 390, height: 844 });
  await noSidewaysScroll(page, 'server page with a usage finding at 390 px');
  await page.setViewportSize({ width: 1280, height: 720 });
  // Hiding it is the insights' own dismissal, for seven days.
  const dismissal = page.waitForRequest((r) => r.url().endsWith('/api/insights/dismissals') && r.method() === 'PUT');
  hidden = true;
  await watch.getByRole('button', { name: 'Hide for 7 days: CPU use is far above usual' }).click();
  expect((await dismissal).postDataJSON()).toEqual({ key: `anomaly:${finding.id}`, days: 7 });
  await expect(watch).toContainText('1 finding is hidden.');
  await expect(watch).toContainText('Nothing unusual. Compared with this server’s own last 10 days.');
  // A platform that reports no CPU figures.
  await page.unroute(`**/api/servers/${id}/anomalies`);
  await page.route(`**/api/servers/${id}/anomalies`, (route) => json(route, { measured: false, days: 0, minDays: 5, enough: false, anomalies: [], hidden: 0 }));
  await page.reload();
  await expect(watch).toContainText('Not enough data: this platform does not report CPU figures');
  await page.unroute(`**/api/servers/${id}/anomalies`);

  // The customer's insight card for it, with the numbers.
  await page.route('**/api/insights', (route) => json(route, { hidden: 0, insights: [
    { code: 'USAGE_ANOMALY_CPU_HIGH', severity: 'warning', params: { name: 'web-1', recent: 96, usual: 10, baseline: 46 }, link: `/servers/${id}`, key: `anomaly:${finding.id}` },
    { code: 'USAGE_ANOMALY_NETWORK_HIGH', severity: 'warning', params: { name: 'mail-1', recent: 85.9, usual: 10.7, baseline: 14 }, link: `/servers/${id}`, key: 'anomaly:n' }] }));
  await page.goto('/');
  await expect(page.getByText('web-1: CPU use is far above usual')).toBeVisible();
  await expect(page.getByText('96% on average over the last 3 hours; 10% is usual at this time of day (from 46 hours of history).')).toBeVisible();
  await expect(page.getByText('85.9 GB in a day; a usual day is 10.7 GB (from the 14 days before).')).toBeVisible();
  await page.unroute('**/api/insights');

  // Staff: the third tab of the abuse page. Empty on this deployment; then with one that resembles mining.
  await page.goto('/admin/abuse?tab=usage');
  await expect(page.getByRole('tab', { name: /Unusual use/ })).toHaveAttribute('aria-selected', 'true');
  const unusual = page.getByRole('grid', { name: 'Unusual use' });
  await expect(unusual.getByText('No server’s use has left its own baseline.')).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search findings' })).toHaveCount(0);
  await page.route('**/api/admin/anomalies', (route) => json(route, { anomalies: [{ ...finding, resolvedAt: null, serverId: id, serverName: 'web-1', owner: 'a@example.test', location: 'Istanbul', abuseOpen: 1 }] }));
  await page.reload();
  await expect(unusual.getByText('CPU use is far above usual')).toBeVisible();
  await expect(unusual.getByText('Last 3 hours: 96% on average. Usual at this time of day: 10% (from 46 hours of history over 10 days).')).toBeVisible();
  await expect(unusual.getByText('Resembles mining: CPU held near full')).toBeVisible();
  await expect(unusual.getByText('1 abuse finding open')).toBeVisible();
  await expect(unusual.getByText('web-1')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await noSidewaysScroll(page, 'unusual use at 390 px');
  await page.setViewportSize({ width: 1280, height: 720 });
  // The findings tab is as it was.
  await page.getByRole('tab', { name: /^Open/ }).click();
  await expect(page.getByRole('searchbox', { name: 'Search findings' })).toBeVisible();
});

test('smart: the month forecast counts hourly usage, and the budget is measured against what the month will cost', async ({ page }) => {
  await signInAdmin(page);
  // The card as the deployment has it: figures when something is billed, a plain sentence when nothing is.
  await page.goto('/');
  const cost = page.locator('[data-section="This month"]');
  await expect(cost).toContainText(/Expected by month end|Nothing billed this month\./);
  // A month with a server billed by the hour, and a budget the monthly total stays under but the month will pass.
  await page.route('**/api/usage/summary', (route) => json(route, {
    costs: [{ currency: 'EUR', monthly: 66.5, accrued: 20, forecast: 53, daysLeft: 15, hourly: { accrued: 5, hours: 100, perHour: 0.05, forecast: 23 } }],
    usage: { servers: 2, vcpu: 4, memoryMb: 4096, diskGb: 40 },
    budget: { amount: 50, currency: 'EUR', monthly: 45, ratio: 0.9, state: 'near', forecast: 53, forecastRatio: 1.06, forecastState: 'over' } }));
  await page.route('**/api/insights', (route) => json(route, { hidden: 0, insights: [
    { code: 'BUDGET_FORECAST_OVER', severity: 'warning', params: { forecast: '53.00', amount: '50.00', currency: 'EUR', pct: 106 }, link: '/', key: 'budget-forecast:2026-11' }] }));
  await page.reload();
  await expect(cost).toContainText('Of which hourly usage: €5.00 so far (100 hours); at the current €0.05 an hour, €23.00 by month end.');
  await expect(cost.locator('[data-budget-forecast="over"]')).toHaveText('This month is heading for €53.00, over your €50.00 budget (106%).');
  await expect(page.getByText('This month is heading over your budget')).toBeVisible();
  await expect(page.getByText('At the current rate it will cost 53.00 EUR; your budget is 50.00 EUR (106%).')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await noSidewaysScroll(page, 'overview with the forecast at 390 px');
  await expect(cost.locator('[data-budget-forecast="over"]')).toBeVisible();
});

test('smart: a schedule is suggested with its reasons, created only on a click and through the API\'s own reading; without history the page says so', async ({ page }) => {
  test.skip(!process.env.E2E_VCSIM_HOST, 'needs compose.simulator.yaml and E2E_VCSIM_HOST');
  test.setTimeout(300_000);
  await signInAdmin(page);
  const id = await ownServer(page);
  await page.goto(`/servers/${id}`);
  // What the API says about this server as it is: three weeks of history are needed and a deployment this young has
  // none of them (the line says how many days there are); a server that already has a power schedule is left alone.
  const real = await (await page.request.get(`/api/servers/${id}/schedule-suggestion`)).json() as { state: string; days: number; minDays: number; savesMoney: boolean };
  expect(['not_enough_data', 'scheduled']).toContain(real.state);
  expect([real.minDays, real.savesMoney]).toEqual([21, false]);
  if (real.state === 'not_enough_data') await expect(page.locator('[data-schedule-suggestion="not_enough_data"]')).toHaveText(/Schedule suggestion: not enough data yet \(\d+ of 21 days of CPU history\)\./);
  await expect(page.getByRole('button', { name: 'Create these schedules' })).toHaveCount(0);

  // The same page with a suggestion; the two requests it may make are answered here and looked at.
  const suggested = { state: 'suggested', timezone: 'UTC', days: 27, minDays: 21, weeks: 4, kind: 'nightly', offHours: 108, idleHours: 118, savesMoney: false, energyKwhPerWeek: 5.4, hidden: false,
    schedules: [{ action: 'shutdown', days: [1, 2, 3, 4, 5], time: '19:00' }, { action: 'power_on', days: [1, 2, 3, 4, 5], time: '07:00' }] };
  let state: 'suggested' | 'scheduled' = 'suggested';
  const sent: { timezone?: string }[] = [];
  await page.route(`**/api/servers/${id}/schedule-suggestion**`, async (route) => {
    if (route.request().method() === 'POST') { sent.push(route.request().postDataJSON()); state = 'scheduled'; return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ schedules: [] }) }); }
    return json(route, state === 'suggested' ? suggested : { ...suggested, state: 'scheduled', schedules: undefined });
  });
  await page.reload();
  const box = page.getByRole('region', { name: 'Suggested schedule' });
  await expect(box).toContainText('Suggested schedule: Off every night, on only on the days it is used');
  await expect(box).toContainText('For 4 weeks this server has been idle in the same hours of every week: 108 hours a week.');
  await expect(box.getByRole('listitem').filter({ hasText: 'Shut down' })).toContainText('Weekdays at 19:00');
  await expect(box.getByRole('listitem').filter({ hasText: 'Start' })).toContainText('Weekdays at 07:00');
  await expect(box).toContainText('Why this is shown: in the last 27 days the hourly CPU average stayed under 3% (no sample above 10%) in 118 of the 168 hours of the week, every week.');
  // No money is promised: the bill does not change for a server that is off.
  await expect(box).toContainText('The price does not change: a switched-off server is billed like a running one.');
  await expect(box).toContainText('What it saves: about 5.4 kWh of energy a week, and 108 hours a week in which nothing runs or can be reached.');
  await page.setViewportSize({ width: 390, height: 844 });
  await noSidewaysScroll(page, 'server page with a schedule suggestion at 390 px');
  await page.setViewportSize({ width: 1280, height: 720 });
  expect(sent).toEqual([]);
  await box.getByRole('button', { name: 'Create these schedules' }).click();
  await expect(page.getByText('Schedules created. They are ordinary schedules: edit or remove them below.').first()).toBeVisible();
  // Only the time zone goes with the request; which schedules are created is the API's decision.
  expect(sent.length).toBe(1);
  expect(Object.keys(sent[0])).toEqual(['timezone']);
  await expect(box).toHaveCount(0);

  // "Not now" hides it with the insights' dismissal for this server.
  state = 'suggested';
  await page.reload();
  await expect(box).toBeVisible();
  const dismissal = page.waitForRequest((r) => r.url().endsWith('/api/insights/dismissals') && r.method() === 'PUT');
  await box.getByRole('button', { name: 'Not now' }).click();
  expect((await dismissal).postDataJSON()).toEqual({ key: `schedule:${id}`, days: 7 });
  await page.unroute(`**/api/servers/${id}/schedule-suggestion**`);
  // A platform without CPU figures: said, not guessed.
  await page.route(`**/api/servers/${id}/schedule-suggestion**`, (route) => json(route, { state: 'not_measured', timezone: 'UTC', days: 0, minDays: 21, weeks: 4, savesMoney: false, energyKwhPerWeek: null, hidden: false }));
  await page.reload();
  await expect(page.locator('[data-schedule-suggestion="not_measured"]')).toContainText('This platform does not report CPU figures, so nothing is suggested.');
});

test('smart: payment risk is said to the customer before the renewal, and listed for staff by the amount at risk', async ({ page }) => {
  await signInAdmin(page);
  // Staff: the tab on the billing page, as this deployment has it (nothing overdue is a plain sentence, not an empty table).
  await page.goto('/admin/billing?tab=risk');
  await expect(page.getByRole('tab', { name: 'At risk' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Accounts at risk' })).toBeVisible();
  await expect(page.getByText('Accounts with invoices past their due date or with at least 2 failed charges in the last 30 days')).toBeVisible();
  // With two accounts on it.
  const rule = { lookaheadDays: 30, failedDays: 30, minFailures: 2, growthDays: 7 };
  await page.route('**/api/admin/billing/risk', (route) => json(route, { rule, accounts: [
    { userId: 'u1', email: 'a@example.test', currency: 'EUR', atRisk: 1200, overdue: 1200, overdueCount: 2, oldestDays: 40, newOverdue: 300, failedCharges: 0, failedAmount: 0, reasons: ['OVERDUE_GROWING'] },
    { userId: 'u2', email: 'b@example.test', currency: 'EUR', atRisk: 120, overdue: 0, overdueCount: 0, oldestDays: 0, newOverdue: 0, failedCharges: 3, failedAmount: 120, reasons: ['REPEATED_FAILURES'] }] }));
  await page.reload();
  const table = page.getByRole('grid', { name: 'Accounts at risk' });
  const first = table.getByRole('row').filter({ hasText: 'a@example.test' }), second = table.getByRole('row').filter({ hasText: 'b@example.test' });
  await expect(first).toContainText('€1,200.00');
  await expect(first).toContainText('2 invoices, the oldest 40 days overdue');
  await expect(first).toContainText('€300.00 of it in the last 7 days');
  await expect(first).toContainText('Overdue and growing');
  await expect(second).toContainText('€120.00');
  await expect(second).toContainText('Nothing overdue');
  await expect(second).toContainText('3 failed charges');
  await expect(second).toContainText('Repeated failed charges');
  await page.setViewportSize({ width: 390, height: 844 });
  await noSidewaysScroll(page, 'accounts at risk at 390 px');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.unroute('**/api/admin/billing/risk');
  // The staff finding leads there.
  await page.route('**/api/admin/insights', (route) => json(route, { hidden: 0, insights: [
    { code: 'PAYMENT_RISK', severity: 'warning', params: { count: 2, price: '1200.00', currency: 'EUR', email: 'a@example.test' }, link: '/admin/billing?tab=risk', key: 'PAYMENT_RISK' }] }));
  await page.goto('/admin');
  await expect(page.getByText('2 accounts have payments at risk')).toBeVisible();
  await expect(page.getByText('Overdue invoices or repeated failed charges. The largest: €1,200.00 (a@example.test).')).toBeVisible();
  await page.unroute('**/api/admin/insights');

  // The customer: the card that ends before the renewal, and the balance that does not cover it, with date and amounts.
  await page.route('**/api/insights', (route) => json(route, { hidden: 0, insights: [
    { code: 'CARD_EXPIRES_BEFORE_RENEWAL', severity: 'warning', params: { last4: '1881', expiry: '10/26', date: '2026-12-11', price: '96.00', currency: 'EUR' }, link: '/billing?tab=cards', key: 'card-expiry:2026-12-11' },
    { code: 'RENEWAL_NOT_COVERED', severity: 'warning', params: { balance: '30.00', short: '66.00', date: '2026-12-11', price: '96.00', currency: 'EUR' }, link: '/billing?tab=balance', key: 'renewal-cover:2026-12-11' }] }));
  await page.goto('/');
  await expect(page.getByText('Your card ends before the next renewal')).toBeVisible();
  await expect(page.getByText('The card ending in 1881 is valid through 10/26; €96.00 is due on Dec 11, 2026 and cannot be charged to it. Add a card that lasts, or top up your balance.')).toBeVisible();
  await expect(page.getByText('€96.00 is due on Dec 11, 2026; your balance is €30.00, €66.00 short, and there is no saved card that lasts until then.')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await noSidewaysScroll(page, 'overview with payment warnings at 390 px');
});

test('smart: staff see similar resolved tickets with the reason; a customer writing a ticket is shown their own answers and the status page only', async ({ page }) => {
  await signInAdmin(page);
  // A ticket to look at as staff (the administrator's own, opened through the API).
  const deps = (await (await page.request.get('/api/support/departments')).json() as { departments: { id: string }[] }).departments;
  expect(deps.length).toBeGreaterThan(0);
  const opened = await page.request.post('/api/support/tickets', { headers: csrf, data: { subject: 'E2E: SSH does not connect', body: 'Connection refused on port 22 since this morning.', departmentId: deps[0].id } });
  expect(opened.status(), await opened.text()).toBe(201);
  const ticket = (await opened.json() as { id: string }).id;
  await page.goto(`/admin/support/${ticket}`);
  const similar = page.getByRole('region', { name: 'Similar resolved tickets' });
  // Whatever this deployment's closed tickets are, the block says how many it compared.
  await expect(similar).toContainText(/Compared with the (closed tickets \(none yet\)|last closed ticket|last \d+ closed tickets) by the words they share\. Nothing is sent by itself\./);
  await page.route(`**/api/admin/support/tickets/${ticket}/similar`, (route) => json(route, { compared: 12, similar: [
    { id: '0f0e7c1a-3a3e-4d6e-8a57-1c2d3e4f5a6b', number: 1001, subject: 'SSH bağlantısı kurulamıyor', closedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), rating: 5, score: 0.61, shared: ['ssh', 'port', 'refused'],
      answer: 'Port 22 was closed in your firewall rule; we added the rule and SSH works again.' }] }));
  await page.reload();
  await expect(similar).toContainText('Compared with the last 12 closed tickets');
  await expect(similar.getByRole('link', { name: '#1001 · SSH bağlantısı kurulamıyor' })).toHaveAttribute('href', '/admin/support/0f0e7c1a-3a3e-4d6e-8a57-1c2d3e4f5a6b');
  await expect(similar).toContainText('Shown because it shares: ssh, port, refused');
  await expect(similar).toContainText('Port 22 was closed in your firewall rule; we added the rule and SSH works again.');
  await expect(similar).toContainText('rated 5/5');
  await expect(similar.getByRole('button', { name: 'Copy the answer of ticket #1001' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await noSidewaysScroll(page, 'ticket with similar tickets at 390 px');
  await page.setViewportSize({ width: 1280, height: 720 });

  // The customer's side: suggestions appear under the message while a new ticket is written.
  const asked: { subject?: string; body?: string }[] = [];
  await page.route('**/api/support/suggestions', (route) => { asked.push(route.request().postDataJSON()); return json(route, {
    incidents: [{ id: 'i1', title: 'Network outage in Istanbul', impact: 'major', status: 'investigating', open: true, createdAt: new Date().toISOString(), resolvedAt: null }],
    answers: [{ id: ticket, number: 1001, subject: 'SSH does not connect', status: 'closed', shared: ['ssh', 'port'], answer: 'Port 22 was closed in your firewall rule; we added the rule and SSH works again.' }] }); });
  await page.goto('/support?new=1');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Subject').fill('SSH refuses the connection');
  await dialog.getByLabel('Message').fill('Port 22 answers with connection refused.');
  const before = dialog.getByRole('region', { name: 'Before you send: this may already answer it' });
  await expect(before).toContainText('Open incident: Network outage in Istanbul');
  await expect(before).toContainText('Your ticket #1001: SSH does not connect');
  await expect(before).toContainText('Shown because it shares: ssh, port');
  await expect(before).toContainText('From your own earlier tickets and the public status page only.');
  // Only the two texts being written are sent for the comparison.
  expect(Object.keys(asked.at(-1)!).sort()).toEqual(['body', 'subject']);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(before).toBeVisible();
  await noSidewaysScroll(page, 'new ticket with suggestions at 390 px');
  // Nothing was sent: the dialog is closed and the draft cleared.
  await dialog.getByLabel('Subject').fill('');
  await dialog.getByLabel('Message').fill('');
  await expect(before).toHaveCount(0);
});
