import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

// The rule-based helpers on their screens. Runs after app.spec.ts (files run in name order, one worker) on the
// deployment that suite has set up: its administrator, and the catalog its tests opened for sale. What the helpers
// say depends on weeks of usage history a fresh deployment does not have, so each test first shows the true state of
// such a deployment ("not enough data"), and then the answer of the one API route in question is replaced by a
// prepared one, to see the screen with findings in it. Everything else the page asks for is the real API.
test.describe.configure({ mode: 'serial' });
test.use({ locale: 'en-US' });

const admin = { email: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test', password: process.env.E2E_ADMIN_PASSWORD ?? 'e2e admin passphrase 2026' };
const csrf = { 'x-lightning-csrf': '1' };
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> | undefined;

async function signInAdmin(page: Page) {
  if (cookies) { await page.context().addCookies(cookies); await page.goto('/admin'); return; }
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
  await expect(page.getByText('No server’s use has left its own baseline.')).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search findings' })).toHaveCount(0);
  await page.route('**/api/admin/anomalies', (route) => json(route, { anomalies: [{ ...finding, resolvedAt: null, serverId: id, serverName: 'web-1', owner: 'a@example.test', location: 'Istanbul', abuseOpen: 1 }] }));
  await page.reload();
  await expect(page.getByText('CPU use is far above usual').first()).toBeVisible();
  await expect(page.getByText('Last 3 hours: 96% on average. Usual at this time of day: 10% (from 46 hours of history over 10 days).').first()).toBeVisible();
  await expect(page.getByText('Resembles mining: CPU held near full').first()).toBeVisible();
  await expect(page.getByText('1 abuse finding open').first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await noSidewaysScroll(page, 'unusual use at 390 px');
  await page.setViewportSize({ width: 1280, height: 720 });
  // The findings tab is as it was.
  await page.getByRole('tab', { name: /^Open/ }).click();
  await expect(page.getByRole('searchbox', { name: 'Search findings' })).toBeVisible();
});
