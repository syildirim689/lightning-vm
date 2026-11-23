import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Round two of the usability work (docs/ux-review.md, "Round 2"): accessibility checked by axe-core on the main pages
// in both themes, the Undo message for keyboard and screen readers, double submits, the server page's "what next"
// hints, "while you were away", copy buttons, and the command palette's tolerance for a typo. Runs after ux.spec.ts
// (files run in name order) on the deployment app.spec.ts set up, with its administrator; a server of the
// administrator's own is the one smart.spec.ts leaves (or one ordered here). Where a state cannot be made in minutes
// the answer of that one route is replaced by a prepared one, after the real route was checked; everything else is
// the real API. The tests do not build on each other. Tests named "@smoke" also run in Firefox and WebKit
// (playwright.config.ts).
test.use({ locale: 'en-US' });

const admin = { email: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test', password: process.env.E2E_ADMIN_PASSWORD ?? 'e2e admin passphrase 2026' };
const csrf = { 'x-lightning-csrf': '1' };
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> | undefined;

async function signInAdmin(page: Page, to = '/admin') {
  if (!cookies) { try { cookies = JSON.parse(readFileSync(join(tmpdir(), 'lightning-e2e-admin-session.json'), 'utf8')); } catch { /* run alone */ } }
  if (cookies) {
    await page.context().addCookies(cookies);
    if ((await page.request.get('/api/auth/me')).ok()) { await page.goto(to); return; }
    await page.context().clearCookies();
    cookies = undefined;
  }
  await page.goto('/login');
  await interactive(page); // typed before the page listens, the text would be lost (see app.spec.ts)
  await page.getByLabel(/E-posta|Email/).fill(admin.email);
  await page.getByLabel(/Parola|Password/).fill(admin.password);
  await page.getByRole('button', { name: /^(Giriş yap|Sign in)$/ }).click();
  await expect(page).toHaveURL(/\/admin$/);
  cookies = await page.context().cookies();
  // As app.spec.ts does: the next worker (a new one after a failure, or another browser) need not sign in again.
  try { writeFileSync(join(tmpdir(), 'lightning-e2e-admin-session.json'), JSON.stringify(cookies)); } catch { /* it signs in itself */ }
  if (to !== '/admin') await page.goto(to);
}
// A new, valid ed25519 public key each time (the panel refuses a key it already has).
function sshKey(comment: string) {
  const x = Buffer.from(generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const part = (b: Buffer) => { const n = Buffer.alloc(4); n.writeUInt32BE(b.length); return Buffer.concat([n, b]); };
  return `ssh-ed25519 ${Buffer.concat([part(Buffer.from('ssh-ed25519')), part(x)]).toString('base64')} ${comment}`;
}
const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
// A page has listened to the keyboard once its loading layer is hidden (as in app.spec.ts).
const interactive = (page: Page) => expect(page.locator('#boot-loader')).toHaveClass(/page-loader-hidden/, { timeout: 15_000 });
async function noSidewaysScroll(page: Page, label: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { message: `${label}: no sideways scrolling`, timeout: 5_000 }).toBeLessThanOrEqual(1);
}
// A ready server of the administrator's own (as smart.spec.ts does it).
async function ownServer(page: Page): Promise<{ id: string; name: string; address: string | null }> {
  type Row = { id: string; name: string; state: string; address: string | null };
  const mine = async () => ((await (await page.request.get('/api/servers')).json()) as { servers: Row[] }).servers;
  const ready = (await mine()).find((s) => s.state === 'ready');
  if (ready) return ready;
  const offered = await (await page.request.get('/api/catalog')).json() as { packages: { id: string; name: string; poolIds: string[]; imageIds: string[] }[] };
  const tiny = offered.packages.find((x) => x.name.includes('E2E Tiny')) ?? offered.packages[0];
  expect(tiny, 'a package to order (the catalog test of app.spec.ts opens one for sale)').toBeTruthy();
  const keys = (await (await page.request.get('/api/ssh-keys')).json() as { keys: { id: string }[] }).keys;
  const sshKey = keys[0]?.id ?? (await (await page.request.post('/api/ssh-keys', { headers: csrf,
    data: { name: 'e2e-ux2', publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMa0iBTtZu9kbSNXzg5M6pZ1rn8F1143iWq3JIcGimfn e2e' } })).json() as { id: string }).id;
  const ordered = await page.request.post('/api/servers', { headers: { ...csrf, 'idempotency-key': `e2e-ux2-${Date.now()}` },
    data: { type: 'package', poolId: tiny.poolIds[0], packageId: tiny.id, imageId: tiny.imageIds[0], name: 'e2e-ux2', sshKeyIds: [sshKey] } });
  expect(ordered.status(), await ordered.text()).toBe(202);
  const id = (await ordered.json() as { serverId: string }).serverId;
  await expect.poll(async () => (await mine()).find((s) => s.id === id)?.state, { timeout: 180_000, intervals: [2_000] }).toBe('ready');
  return (await mine()).find((s) => s.id === id)!;
}

// axe-core's WCAG 2.x A and AA rules; what fails the test is what axe calls serious or critical. Each one is named
// with the elements it was found on, so a failure says what to fix.
// Contrast is measured on what the page shows at rest: cards and lists fade in (motion writes the opacity inline), and
// a colour read half way through a fade is no colour the page has. So the check waits until no element is part way.
async function settle(page: Page) {
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[style*="opacity"]')]
    .filter((e) => { const o = Number(e.style.opacity); return o > 0 && o < 1; }).length
    + document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity).length),
  { timeout: 10_000, message: 'the page stood still' }).toBe(0).catch(() => undefined);
}
async function axe(page: Page, label: string) {
  await settle(page);
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  // Each finding with where it is and, for contrast and target size, the numbers axe measured.
  const detail = (n: { target: unknown[]; any: { data?: unknown }[] }) => {
    const d = n.any[0]?.data as { contrastRatio?: number; fgColor?: string; bgColor?: string; width?: number; height?: number } | undefined;
    return `${n.target.join(' ')}${d?.contrastRatio ? ` ${d.contrastRatio}:1 ${d.fgColor} on ${d.bgColor}` : d?.width ? ` ${Math.round(d.width)}x${Math.round(d.height ?? 0)}` : ''}`;
  };
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${label}: ${v.id} (${v.impact}) ${v.help} — ${v.nodes.slice(0, 4).map(detail).join(' | ')}`);
}
// The page has drawn what its API calls bring: its heading, and no loading placeholder left.
async function drawn(page: Page, heading: RegExp | string) {
  await interactive(page);
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  await expect(page.locator('[aria-busy="true"], .animate-pulse')).toHaveCount(0, { timeout: 15_000 }).catch(() => undefined);
}

const pages: [string, RegExp][] = [
  ['/admin', /Overview/], ['/admin/servers', /Servers/], ['/admin/users', /Users/], ['/admin/support', /Support queue/], ['/admin/settings', /Settings/],
  ['/admin/system', /System/], ['/', /Your servers/], ['/order', /New server|Order/], ['/billing', /Billing/], ['/support', /Support/], ['/account', /My account/], ['/firewalls', /Firewalls/],
];

for (const scheme of ['light', 'dark'] as const) test(`ux2: the main pages have no serious or critical accessibility problems (axe-core, ${scheme} theme)`, async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ locale: 'en-US', colorScheme: scheme, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const found: string[] = [];
  // Signed out first: the sign-in page and the public status page.
  for (const [path, heading] of [['/login', /Sign in/], ['/status', /status/i]] as const) {
    await page.goto(path);
    await drawn(page, heading);
    found.push(...await axe(page, `${path} (${scheme})`));
  }
  await signInAdmin(page);
  const server = await ownServer(page);
  for (const [path, heading] of [...pages, [`/servers/${server.id}`, new RegExp(server.name)] as [string, RegExp]]) {
    await page.goto(path);
    await drawn(page, heading);
    expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(scheme === 'dark');
    found.push(...await axe(page, `${path} (${scheme})`));
  }
  await context.close();
  expect(found, found.join('\n')).toEqual([]);
});

test('ux2: the Undo message is a region F6 reaches, is announced, keeps its time while focused and never takes the focus @smoke', async ({ page }) => {
  await page.clock.install();
  await signInAdmin(page, '/account?tab=keys');
  const name = `e2e-undo-${Date.now()}`;
  const made = await page.request.post('/api/ssh-keys', { headers: csrf, data: { name, publicKey: sshKey(name) } });
  expect(made.status(), await made.text()).toBe(201);
  await page.reload();
  await interactive(page);
  const row = page.locator('main li', { hasText: name }).first();
  await expect(row).toBeVisible();
  let deletes = 0;
  page.on('request', (r) => { if (r.method() === 'DELETE' && r.url().includes('/api/ssh-keys/')) deletes++; });
  const remove = row.getByRole('button', { name: /Remove|Delete/ });
  await remove.click();
  await expect(row).toHaveCount(0);
  const region = page.getByRole('region', { name: /notification/i });
  const message = region.getByRole('alertdialog');
  await expect(message).toBeVisible();
  // Announced (its text is an alert), and the focus stayed with the page, not in the message.
  await expect(message.getByRole('alert')).toContainText(name);
  const inMessage = () => page.evaluate(() => !!document.activeElement?.closest('[role="region"]:has([role="alertdialog"])'));
  expect(await inMessage()).toBe(false);
  // F6 moves between the page's landmarks and reaches the message; while it has the focus its time stands still.
  for (let i = 0; i < 6 && !(await inMessage()); i++) await page.keyboard.press('F6');
  expect(await inMessage(), 'F6 reaches the message').toBe(true);
  await page.clock.fastForward(10_000);
  await expect(message).toBeVisible();
  expect(deletes, 'nothing was sent while the message waited').toBe(0);
  // Undo from the keyboard: the key is back and the API never heard of the removal.
  const undo = message.getByRole('button', { name: 'Undo' });
  await undo.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('main li', { hasText: name }).first()).toBeVisible();
  expect(deletes).toBe(0);
  const keys = (await (await page.request.get('/api/ssh-keys')).json() as { keys: { id: string; name: string }[] }).keys;
  const key = keys.find((k) => k.name === name)!;
  expect(key).toBeTruthy();
  await page.request.delete(`/api/ssh-keys/${key.id}`, { headers: csrf });
});

test('ux2: a form pressed twice (Enter again, a double click) sends one request', async ({ page }) => {
  await signInAdmin(page, '/account?tab=keys');
  await interactive(page);
  let posts = 0;
  await page.route('**/api/ssh-keys', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posts++;
    // The answer takes a moment, as on a slow connection: the second press lands while the first is on its way.
    await new Promise((r) => setTimeout(r, 800));
    await route.fallback();
  });
  const name = `e2e-twice-${Date.now()}`;
  await page.getByLabel('Key name').fill(name);
  await page.getByLabel('Public key').fill(sshKey(name));
  await page.getByLabel('Public key').press('Enter').catch(() => undefined);
  const add = page.getByRole('button', { name: /^Add( key)?$/ });
  await add.dblclick({ force: true }).catch(() => undefined);
  await expect(page.locator('main li', { hasText: name }).first()).toBeVisible();
  expect(posts, 'one request for one intention').toBe(1);
  const key = (await (await page.request.get('/api/ssh-keys')).json() as { keys: { id: string; name: string }[] }).keys.filter((k) => k.name === name);
  expect(key.length).toBe(1);
  await page.unroute('**/api/ssh-keys');
  await page.request.delete(`/api/ssh-keys/${key[0].id}`, { headers: csrf });
});

test('ux2: a server page says what to do next from its real state; a hint leads to its part of the page and can be hidden', async ({ page }) => {
  await signInAdmin(page);
  const server = await ownServer(page);
  // The real route first: whatever this server's state, the answer is well formed and names only known hints.
  const real = await (await page.request.get(`/api/servers/${server.id}/hints`)).json() as { hints: { code: string; key: string }[]; hidden: number };
  for (const h of real.hints) {
    expect(['NO_BACKUP', 'NO_FIREWALL', 'ROOT_PASSWORD_KEPT', 'SNAPSHOTS_OLD']).toContain(h.code);
    expect(h.key).toBe(`hint:${h.code}:${server.id}`);
  }
  // Then a prepared state with two hints.
  let hints = [
    { code: 'NO_FIREWALL', severity: 'warning', key: `hint:NO_FIREWALL:${server.id}`, params: {}, action: { href: '/firewalls' } },
    { code: 'SNAPSHOTS_OLD', severity: 'info', key: `hint:SNAPSHOTS_OLD:${server.id}`, params: { n: 2, days: 30 }, action: { section: 'snapshots' } },
  ];
  await page.route(`**/api/servers/${server.id}/hints`, (route) => json(route, { hints, hidden: 0, snapshotDays: 30 }));
  await page.goto(`/servers/${server.id}`);
  const box = page.locator('[data-hints]');
  await expect(box.getByText('No firewall attached')).toBeVisible();
  await expect(box.getByText('2 snapshots older than 30 days')).toBeVisible();
  await expect(box.getByRole('link', { name: 'Choose a firewall' })).toHaveAttribute('href', '/firewalls');
  // "Go to snapshots" brings the Snapshots section into view and its first control into focus.
  await box.getByRole('button', { name: 'Go to snapshots' }).click();
  const section = page.locator('[data-section="Snapshots"]');
  await expect.poll(() => section.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0; })).toBe(true);
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-section="Snapshots"]'))).toBe(true);
  // Hidden for a week: one request with the hint's key and 7 days; the hint goes.
  const hidden = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith('/api/insights/dismissals'));
  await page.route('**/api/insights/dismissals', (route) => route.request().method() === 'PUT' ? route.fulfill({ status: 204 }) : route.fallback());
  await box.getByRole('button', { name: 'Hide: No firewall attached' }).click();
  hints = hints.filter((h) => h.code !== 'NO_FIREWALL');
  await page.getByRole('menuitem', { name: 'For a week' }).click();
  expect((await hidden).postDataJSON()).toEqual({ key: `hint:NO_FIREWALL:${server.id}`, days: 7 });
  await expect(box.getByText('No firewall attached')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await noSidewaysScroll(page, 'server hints at 390 px');
  await page.setViewportSize({ width: 1280, height: 720 });
  // The overview copies the address and the id.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
  if (server.address) {
    await page.getByRole('button', { name: 'Copy: IP' }).first().click();
    await expect(page.getByText('IP copied')).toBeVisible();
  }
  await page.getByRole('button', { name: 'Copy: ID' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()).catch(() => '')).toBe(server.id);
});

test('ux2: "while you were away" lists one\'s own finished and failed work, invoices and answers with links; "Seen" is only a click', async ({ page }) => {
  await signInAdmin(page, '/');
  // The real route: well formed (this administrator's inbox may hold anything by now).
  const real = await (await page.request.get('/api/notifications/away')).json() as { since: string; total: number; counts: Record<string, number> };
  expect(Object.keys(real.counts).sort()).toEqual(['billing', 'done', 'failed', 'support']);
  const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const item = (id: string, event: string, kind: string, title: string, link: string, min: number) => ({ id, event, kind, title, body: '', link, texts: null, createdAt: at(min), readAt: null });
  let away = { since: at(600), total: 3, counts: { done: 1, failed: 1, billing: 0, support: 1 }, items: [
    item('00000000-0000-4000-8000-000000000001', 'server.ready', 'done', 'web-9 is ready', '/servers/00000000-0000-4000-8000-0000000000aa', 30),
    item('00000000-0000-4000-8000-000000000002', 'server.failed', 'failed', 'web-8: resize failed', '/servers/00000000-0000-4000-8000-0000000000bb', 90),
    item('00000000-0000-4000-8000-000000000003', 'support.reply', 'support', 'New answer on #12', '/support/00000000-0000-4000-8000-0000000000cc', 120),
  ] };
  await page.route('**/api/notifications/away', (route) => json(route, away));
  let seenBody: unknown = null;
  await page.route('**/api/notifications/away/seen', (route) => { seenBody = route.request().postDataJSON(); return route.fulfill({ status: 204 }); });
  await page.reload();
  const card = page.locator('[data-away]');
  await expect(card.getByRole('heading', { name: 'While you were away' })).toBeVisible();
  await expect(card.locator('[data-count="failed"]')).toHaveText('1 failed');
  await expect(card.locator('[data-count="support"]')).toHaveText('1 ticket answer');
  await expect(card.locator('[data-count="done"]')).toHaveText('1 finished');
  // Worst first, each a link to where it happened.
  const links = card.getByRole('link');
  await expect(links).toHaveCount(3);
  await expect(links.nth(0)).toContainText('web-8: resize failed');
  await expect(links.nth(0)).toHaveAttribute('href', '/servers/00000000-0000-4000-8000-0000000000bb');
  await page.setViewportSize({ width: 390, height: 844 });
  await noSidewaysScroll(page, 'away list at 390 px');
  await page.setViewportSize({ width: 1280, height: 720 });
  // Nothing was marked seen by looking; "Seen" sends the ids it showed and the card goes.
  expect(seenBody).toBeNull();
  away = { ...away, total: 0, counts: { done: 0, failed: 0, billing: 0, support: 0 }, items: [] };
  await card.getByRole('button', { name: 'Seen' }).click();
  await expect.poll(() => seenBody).toEqual({ ids: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'] });
  await expect(card).toHaveCount(0);
});

test('ux2: the command palette forgives a typo, and finds a server by its address @smoke', async ({ page }) => {
  await signInAdmin(page);
  await interactive(page);
  const palette = async () => { await page.keyboard.press('ControlOrMeta+k'); await expect(page.locator('[data-palette]')).toBeFocused(); };
  await palette();
  await page.locator('[data-palette]').fill('systme');
  await expect(page.getByRole('option', { name: /^System/ }).first()).toBeVisible();
  await page.locator('[data-palette]').fill('xqzv');
  await expect(page.getByRole('option')).toHaveCount(0);
  await page.keyboard.press('Escape');
  const servers = (await (await page.request.get('/api/servers')).json() as { servers: { name: string; address: string | null }[] }).servers.filter((s) => s.address);
  if (servers.length) {
    await palette();
    await page.locator('[data-palette]').fill(servers[0].address!);
    await expect(page.getByRole('option', { name: new RegExp(`^${servers[0].name}`) }).first()).toBeVisible();
    await page.keyboard.press('Escape');
  }
});

test('ux2: the sign-in page and the dashboard work in this browser @smoke', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByLabel(/Email/)).toBeVisible();
  await signInAdmin(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Your servers' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await noSidewaysScroll(page, 'dashboard at 390 px');
});
