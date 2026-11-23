import { expect, test, type BrowserContext, type Locator, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The panel's everyday helpers: the setup checklist, the connection banner, the session warning, pasting, the order
// form's remembered choices and the operation time estimate. Runs after app.spec.ts and smart.spec.ts (files run in
// name order, one worker) on the deployment app.spec.ts set up, with its administrator. Where a state cannot be made
// in minutes (a session about to end, a regressed installation, a long history of operations) the answer of that one
// API route is replaced by a prepared one; everything else is the real API. The tests do not build on each other.
test.use({ locale: 'en-US' });

const admin = { email: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test', password: process.env.E2E_ADMIN_PASSWORD ?? 'e2e admin passphrase 2026' };
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> | undefined;

// The administrator's session, as smart.spec.ts gets it: app.spec.ts leaves one for the files after it.
async function signInAdmin(page: Page) {
  if (!cookies) { try { cookies = JSON.parse(readFileSync(join(tmpdir(), 'lightning-e2e-admin-session.json'), 'utf8')); } catch { /* run alone */ } }
  if (cookies) {
    await page.context().addCookies(cookies);
    if ((await page.request.get('/api/auth/me')).ok()) { await page.goto('/admin'); return; }
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
// A paste as the browser delivers it (clipboard text in a paste event), into this field.
async function paste(field: Locator, text: string) {
  await field.click();
  await field.press('ControlOrMeta+a');
  await field.evaluate((el, t) => { const dt = new DataTransfer(); dt.setData('text/plain', t); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, text);
}

test('ux: the setup checklist is read from the installation, can be put away, and comes back when something that was fine breaks', async ({ page }) => {
  await signInAdmin(page);
  // The true state of the test deployment first: whatever it says, every open step links to where it is fixed.
  const real = await (await page.request.get('/api/admin/onboarding')).json() as { steps: { key: string; group: string; done: boolean; link: string }[] };
  expect(real.steps.length).toBeGreaterThanOrEqual(11);
  expect(real.steps.filter((s) => s.group === 'health').map((s) => s.key)).toEqual(expect.arrayContaining(['backupSchedule', 'staffTwoFactor']));
  // Then a prepared state: everything to start with is done, three health steps are open.
  const base = [
    ...['connection', 'location', 'pool', 'image', 'package', 'ip', 'mail', 'backup', 'twoFactor'].map((key) => ({ key, group: 'start', done: true, link: '/admin' })),
    { key: 'mailDelivers', group: 'health', done: true, link: '/admin/settings?tab=mail' },
    { key: 'backupSchedule', group: 'health', done: false, link: '/admin/system', detail: { schedule: 'off' } },
    { key: 'monitoring', group: 'health', done: false, link: '/admin/system', detail: { state: 'partial' } },
    { key: 'staffTwoFactor', group: 'health', done: false, link: '/admin/users', detail: { n: 2 } },
  ];
  let steps = base;
  await page.route('**/api/admin/onboarding', (route) => json(route, { steps }));
  await page.evaluate(() => localStorage.removeItem('lvm-setup-hidden'));
  await page.goto('/admin');
  const list = page.locator('[data-section="Keep it healthy"]');
  await expect(list).toBeVisible();
  await expect(list.getByText('Backup schedule: off (no timer on the host)')).toBeVisible();
  await expect(list.getByText('Monitoring is only partly up')).toBeVisible();
  await expect(list.getByText('2 staff accounts sign in without two-factor')).toBeVisible();
  await expect(list.locator('[data-step="staffTwoFactor"]')).toHaveAttribute('href', '/admin/users');
  await expect(list).toContainText('Read from this installation');
  await page.setViewportSize({ width: 390, height: 844 });
  await noSidewaysScroll(page, 'setup checklist at 390 px');
  await page.setViewportSize({ width: 1280, height: 720 });
  // Put away: it stays away after a reload while nothing changes, also when an open step gets fixed.
  await list.getByRole('button', { name: 'Hide until something changes' }).click();
  await expect(list).toHaveCount(0);
  steps = base.map((s) => (s.key === 'monitoring' ? { ...s, done: true } : s));
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(list).toHaveCount(0);
  // Mail stops going out: the list is back and says why.
  steps = base.map((s) => (s.key === 'mailDelivers' ? { ...s, done: false, detail: { at: new Date(Date.now() - 2 * 3_600_000).toISOString(), code: 'MAIL_AUTH_FAILED' } } : s));
  await page.reload();
  await expect(list).toBeVisible();
  await expect(list.getByRole('status')).toHaveText(/Back because something changed: Make mail go out again/);
  await expect(list.getByText(/The last message failed 2 hours ago: /)).toBeVisible();
  await page.unroute('**/api/admin/onboarding');
  await page.evaluate(() => localStorage.removeItem('lvm-setup-hidden'));
});

test('ux: when the panel stops answering, lists pause and one small request retries; it resumes without a reload', async ({ page }) => {
  await signInAdmin(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // Every API request fails as a stopped server's would; the health probe too, for now.
  let down = true;
  const seen: string[] = [];
  await page.route('**/api/**', (route) => { seen.push(new URL(route.request().url()).pathname); return down ? route.abort('connectionrefused') : route.fallback(); });
  // Two failed requests in a row bring the banner (one blip does not). The lists would get there on their next poll;
  // here a reload of the page's data does it at once (every list refetches, every request is refused).
  await page.evaluate(() => window.dispatchEvent(new Event('lvm:session-back')));
  const banner = page.locator('[data-connection="server"]');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('The panel server is not answering');
  await expect(banner).toContainText(/Trying again in \d+ s\. Lists are paused meanwhile/);
  // While it lasts, nothing but the health probe goes out: the lists' polling is paused. (The live line, an
  // EventSource, reconnects by itself as browsers do; it is not a list.)
  seen.length = 0;
  await page.waitForTimeout(3_000);
  expect(seen.filter((p) => p !== '/api/health' && p !== '/api/live')).toEqual([]);
  // Back: "Try now" finds it, the banner goes, the page is refreshed in place.
  down = false;
  await banner.getByRole('button', { name: 'Try now' }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByText('Back online; the page is up to date.')).toBeVisible();
  await expect.poll(() => seen.filter((p) => p !== '/api/health' && p !== '/api/live').length, { timeout: 10_000 }).toBeGreaterThan(0);
  await page.unroute('**/api/**');
});

test('ux: five minutes before the session ends a bar says when and why; "Stay signed in" renews it only on the click', async ({ page }) => {
  await signInAdmin(page);
  const me = await (await page.request.get('/api/auth/me')).json() as { session: { kind: string; why: string; msLeft: number } | null };
  // The real session: a remembered local sign-in, renewable, hours away.
  expect(me.session?.kind).toBe('renewable');
  expect(me.session!.msLeft).toBeGreaterThan(30 * 60_000);
  // The same answer, as if only four minutes were left.
  let soon = true;
  await page.route('**/api/auth/me', async (route) => {
    const r = await route.fetch();
    const body = await r.json();
    return json(route, soon ? { ...body, session: { ...body.session, msLeft: 4 * 60_000 } } : body);
  });
  await page.goto('/');
  const bar = page.locator('[data-session-clock]');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText(/Your session ends in [34]:\d\d \(at /);
  await expect(bar).toContainText(/Sessions last a fixed time after signing in|The session ends after a long time without use/);
  await page.setViewportSize({ width: 390, height: 844 });
  await noSidewaysScroll(page, 'session warning at 390 px');
  await page.setViewportSize({ width: 1280, height: 720 });
  soon = false;
  const stayed = page.waitForResponse((r) => r.url().endsWith('/api/auth/stay') && r.request().method() === 'POST');
  await bar.getByRole('button', { name: 'Stay signed in' }).click();
  const answer = await stayed;
  expect(answer.status()).toBe(200);
  expect((await answer.json()).session.msLeft).toBeGreaterThanOrEqual(me.session!.msLeft - 60_000);
  await expect(bar).toHaveCount(0);
  await expect(page.getByText(/You stay signed in until/)).toBeVisible();
  // A fixed end ("sign in as", a directory account, a role's limit) gets the reason and no "stay".
  await page.unroute('**/api/auth/me');
  await page.route('**/api/auth/me', async (route) => { const body = await (await route.fetch()).json(); return json(route, { ...body, session: { ...body.session, msLeft: 3 * 60_000, kind: 'fixed', why: 'role' } }); });
  await page.reload();
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('Your role allows sessions of a limited length');
  await expect(bar.getByRole('button', { name: 'Stay signed in' })).toHaveCount(0);
  await bar.getByRole('button', { name: 'Got it' }).click();
  await expect(bar).toHaveCount(0);
  await page.unroute('**/api/auth/me');
  // The API refuses to extend a fixed end by itself too (here: the test session is renewable, so it is extended).
  expect((await page.request.post('/api/auth/stay', { headers: { 'x-lightning-csrf': '1' } })).status()).toBe(200);
});

test('ux: a pasted SSH key is joined and named, a private key is refused at once, and a one-per-line list keeps its entries apart', async ({ page }) => {
  await signInAdmin(page);
  await page.goto('/account?tab=keys');
  const field = page.getByLabel(/^Public key/);
  // A key broken over three lines, as mail or a narrow terminal leaves it.
  const blob = 'AAAAC3NzaC1lZDI1NTE5AAAAIMa0iBTtZu9kbSNXzg5M6pZ1rn8F1143iWq3JIcGimfn';
  await paste(field, `ssh-ed25519 ${blob.slice(0, 30)}\n${blob.slice(30)}\nlaptop@home\n`);
  await expect(field).toHaveValue(`ssh-ed25519 ${blob} laptop@home`);
  await expect(page.getByText('ED25519 key, 256 bits · laptop@home')).toBeVisible();
  await expect(page.getByText(/The pasted text was put on one line/)).toBeVisible();
  // A private key is named for what it is before the field is even left.
  await field.fill('-----BEGIN OPENSSH PRIVATE KEY-----');
  await expect(page.getByText(/This is a PRIVATE key\. Never paste it anywhere/)).toBeVisible();
  await field.fill('');
  // A firewall's sources (app.spec.ts made firewalls): a list pasted one address per line keeps its entries apart.
  const firewalls = (await (await page.request.get('/api/firewalls')).json() as { firewalls: { id: string; rules: unknown[] }[] }).firewalls.filter((f) => f.rules.length);
  test.skip(!firewalls.length, 'no firewall with rules to paste into');
  await page.goto(`/firewalls/${firewalls[0].id}`);
  const sources = page.getByLabel('Source addresses').first();
  await paste(sources, '203.0.113.10\n198.51.100.0/24\r\n2001:db8::1\n');
  await expect(sources).toHaveValue(/203\.0\.113\.10, 198\.51\.100\.0\/24, 2001:db8::1$/);
  await page.getByRole('button', { name: 'Discard' }).click();
});

test('ux: the order form starts from the newest server and says so; "Start empty" clears it', async ({ page }) => {
  await signInAdmin(page);
  const mine = (await (await page.request.get('/api/servers')).json() as { servers: { name: string; state: string; createdAt: string; poolId: string; vdcId?: string | null }[] }).servers
    .filter((s) => s.state !== 'deleting' && !s.vdcId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const offered = (await (await page.request.get('/api/catalog')).json() as { pools: { id: string }[] }).pools.map((p) => p.id);
  test.skip(!mine.length || !offered.includes(mine[0].poolId), 'no server whose location is still offered to start from');
  await page.goto('/');
  await page.evaluate(() => sessionStorage.removeItem('lvm-order'));
  await page.goto('/order');
  const note = page.locator('[data-remembered]');
  await expect(note).toContainText(`Filled in from your last server, ${mine[0].name}`);
  await expect(note).toContainText(/Taken over where still offered: location/);
  await note.getByRole('button', { name: 'Start empty' }).click();
  await expect(note).toHaveCount(0);
  // A draft being composed is left alone: a reload keeps the form as it is, without the note.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(note).toHaveCount(0);
});

test('ux: a running operation says how long such operations usually take here, and when it is taking longer', async ({ page }) => {
  await signInAdmin(page);
  // The real estimates of a fresh deployment: whatever there is, only kinds with enough history.
  const real = await (await page.request.get('/api/operations/estimates')).json() as { estimates: Record<string, { all: { n: number } | null }>; minSamples: number };
  expect(real.minSamples).toBe(5);
  for (const e of Object.values(real.estimates)) if (e.all) expect(e.all.n).toBeGreaterThanOrEqual(5);
  const started = new Date(Date.now() - 40_000).toISOString();
  await page.route('**/api/operations/estimates', (route) => json(route, { estimates: { resize: { all: { median: 150, p90: 240, n: 14 }, sizes: { s: { median: 110, p90: 160, n: 9 } } } }, minSamples: 5, windowDays: 90 }));
  await page.route('**/api/operations/active**', (route) => json(route, { operations: [
    { id: '00000000-0000-4000-8000-000000000001', kind: 'resize', status: 'running', step: 'resize', attempts: 1, errorCode: null, createdAt: started, startedAt: started, finishedAt: null, serverId: '00000000-0000-4000-8000-000000000002', serverName: 'eta-demo', diskGb: 20 },
    { id: '00000000-0000-4000-8000-000000000003', kind: 'resize', status: 'running', step: 'resize', attempts: 1, errorCode: null, createdAt: new Date(Date.now() - 600_000).toISOString(), startedAt: null, finishedAt: null, serverId: '00000000-0000-4000-8000-000000000004', serverName: 'eta-slow', diskGb: 20 },
  ] }));
  await page.goto('/');
  await page.getByRole('button', { name: /2 running/ }).click();
  const tasks = page.getByRole('region', { name: 'Background work' });
  await expect(tasks.getByRole('button', { name: /eta-demo/ })).toContainText('Usually about 2 minutes');
  await expect(tasks.getByRole('button', { name: /eta-demo/ }).locator('[data-eta]')).toHaveAttribute('title', /Median of the last 9 successful “Change size” operations on this panel, for disks of this size/);
  await expect(tasks.getByRole('button', { name: /eta-slow/ })).toContainText('Taking longer than usual (usually about 2 minutes)');
  await page.unroute('**/api/operations/active**');
  await page.unroute('**/api/operations/estimates');
});

test('ux: "?" lists the keyboard shortcuts and Escape closes the list', async ({ page }) => {
  await signInAdmin(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.locator('body').press('?');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Ctrl');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
