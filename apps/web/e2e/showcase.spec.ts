import { expect, test, type APIResponse, type Page } from '@playwright/test';

// The pictures of the README and the landing site (docs/screenshots/tr and docs/screenshots/en): six screens, each
// taken twice from the same page with the same data, once in Turkish and once in English.
//
// Not part of the normal run: playwright.config.ts leaves this file out unless the run asks for it (E2E_SHOWCASE=1, or
// a title filter that names it, which is how the demo server's script passes it on):
//   sh /root/demo-e2e.sh <commit> showcase        (DEMO_E2E_SKIP_UPDATE=1 to leave the demo alone)
//   -> /opt/e2e/tour/showcase/{tr,en}/<name>.png
// It needs a deployment nobody has set up yet, with the simulator (compose.simulator.yaml, E2E_VCSIM_HOST) and the
// bootstrap token: it sets the panel up itself through the API (administrator, a vCenter, two locations with their
// pools, images, packages, IP pools, six servers, e-mail and messaging settings), with invented names only.
// On a deployment the suite has already set up it signs in as the suite's administrator and adds what is missing.

const fresh = { email: 'admin@example.com', password: 'showcase admin passphrase 2026' };
const suite = { email: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test', password: process.env.E2E_ADMIN_PASSWORD ?? 'e2e admin passphrase 2026' };
const csrf = { 'x-lightning-csrf': '1' };
const width = 1440;
const height = 900;
const out = 'test-results/tour/showcase';

type Named = { id: string; name: string };
type Inventory = {
  compute: { moref: string; name: string; kind: string }[];
  datastores: { moref: string; name: string }[];
  networks: { moref: string; name: string; kind: string }[];
  vms: { moref: string; name: string; template: boolean }[];
};

async function ok(res: APIResponse, what: string) {
  expect(res.ok(), `${what}: ${res.status()} ${await res.text().catch(() => '')}`).toBe(true);
  return res.status() === 204 ? {} : await res.json().catch(() => ({}));
}

// The same waiting as the suite's tour(): entrance effects that end by themselves have ended, then two quiet frames.
async function settled(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity),
    null, { timeout: 3_000 }).catch(() => undefined);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
}

async function language(page: Page, locale: 'tr' | 'en') {
  if (await page.locator('html').getAttribute('lang') !== locale) {
    // The panel's own language menu: the page is drawn again in place, with the data it already holds.
    await page.getByRole('button', { name: /^(Language|Dil)$/ }).click();
    await page.getByRole('menuitem', { name: locale === 'tr' ? 'Türkçe' : 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.getByRole('menu')).toHaveCount(0);
  }
  // Nothing hovered, nothing focused.
  await page.mouse.move(width - 2, 70);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(700); // charts draw themselves again after a change of language or size
  await settled(page);
}

const pageHeight = (page: Page) => page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));

// One screen, both languages, one size: the window is made as tall as the taller of the two pages, so the picture is
// the window itself (the menu beside the page and the bar above it stand where they do on a screen).
async function pair(page: Page, name: string) {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => window.scrollTo(0, 0));
  let tall = height;
  for (const locale of ['en', 'tr'] as const) { await language(page, locale); tall = Math.max(tall, await pageHeight(page)); }
  await page.setViewportSize({ width, height: tall });
  for (const locale of ['tr', 'en'] as const) {
    await language(page, locale);
    // A page that grew with the window (a chart, a wrapped line): once more at the new height.
    const now = await pageHeight(page);
    if (now > tall) { tall = now; await page.setViewportSize({ width, height: tall }); await language(page, 'tr'); }
  }
  for (const locale of ['tr', 'en'] as const) {
    await language(page, locale);
    await page.screenshot({ path: `${out}/${locale}/${name}.png` });
  }
  await page.setViewportSize({ width, height });
}

test('showcase screenshots: six screens in Turkish and English', async ({ browser, baseURL }) => {
  test.setTimeout(900_000);
  const sim = process.env.E2E_VCSIM_HOST;
  test.skip(!sim, 'needs compose.simulator.yaml and E2E_VCSIM_HOST');
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Europe/Istanbul', colorScheme: 'light', viewport: { width, height }, deviceScaleFactor: 1 });
  // The two pictures of a pair must not differ by what a timer did in between ("3 minutes ago" turning 4, a list
  // fetched again): timers that repeat every ten seconds or slower do not fire in this browser.
  await context.addInitScript(() => {
    const real = window.setInterval;
    window.setInterval = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) => real(handler, typeof ms === 'number' && ms >= 10_000 ? 2 ** 31 - 1 : ms, ...rest)) as typeof window.setInterval;
  });
  const page = await context.newPage();
  const api = page.request;
  const get = async <T>(path: string) => await ok(await api.get(`/api${path}`), `GET ${path}`) as T;
  const post = async <T>(path: string, data: unknown, headers: Record<string, string> = {}) => await ok(await api.post(`/api${path}`, { headers: { ...csrf, ...headers }, data }), `POST ${path}`) as T;
  const put = async <T>(path: string, data: unknown) => await ok(await api.put(`/api${path}`, { headers: csrf, data }), `PUT ${path}`) as T;

  // ---- the administrator -------------------------------------------------------------------------------------
  const status = await get<{ adminCreated: boolean; completed: boolean }>('/setup/status');
  let admin = suite;
  if (!status.adminCreated) {
    admin = fresh;
    const token = process.env.E2E_BOOTSTRAP_TOKEN;
    expect(token, 'E2E_BOOTSTRAP_TOKEN is required on a fresh install').toBeTruthy();
    await post('/setup/admin', { token, email: admin.email, password: admin.password, locale: 'en' });
  }
  if (!(await api.get('/api/admin/pools')).ok()) {
    await page.goto('/login');
    await page.getByLabel(/E-posta|Email/).fill(admin.email);
    await page.getByLabel(/Parola|Password/).fill(admin.password);
    await page.getByRole('button', { name: /^(Giriş yap|Sign in)$/ }).click();
    await expect(page).not.toHaveURL(/\/login/);
  }
  if (!status.completed) {
    await put('/setup/steps/language', { status: 'completed', data: { locale: 'en' } });
    await put('/setup/steps/checks', { status: 'completed' });
    await put('/setup/steps/access', { status: 'completed', data: { publicUrl: baseURL } });
    await put('/setup/steps/services', { status: 'completed' });
  }

  // ---- the simulated vCenter ---------------------------------------------------------------------------------
  let connections = (await get<{ connections: Named[] }>('/admin/vmware/connections')).connections;
  if (!connections.length) {
    const target = { name: 'vCenter 01', host: sim, port: 8989, username: 'sim-admin', password: 'sim-password-1' };
    // The simulator's certificate is self-signed: refused first, shown with its fingerprint, then pinned.
    const refused = await api.post('/api/admin/vmware/test', { headers: csrf, data: { ...target, tls: { mode: 'system' } } });
    const sha256 = ((await refused.json()) as { certificate?: { sha256?: string } }).certificate?.sha256?.replace(/[^0-9a-f]/gi, '').toLowerCase();
    expect(sha256, `the simulator's certificate: ${refused.status()} ${await refused.text()}`).toMatch(/^[0-9a-f]{64}$/);
    await post('/admin/vmware/connections', { ...target, tls: { mode: 'pinned', sha256 } });
    connections = (await get<{ connections: Named[] }>('/admin/vmware/connections')).connections;
  }
  const connectionId = connections[0].id;
  if (!status.completed) {
    await put('/setup/steps/vmware', { status: 'completed' });
    await put('/setup/steps/discovery', { status: 'completed' });
    await post('/setup/complete', {});
  }
  const inventory = await get<Inventory>(`/admin/vmware/connections/${connectionId}`);
  const template = inventory.vms.find((v) => v.template);
  expect(template, 'the simulator has a template').toBeTruthy();
  const network = inventory.networks.find((n) => n.kind === 'standard') ?? inventory.networks[0];
  const cluster = inventory.compute.find((c) => c.kind === 'cluster') ?? inventory.compute[0];
  const standalone = inventory.compute.find((c) => c.moref !== cluster.moref) ?? cluster;

  // ---- what is sold: locations, pools, images, IP pools, packages ---------------------------------------------
  const places = [
    { name: 'Istanbul', pool: 'IST-1', city: 'Istanbul', countryCode: 'TR', datacenter: 'IST-1', latitude: 41.0082, longitude: 28.9784, compute: cluster,
      ip: { name: 'ist-public', cidr: '203.0.113.0/24', gateway: '203.0.113.1', rangeStart: '203.0.113.10', rangeEnd: '203.0.113.200' } },
    { name: 'Frankfurt', pool: 'FRA-1', city: 'Frankfurt', countryCode: 'DE', datacenter: 'FRA-1', latitude: 50.1109, longitude: 8.6821, compute: standalone,
      ip: { name: 'fra-public', cidr: '198.51.100.0/24', gateway: '198.51.100.1', rangeStart: '198.51.100.10', rangeEnd: '198.51.100.200' } },
  ].filter((p, i, all) => all.findIndex((x) => x.compute.moref === p.compute.moref) === i);
  const locations = (await get<{ locations: Named[] }>('/admin/locations')).locations;
  let pools = (await get<{ pools: Named[] }>('/admin/pools')).pools;
  const ipPools = (await get<{ ipPools: Named[] }>('/admin/ip-pools')).ipPools;
  for (const [sort, p] of places.entries()) {
    const locationId = locations.find((l) => l.name === p.name)?.id
      ?? (await post<{ id: string }>('/admin/locations', { name: p.name, city: p.city, countryCode: p.countryCode, datacenter: p.datacenter, latitude: p.latitude, longitude: p.longitude, sort })).id;
    const poolId = pools.find((x) => x.name === p.pool)?.id ?? (await post<{ id: string }>('/admin/pools', {
      name: p.pool, locationId, connectionId, computeMoref: p.compute.moref, networkMoref: network.moref, datastoreMorefs: [inventory.datastores[0].moref],
      // The simulated hosts are small (4 GB each): sold several times over, with nothing kept back, so six servers fit
      // and the dashboard's forecast ("fills in about N days", a warning under 30) stays quiet.
      cpuOvercommit: 16, memoryOvercommit: 4, storageOvercommit: 2, reserveCpuPct: 0, reserveMemoryPct: 0, reserveStoragePct: 5 })).id;
    await put(`/admin/pools/${poolId}/custom-rule`, { cpuMin: 1, cpuMax: 8, cpuStep: 1, memoryMinMb: 1024, memoryMaxMb: 16384, memoryStepMb: 1024,
      diskMinGb: 20, diskMaxGb: 200, diskStepGb: 10, priceVcpu: '3', priceMemoryGb: '1.5', priceDiskGb: '0.05', currency: 'EUR' });
    if (!ipPools.some((x) => x.name === p.ip.name)) await post('/admin/ip-pools', { ...p.ip, poolId, dns: ['1.1.1.1', '9.9.9.9'] });
  }
  pools = (await get<{ pools: Named[] }>('/admin/pools')).pools;
  const poolOf = (place: string) => pools.find((p) => p.name === places.find((x) => x.name === place)?.pool) ?? pools.find((p) => places.some((x) => x.pool === p.name))!;

  let images = (await get<{ images: Named[] }>('/admin/images')).images;
  // One image for each template the simulator has (it may have only one: a template is offered under one name).
  const templates = inventory.vms.filter((v) => v.template);
  for (const [i, name] of ['Ubuntu 24.04 LTS', 'Debian 12'].slice(0, templates.length).entries()) {
    if (!images.some((x) => x.name === name)) await post('/admin/images', { name, family: 'linux', connectionId, templateMoref: templates[i].moref, minDiskGb: 10 });
  }
  images = (await get<{ images: Named[] }>('/admin/images')).images;
  const ubuntu = images.find((i) => i.name === 'Ubuntu 24.04 LTS')!;
  const shown = images.filter((i) => ['Ubuntu 24.04 LTS', 'Debian 12'].includes(i.name));

  let packages = (await get<{ packages: Named[] }>('/admin/packages')).packages;
  const plans = [
    { name: 'Start', vcpu: 1, memoryMb: 1024, diskGb: 20, priceMonthly: '4.00' },
    { name: 'Plus', vcpu: 2, memoryMb: 2048, diskGb: 40, priceMonthly: '8.00' },
    { name: 'Pro', vcpu: 4, memoryMb: 4096, diskGb: 80, priceMonthly: '16.00' },
  ];
  for (const [sort, plan] of plans.entries()) {
    if (!packages.some((p) => p.name === plan.name)) await post('/admin/packages', { ...plan, currency: 'EUR', sort: sort + 1,
      poolIds: places.map((p) => poolOf(p.name).id), imageIds: shown.map((i) => i.id) });
  }
  packages = (await get<{ packages: Named[] }>('/admin/packages')).packages;
  const plan = (name: string) => packages.find((p) => p.name === name)!;

  // ---- servers -----------------------------------------------------------------------------------------------
  const keys = (await get<{ keys: Named[] }>('/ssh-keys')).keys;
  const sshKey = keys[0]?.id ?? (await post<{ id: string }>('/ssh-keys', { name: 'laptop',
    publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMa0iBTtZu9kbSNXzg5M6pZ1rn8F1143iWq3JIcGimfn admin@example.com' })).id;
  // All in the first location: the simulator runs every clone on the template's host whatever the pool, and the
  // topology draws servers where they run. The second location stands ready and empty.
  const wanted = [
    ['web-1', 'Start', 'Istanbul'], ['web-2', 'Start', 'Istanbul'], ['db-1', 'Plus', 'Istanbul'],
    ['mail-1', 'Start', 'Istanbul'], ['backup-1', 'Start', 'Istanbul'], ['staging', 'Start', 'Istanbul'],
  ] as const;
  // The default quota of an account is smaller than six servers.
  await put('/admin/quotas/default', { maxServers: 20, maxVcpu: 64, maxMemoryMb: 131072, maxDiskGb: 2000 });
  const mine = async () => (await get<{ servers: (Named & { state: string; powerState: string | null })[] }>('/servers')).servers;
  const stamp = Date.now();
  for (const [name, pkg, place] of wanted) {
    if ((await mine()).some((s) => s.name === name)) continue;
    await post('/servers', { type: 'package', poolId: poolOf(place).id, packageId: plan(pkg).id, imageId: ubuntu.id, name, sshKeyIds: [sshKey] },
      { 'idempotency-key': `showcase-${name}-${stamp}` });
    // One at a time: the simulator clones quickly, and the list then stands in the order it was asked for.
    await expect.poll(async () => (await mine()).find((s) => s.name === name)?.state, { timeout: 180_000, intervals: [2_000] }).toBe('ready');
  }
  // One server stands switched off, so the lists show both states.
  const staging = async () => (await mine()).find((s) => s.name === 'staging')!;
  if (!/off/i.test((await staging()).powerState ?? '')) {
    await post(`/servers/${(await staging()).id}/actions`, { action: 'power_off' }, { 'idempotency-key': `showcase-off-${stamp}` });
    await expect.poll(async () => (await staging()).powerState, { timeout: 120_000, intervals: [2_000] }).toMatch(/off/i);
  }

  // ---- settings shown in the pictures ------------------------------------------------------------------------
  // Example values only: nothing is sent anywhere (smtp.example.com does not exist).
  await put('/admin/settings/mail', { enabled: true, provider: 'smtp', host: 'smtp.example.com', port: 587, security: 'starttls', username: 'panel@example.com',
    password: 'example-only', fromName: 'Lightning VM', fromAddress: 'no-reply@example.com', use: { passwordReset: true, twoFactor: true } });
  const chat = await get<{ catalog: { id: string; needs: unknown }[] }>('/admin/settings/chat');
  await put('/admin/settings/chat', { apps: chat.catalog.filter((a) => !a.needs).map((a) => a.id) });

  // ---- the pictures ------------------------------------------------------------------------------------------
  const open = async (path: string, ready: () => Promise<unknown>) => {
    await page.setViewportSize({ width, height });
    await page.goto(path);
    await expect(page.locator('#boot-loader')).toHaveClass(/page-loader-hidden/);
    // What the picture is about is on the page; when it is not, the picture is taken all the same and says so itself.
    await ready().catch((err: Error) => console.warn(`${path}: ${err.message.split(String.fromCharCode(10))[0]}`));
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined); // live connections stay open
  };
  const main = page.locator('main');

  await open('/admin', () => expect(main.getByText('staging').filter({ visible: true }).first()).toBeVisible());
  await pair(page, 'admin-dashboard');

  await open('/admin/topology', () => expect(main.getByText('Internet').filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 }));
  await pair(page, 'admin-topology');

  await open('/admin/settings?tab=chat', () => expect(main.getByText('Mattermost').filter({ visible: true }).first()).toBeVisible());
  await pair(page, 'chat-settings');

  await open('/admin/settings?tab=mail', () => expect(main.locator('input[value="smtp.example.com"]').first()).toBeVisible());
  await pair(page, 'mail');

  await open('/', () => expect(main.getByText('web-1').filter({ visible: true }).first()).toBeVisible());
  await pair(page, 'my-servers');

  // The order page takes a shared configuration from its address (package and image) and keeps it as a draft.
  await open(`/order?loc=${poolOf('Istanbul').id}&pkg=${plan('Plus').id}&image=${ubuntu.id}`, () => expect(page).toHaveURL(/\/order$/));
  await expect(page.getByRole('radio', { name: /Plus/ })).toBeChecked();
  await page.getByLabel(/^(Sunucu adı|Server name)$/).fill('web-3');
  await expect(page.locator('.quote')).toContainText('8', { timeout: 15_000 });
  await pair(page, 'order');

  await context.close();
});
