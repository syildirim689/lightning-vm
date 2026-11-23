import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The live walls (/wall/system, /wall/stats, /wall/energy). Runs after app.spec.ts on the deployment it set up (its
// administrator). The test machines draw WebGL with a software renderer (or not at all), so nothing here depends on
// the frame rate: the 3D checks read what the engine reports, and are said to be skipped where there is no WebGL.
// Host figures change every five seconds, so the answer of GET /admin/host/live is a prepared one (on top of the real
// answer) wherever two screens are compared; everything else the walls ask for is the real API.
test.use({ locale: 'en-US' });

const admin = { email: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test', password: process.env.E2E_ADMIN_PASSWORD ?? 'e2e admin passphrase 2026' };
const csrf = { 'x-lightning-csrf': '1' };
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> | undefined;
// The administrator's session, as smart.spec.ts takes it: left by app.spec.ts (sign-in is limited per address), or
// a sign-in of its own when this file runs alone.
async function signInAdmin(page: Page) {
  if (!cookies) { try { cookies = JSON.parse(readFileSync(join(tmpdir(), 'lightning-e2e-admin-session.json'), 'utf8')); } catch { /* run alone */ } }
  if (cookies) {
    await page.context().addCookies(cookies);
    if ((await page.request.get('/api/auth/me')).ok()) return;
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
const now = Date.now(), iso = (ago: number) => new Date(now - ago).toISOString();
const svc = (service: string, over: Record<string, unknown>) => ({ service, state: 'running', health: 'healthy', kind: 'healthy', fault: false, oneShot: false, status: '', cpu: 1.2, memory: '40MiB', memoryPercent: 1,
  restarts: 0, startedAt: iso(3_600_000), finishedAt: '0001-01-01T00:00:00Z', exitCode: 0, version: { panel: true, version: 'v0.5.1', commit: 'abc1234' },
  rule: { restart: true, run: false, refused: '', interrupts: 'none' }, ...over });
// What the host agent and /proc would say: a worker that fails its health check and a monitoring service that exited.
async function hostAnswer(page: Page) {
  await page.route('**/api/admin/host/live', async (route: Route) => {
    const real = await (await route.fetch()).json();
    const t = Date.now();
    await route.fulfill({ json: { ...real, supported: true, cpu: { ...real.cpu, percent: 42.5, cores: 4, load: [1.25, 1, 0.75] }, memory: { total: 8e9, available: 2e9, used: 6e9, cached: 1e9, swapTotal: 0, swapUsed: 0 },
      disk: { total: 100e9, free: 40e9 }, history: Array.from({ length: 60 }, (_, i) => ({ at: t - (60 - i) * 5_000, cpu: 30 + (i % 10), memory: 70 + (i % 5), load: 1 + (i % 3) / 4 })),
      state: { checkedAt: new Date(t - 30_000).toISOString(), services: [svc('api', {}), svc('web', {}), svc('migrate', { state: 'exited', kind: 'completed', oneShot: true, cpu: 0 }),
        svc('worker', { health: 'unhealthy', kind: 'unhealthy', fault: true, restarts: 3 }), svc('grafana', { state: 'exited', kind: 'failed', fault: true, exitCode: 1, cpu: 0 })],
        disks: [], inodesPercent: 1, processes: [], failedUnits: [], addresses: [], dockerDisk: [], docker: '', users: 0 },
      agent: { installed: false, busy: false } } });
  });
}
// No WebGL at all: what an old browser, a locked-down machine or a remote desktop without a GPU gives.
const noWebgl = () => {
  const real = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
    return /webgl/i.test(kind) ? null : (real as (...a: unknown[]) => unknown).call(this, kind, ...rest);
  } as typeof real;
};
// Every WebGL context the page makes is kept, to ask afterwards whether it was given back.
const keepContexts = () => {
  const real = HTMLCanvasElement.prototype.getContext;
  const all: WebGLRenderingContext[] = ((window as unknown as { __gls: WebGLRenderingContext[] }).__gls = []);
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
    const c = (real as (...a: unknown[]) => unknown).call(this, kind, ...rest);
    if (c && /webgl/i.test(kind) && !all.includes(c as WebGLRenderingContext)) all.push(c as WebGLRenderingContext);
    return c;
  } as typeof real;
};
const figures = ['cpu', 'memory', 'disk', 'load'] as const;
const values = (page: Page) => Promise.all(figures.map((f) => page.getByTestId(`wall-value-${f}`).textContent()));

test('live walls: a labelled way in beside each page\'s status; the wall shows the page\'s own figures, and without WebGL the 2D wall shows the same ones', async ({ page, browser }) => {
  await signInAdmin(page);
  await hostAnswer(page);
  // Admin → System: the link sits right before the "All good" / "N warnings" verdict, on its line.
  await page.goto('/admin/system');
  const link = page.getByRole('link', { name: 'Open the live wall (System)' });
  const verdict = page.getByText(/^(All good|\d+ warnings)$/).first();
  await expect(link).toBeVisible();
  await expect(verdict).toBeVisible();
  const [a, b] = [await link.boundingBox(), await verdict.boundingBox()];
  expect(a!.x + a!.width, 'the link is left of the verdict').toBeLessThanOrEqual(b!.x);
  expect(b!.x - (a!.x + a!.width), 'and next to it').toBeLessThan(24);
  expect(Math.abs((a!.y + a!.height / 2) - (b!.y + b!.height / 2)), 'on the same line').toBeLessThan(8);
  await expect(link).toHaveAttribute('href', '/wall/system');
  for (const [path, name] of [['/admin/stats', 'Statistics'], ['/admin/energy', 'Energy']]) {
    await page.goto(path);
    await expect(page.getByRole('link', { name: `Open the live wall (${name})` })).toHaveAttribute('href', `/wall/${name === 'Statistics' ? 'stats' : 'energy'}`);
  }

  await page.goto('/admin/system');
  await page.getByRole('link', { name: 'Open the live wall (System)' }).click();
  await expect(page).toHaveURL(/\/wall\/system$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('System, live');
  await expect(page.locator('[data-wall-renderer]')).not.toHaveAttribute('data-wall-renderer', 'probing');
  // The figures are the answer's: 42.5 % processor, 75 % memory, 60 % disk, load 1.25 on 4 cores; two faults.
  await expect(page.getByTestId('wall-value-cpu')).toHaveText('42.5%');
  const shown = await values(page);
  expect(shown).toEqual(['42.5%', '75%', '60%', '1.25']);
  await expect(page.getByTestId('wall-verdict')).toHaveText('2 warnings');
  await expect(page.getByTestId('wall-faults')).toContainText('worker');
  await expect(page.getByTestId('wall-faults')).toContainText('grafana');
  await expect(page.getByTestId('wall-updated')).toContainText('Updated');
  const renderer = await page.locator('[data-wall-renderer]').getAttribute('data-wall-renderer');
  test.info().annotations.push({ type: 'renderer', description: `${renderer} (${await page.locator('[data-wall-renderer]').getAttribute('data-wall-reason') || await page.locator('[data-wall-renderer]').getAttribute('data-wall-tier')})` });

  // The same wall in a browser without WebGL: the 2D wall, saying why, with the same figures and the rack in words.
  const flat = await browser.newContext({ locale: 'en-US' });
  await flat.addCookies(await page.context().cookies());
  await flat.addInitScript(noWebgl);
  const p2 = await flat.newPage();
  await hostAnswer(p2);
  await p2.goto('/wall/system');
  await expect(p2.locator('[data-wall-renderer]')).toHaveAttribute('data-wall-renderer', '2d');
  await expect(p2.locator('[data-wall-renderer]')).toHaveAttribute('data-wall-reason', 'no-webgl');
  await expect(p2.getByTestId('wall-flat-reason')).toHaveText('2D: this browser has no WebGL 2');
  await expect(p2.getByTestId('wall-value-cpu')).toHaveText('42.5%');
  expect(await values(p2)).toEqual(shown);
  const rack = p2.getByTestId('wall-flat-system');
  await expect(rack.getByRole('listitem').filter({ hasText: 'grafana' })).toContainText('FAULT');
  await expect(rack.getByRole('listitem').filter({ hasText: 'migrate' })).toContainText('Completed');
  await expect(rack.getByRole('listitem').filter({ hasText: 'migrate' })).not.toContainText('FAULT');
  await expect(p2.getByRole('meter', { name: 'Processor' })).toHaveAttribute('aria-valuenow', '43');
  await flat.close();
});

test('live walls: statistics and energy show the real answers of their pages, and say when there is nothing to show', async ({ page }) => {
  await signInAdmin(page);
  const stats = await (await page.request.get('/api/admin/stats?days=30&tz=UTC')).json() as { kpis: { servers: { value: number } } };
  await page.goto('/wall/stats?quality=2d');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Statistics, live');
  await expect(page.getByTestId('wall-value-servers')).toHaveText(String(stats.kpis.servers.value));
  await expect(page.getByTestId('wall-rows').getByRole('listitem')).toHaveCount(7);
  await expect(page.getByTestId('wall-flat-stats')).toBeVisible();
  // Energy: the test stack's simulators may or may not have been sampled; either way the wall says what it knows.
  const power = await (await page.request.get('/api/admin/power?range=1d')).json() as { now: { hosts: number }; hosts: { lastAt: string }[] };
  // Each host carries the time of its newest sample (what tells "now" from "earlier today" on the wall).
  for (const h of power.hosts) expect(Date.parse(h.lastAt), JSON.stringify(h)).toBeGreaterThan(Date.now() - 86_400_000 - 60_000);
  await page.goto('/wall/energy?quality=2d');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Energy, live');
  if (power.now.hosts === 0) await expect(page.getByTestId('wall-noflow')).toHaveText('No power sample in the last 15 minutes');
  else await expect(page.getByTestId('wall-value-power')).toHaveText(/kW$/);
  // A refused or failed answer is not drawn as data: the bar says so and offers to try again.
  await page.route(/\/api\/admin\/power\?range=1d$/, (r) => r.fulfill({ status: 503, json: { code: 'DEPENDENCY_UNAVAILABLE', message: 'x' } }));
  await page.goto('/wall/energy?quality=2d');
  await expect(page.getByTestId('wall-updated')).toContainText('The panel did not answer');
  await expect(page.getByTestId('wall-updated').getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByTestId('wall-value-power')).toHaveCount(0);
});

test('a live wall in 3D: drawn where the browser has WebGL, still for reduced motion, fits 390 px, keys move between walls and back, and leaving gives the context back', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await signInAdmin(page);
  await context.addInitScript(keepContexts);
  await hostAnswer(page);
  // low: 3D even on a software renderer, which on its own would get the 2D wall.
  await page.goto('/wall/system?quality=low');
  const wall = page.locator('[data-wall-renderer]');
  await expect(wall).not.toHaveAttribute('data-wall-renderer', 'probing');
  await expect(wall).toHaveAttribute('data-motion', 'still');
  await expect(page.getByTestId('wall-value-cpu')).toHaveText('42.5%');
  // 390 px: no sideways scrolling; the scene on top, the figures below it.
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  const threeD = (await wall.getAttribute('data-wall-renderer')) === 'webgl';
  if (!threeD) {
    test.info().annotations.push({ type: 'skipped', description: `no WebGL 2 in this browser (${await wall.getAttribute('data-wall-reason')}): the 3D checks did not run` });
  } else {
    const canvas = page.getByTestId('wall-canvas');
    const figuresBox = await page.getByRole('region', { name: 'Figures' }).boundingBox();
    const canvasBox = await canvas.boundingBox();
    expect(canvasBox!.y + canvasBox!.height).toBeLessThanOrEqual(figuresBox!.y + 1);
    expect(canvasBox!.width).toBeLessThanOrEqual(390);
    // Frames are drawn (however slowly), and with reduced motion the camera does not move between them.
    type Status = { frames: number; camera: number[]; tier: string };
    const status = () => canvas.evaluate((c) => (c as unknown as { wallStatus?: () => unknown }).wallStatus?.() ?? null) as Promise<Status | null>;
    await expect.poll(async () => (await status())?.frames ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
    const first = (await status())!;
    expect(first.tier).toBe('low');
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1_500)));
    expect((await status())!.camera).toEqual(first.camera);
    // The tour is offered but off, and cannot be turned on while the device asks for less motion.
    await expect(page.getByRole('button', { name: 'Tour' })).toBeDisabled();
  }
  // Keys: → is the next wall this person may open, Esc goes back to its page.
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/\/wall\/stats\?quality=low$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Statistics, live');
  // The statistics scene is built and drawing (on a software renderer, building it holds the page for a few seconds).
  if (threeD) {
    await expect.poll(() => page.getByTestId('wall-canvas').evaluate((c) => ((c as unknown as { wallStatus?: () => { frames: number } }).wallStatus?.().frames ?? 0)), { timeout: 15_000 }).toBeGreaterThan(0);
    // It draws into a context of its own: the previous scene's was given back and cannot draw again.
    expect(await page.getByTestId('wall-canvas').evaluate((c) => (c as HTMLCanvasElement).getContext('webgl2')?.isContextLost())).toBe(false);
  }
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/admin\/stats$/);
  // Leaving: every WebGL context the wall made (the probe's and the scenes') has been given back.
  const contexts = await page.evaluate(() => { const all = (window as unknown as { __gls?: WebGLRenderingContext[] }).__gls ?? []; return { n: all.length, lost: all.filter((g) => g.isContextLost()).length }; });
  if (threeD) expect(contexts.n).toBeGreaterThanOrEqual(2);
  expect(contexts.lost).toBe(contexts.n);
  await context.close();
});

test('a customer cannot open a live wall: the page refuses, nothing is drawn, the API refuses its reads too', async ({ page, browser }) => {
  await signInAdmin(page);
  // Registration is opened by app.spec.ts; opened here if it is not (and closed again afterwards).
  const before = (await (await page.request.get('/api/admin/settings')).json() as { registrationOpen: boolean }).registrationOpen;
  if (!before) expect((await page.request.put('/api/admin/settings', { headers: csrf, data: { registrationOpen: true } })).ok()).toBe(true);
  const context = await browser.newContext({ locale: 'en-US' });
  const customer = await context.newPage();
  await customer.goto('/register');
  await customer.getByLabel('Email').fill(`wall-${Date.now()}@example.test`);
  await customer.getByLabel('Password').fill('e2e wall passphrase 2026');
  await customer.getByRole('button', { name: 'Create account' }).click();
  // Signed in as the new customer (the page then goes on to the start page; the walls are what is tried here).
  await expect.poll(async () => (await customer.request.get('/api/auth/me')).status()).toBe(200);
  for (const scene of ['system', 'stats', 'energy']) {
    await customer.goto(`/wall/${scene}`);
    await expect(customer.locator('main [role=alert]')).toContainText('does not have permission for this action.');
    await expect(customer.getByTestId('wall-canvas')).toHaveCount(0);
  }
  for (const path of ['/api/admin/host/live', '/api/admin/stats', '/api/admin/power']) expect((await customer.request.get(path)).status(), path).toBe(403);
  await context.close();
  if (!before) await page.request.put('/api/admin/settings', { headers: csrf, data: { registrationOpen: false } });
});
