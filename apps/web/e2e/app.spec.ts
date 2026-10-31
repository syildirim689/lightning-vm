import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';

// Serial: the first tests perform first-run setup that later tests rely on.
test.describe.configure({ mode: 'serial' });

const admin = { email: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test', password: process.env.E2E_ADMIN_PASSWORD ?? 'e2e admin passphrase 2026' };
const user = { email: `user-${Date.now()}@example.test`, password: 'e2e user passphrase 2026' };

const health = (page: Page) => page.getByTestId('health');
async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel(/E-posta|Email/).fill(who.email);
  await page.getByLabel(/Parola|Password/).fill(who.password);
  await page.getByRole('button', { name: /^(Giriş yap|Sign in)$/ }).click();
}
// HeroUI (React Aria) select: the trigger is a button named after its label; options open in a listbox.
async function choose(page: Page, scope: Page | Locator, label: string | RegExp, option: string | RegExp) {
  await scope.getByRole('button', { name: label }).click();
  await page.getByRole('option', { name: option }).first().click();
}
// React Aria keeps the real input visually hidden under its styled control.
// Controlled inputs change only after the app (or the API) answers, so click and let expect() wait.
const tick = (box: Locator) => box.click({ force: true });
// No sideways scrolling at the page's current width; on failure the message names the innermost elements sticking out.
// Charts redraw at the new width a moment after a resize, so the check waits up to 3 s for the layout to settle.
async function expectNoOverflow(page: Page, label: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { timeout: 3_000 }).toBeLessThanOrEqual(1).catch(() => undefined);
  const [overflow, culprits] = await page.evaluate(() => {
    const w = window.innerWidth;
    const out = [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > w + 1
      && ![...e.children].some((c) => c.getBoundingClientRect().right > w + 1));
    return [document.documentElement.scrollWidth - w, out.slice(0, 5).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 60)} "${(e.textContent ?? '').trim().slice(0, 30)}"`).join(' | ')];
  });
  expect(overflow, `${label}: ${culprits}`).toBeLessThanOrEqual(1);
}

test.describe('first run (Turkish browser)', () => {
  test.use({ locale: 'tr-TR' });

  test('anonymous visitors are sent to setup or sign-in, in Turkish', async ({ page, request }) => {
    const { adminCreated } = await (await request.get('/api/setup/status')).json();
    await page.goto('/');
    await expect(page).toHaveURL(adminCreated ? /\/login$/ : /\/setup$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
  });

  test('the setup wizard runs end to end, resumes after reload, then closes', async ({ page, request }) => {
    const { completed } = await (await request.get('/api/setup/status')).json();
    test.skip(completed, 'setup already completed on this deployment');
    const token = process.env.E2E_BOOTSTRAP_TOKEN;
    expect(token, 'E2E_BOOTSTRAP_TOKEN is required on a fresh install').toBeTruthy();
    const heading = page.getByRole('heading', { level: 1 });
    // One primary action per state: "Devam et" appears only once the step's checks pass.
    const saveAndContinue = () => page.getByRole('button', { name: 'Devam et' }).click();
    const skip = () => page.getByRole('button', { name: 'Şimdilik atla' }).click();
    const check = () => page.getByRole('button', { name: 'Kontrol et' }).click();
    const shot = (name: string) => page.screenshot({ path: `test-results/tour/wizard-${name}.png`, fullPage: true });

    await page.goto('/setup');
    // The token card keeps its own height and sits in the middle of the screen (it once stretched top to bottom).
    const card = await page.getByLabel('Kurulum anahtarı').evaluate((el) => {
      const r = el.closest('.card')!.getBoundingClientRect();
      return { height: r.height, above: r.top, below: window.innerHeight - r.bottom };
    });
    expect(card.height).toBeLessThan(560);
    expect(Math.abs(card.above - card.below)).toBeLessThan(120); // the header (about 60 px) sits above it
    await shot('0-token');
    await page.getByLabel('Kurulum anahtarı').fill('wrong-token');
    await page.getByRole('button', { name: 'Kuruluma başla' }).click();
    await expect(page.locator('main [role=alert]')).toHaveText('Kurulum anahtarı geçersiz veya süresi dolmuş. Sunucuda yeni anahtar üretin.');
    await page.getByLabel('Kurulum anahtarı').fill(token!);
    await page.getByRole('button', { name: 'Kuruluma başla' }).click();

    await expect(heading).toHaveText('Dil');
    // Later required steps stay locked until the earlier ones are done.
    await expect(page.getByRole('button', { name: /Yönetici hesabı/ })).toBeDisabled();
    await shot('1-language');
    await saveAndContinue();
    await expect(heading).toHaveText('Sistem ön kontrolleri');
    // The checks run by themselves; "Devam et" appears only after they pass, never next to an untested "test" button.
    for (const name of ['PostgreSQL', 'Redis', "Veritabanı migration'ları", 'Arka plan çalışanı']) {
      await expect(page.locator('li.ok', { hasText: name })).toContainText('Başarılı');
    }
    await expect(page.getByText('Tüm kontroller başarılı.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Bağlantıyı test et' })).toHaveCount(0);
    await shot('2-checks');
    await page.setViewportSize({ width: 390, height: 844 });
    await shot('2-checks-390');
    await expectNoOverflow(page, 'wizard at 390 px');
    await page.setViewportSize({ width: 1280, height: 720 });
    await saveAndContinue();
    await expect(heading).toHaveText('Dağıtım ve erişim adresi');

    // Progress lives on the server: a reload returns to the first unfinished step.
    await page.reload();
    await expect(heading).toHaveText('Dağıtım ve erişim adresi');

    // A changed address makes the earlier result stale: the action becomes "Kontrol et" again.
    await page.getByLabel('Panel adresi').fill('http://panel.example.com/yol');
    await check();
    await expect(page.getByText('Yalnızca şema, alan adı/IP ve isteğe bağlı port girin.', { exact: false })).toBeVisible();
    const domain = process.env.E2E_DOMAIN;
    await page.getByLabel('Panel adresi').fill(domain ? `https://${domain}` : 'http://127.0.0.1:8080');
    await check();
    if (domain) { await expect(page.locator('li.ok', { hasText: 'Panel adresi' })).toContainText('Başarılı'); await saveAndContinue(); }
    else {
      await expect(page.locator('li.fail', { hasText: 'Panel adresi' })).toContainText('Yerel adres; doğrulanamaz');
      await expect(page.getByRole('button', { name: 'Devam et' })).toHaveCount(0);
      await shot('3-access-failed');
      // Three actions in the footer: nothing may stick out at desktop, tablet or phone width.
      for (const width of [1280, 768, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await expectNoOverflow(page, `wizard access step at ${width} px`);
      }
      await page.setViewportSize({ width: 390, height: 900 });
      await shot('3-access-failed-390');
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.getByRole('button', { name: 'Doğrulamadan kaydet' }).click();
    }

    await expect(heading).toHaveText('Alan adı ve HTTPS');
    await page.getByLabel('Alan adı').fill('https://panel.example.com');
    await check();
    await expect(page.getByText('Yalnızca alan adını girin', { exact: false })).toBeVisible();
    if (domain) {
      // Real deployment with a public name: DNS, HTTP and the certificate are each checked for real.
      await page.getByLabel('Alan adı').fill(domain);
      await check();
      await expect(page.locator('li.ok', { hasText: 'DNS' })).toContainText('Başarılı');
      await expect(page.locator('li.ok', { hasText: 'HTTP (80)' })).toContainText("HTTPS'e yönlendiriyor");
      await expect(page.locator('li.ok', { hasText: 'HTTPS sertifikası' })).toContainText('Başarılı');
      await saveAndContinue();
    } else {
      await skip();
    }
    await expect(heading).toHaveText('PostgreSQL ve Redis');
    await expect(page.getByText('Tüm kontroller başarılı.')).toBeVisible();
    await saveAndContinue();

    await expect(heading).toHaveText('Yönetici hesabı');
    await page.getByLabel('E-posta').fill(admin.email);
    await page.getByLabel('Parola').fill(admin.password);
    await page.getByRole('button', { name: 'Yönetici hesabını oluştur' }).click();
    await expect(heading).toHaveText('ESXi / vCenter bağlantısı');
    await expect(page.getByText('platform sanal sunucu yönetemez', { exact: false })).toBeVisible();
    // With compose.simulator.yaml running, connect the simulated vCenter (simulated data, not real hardware).
    const sim = process.env.E2E_VCSIM_HOST;
    if (sim) {
      await page.getByLabel('Görünen ad').fill('Simülatör vCenter');
      await page.getByLabel('Adres').fill(sim);
      await page.getByLabel('Port').fill('8989');
      await page.getByLabel('Servis hesabı').fill('sim-admin');
      await page.getByLabel('Parola').fill('sim-password-1');
      await page.getByRole('button', { name: 'Bağlantıyı test et' }).click();
      // The simulator's self-signed certificate must be refused and shown, then pinned explicitly.
      await expect(page.getByRole('heading', { name: 'Sunulan sertifika' })).toBeVisible();
      await page.getByRole('button', { name: 'Parmak izini doğruladım, bu sertifikayı sabitle' }).click();
      await expect(page.getByRole('button', { name: /Sertifika doğrulama/ })).toContainText('Sertifikayı parmak iziyle sabitle');
      await page.getByRole('button', { name: 'Bağlantıyı test et' }).click();
      await expect(page.getByText('Bağlantı başarılı', { exact: false })).toBeVisible();
      await page.getByRole('button', { name: 'Kaydet', exact: true }).click();
      await expect(heading).toHaveText('Datastore ve ağ keşfi');
      await expect(page.locator('li.ok', { hasText: 'Simülatör vCenter' })).toContainText('2 host');
      await saveAndContinue();
    } else {
      await skip();
      await expect(heading).toHaveText('Datastore ve ağ keşfi');
      await skip();
    }
    await expect(heading).toHaveText('Kaynak havuzu ve IP planı');
    await skip();
    await expect(heading).toHaveText('İzleme ve bildirimler');
    // Nothing to type on the server: the demo already runs monitoring, so the box comes ticked and the checks run.
    await expect(page.getByText('docker compose')).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: 'İzleme bileşenlerini kullanacağım' })).toBeChecked();
    await page.waitForTimeout(1500); // let the step's entrance animation finish
    await shot('10-monitoring');
    await skip();

    await expect(heading).toHaveText('Son kontrol ve özet');
    // Focus on the last button must not slide a clipped container sideways (overflow-hidden scrolls, overflow-clip does not).
    await page.getByRole('button', { name: 'Kurulumu tamamla' }).focus();
    expect(await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.scrollLeft !== 0).length)).toBe(0);
    await shot('11-summary');
    await expect(page.getByText('VMware bağlantısı yapılandırılmadı', { exact: false })).toHaveCount(sim ? 0 : 1);
    await expect(page.getByText('Panel adresi bu sunucudan doğrulanamadı', { exact: false })).toHaveCount(domain ? 0 : 1);
    await expect(page.getByText('HTTPS yapılandırılmadı', { exact: false })).toHaveCount(domain ? 0 : 1);
    await page.getByRole('button', { name: 'Kurulumu tamamla' }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByText('İlk kurulum henüz bitmedi.')).toHaveCount(0);

    // Closed for good: the page redirects and the API refuses even an admin session.
    expect((await (await page.request.get('/api/setup/progress')).json()).code).toBe('SETUP_CLOSED');
    await page.goto('/setup');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('setup endpoints stay closed once an admin exists', async ({ request }) => {
    const res = await request.post('/api/setup/admin', { headers: { 'x-lightning-csrf': '1' }, data: { token: process.env.E2E_BOOTSTRAP_TOKEN ?? 'x', email: 'late@example.test', password: 'another long passphrase' } });
    expect((await res.json()).code).toBe('SETUP_CLOSED');
    const session = await request.post('/api/setup/session', { headers: { 'x-lightning-csrf': '1' }, data: { token: process.env.E2E_BOOTSTRAP_TOKEN ?? 'x' } });
    expect((await session.json()).code).toBe('SETUP_CLOSED');
  });

  test('sign-in errors are validated and translated', async ({ page }) => {
    await signIn(page, { email: 'not-an-email', password: 'short' });
    await expect(page.getByText('Geçerli bir e-posta adresi girin.')).toBeVisible();
    await signIn(page, { email: admin.email, password: 'wrong passphrase here' });
    await expect(page.locator('main [role=alert]')).toHaveText('E-posta veya parola yanlış.');
    // Typing clears a field's error; a cleared error must not read as "invalid value".
    await expect(page.getByText('Geçersiz değer.')).toHaveCount(0);
  });
});

test.describe('roles and sessions (English browser)', () => {
  test.use({ locale: 'en-US' });

  test('admin sees live system health, backups, and opens registration', async ({ page }) => {
    await signIn(page, admin);
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview');
    await page.getByRole('link', { name: 'System' }).click();
    await expect(health(page)).toHaveText('API, PostgreSQL and Redis are reachable');
    await expect(page.getByText(/Background worker: Running \(last signal .*\d{4}/)).toBeVisible();
    // The run script and CI take one backup with scripts/install.sh before the tests.
    await expect(page.getByText(/Last successful backup: .*\d{4}/)).toBeVisible();
    const history = page.getByRole('grid', { name: 'Backups and updates' });
    await expect(history).toContainText('Backup');
    await expect(history).toContainText('succeeded');
    // Registration moved to Settings → General.
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
    const toggle = page.getByRole('switch', { name: 'Allow new user registration' });
    await expect(toggle).toBeEnabled();
    // Off then on, so the save path runs whatever state a previous run left; the switch follows the API answer.
    if (await toggle.isChecked()) { await tick(toggle); await expect(toggle).not.toBeChecked(); }
    await tick(toggle);
    await expect(toggle).toBeChecked();
    await expect(page.getByText('Saved.').first()).toBeVisible();
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Allow new user registration' })).toBeChecked();
  });

  test('a registered user gets the user panel but not the admin panel or admin API', async ({ page }) => {
    await page.goto('/register');
    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Password').fill(user.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your servers');
    await expect(page.getByRole('link', { name: 'Overview' })).toHaveCount(0);

    await page.goto('/admin');
    await expect(page.locator('main [role=alert]')).toContainText('You do not have permission for this action.');
    const api = await page.request.get('/api/admin/users');
    expect(api.status()).toBe(403);
  });

  test('sign-out ends the session on the server', async ({ page }) => {
    await signIn(page, user);
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect((await page.request.get('/api/auth/me')).status()).toBe(401);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('catalog and order preview (simulator)', () => {
  test('admin opens capacity for sale; a Turkish customer prices a package and a custom server', async ({ browser }) => {
    test.skip(!process.env.E2E_VCSIM_HOST, 'needs compose.simulator.yaml and E2E_VCSIM_HOST');
    const adminPage = await (await browser.newContext({ locale: 'en-US' })).newPage();
    await signIn(adminPage, admin);
    await expect(adminPage).toHaveURL(/\/admin$/);
    await adminPage.goto('/admin/catalog');
    await adminPage.getByRole('button', { name: 'New resource pool' }).click();
    let dialog = adminPage.getByRole('dialog');
    await dialog.getByLabel('Name').fill('E2E Pool');
    await choose(adminPage, dialog, /Cluster or host/, /cluster/);
    await tick(dialog.getByRole('group', { name: 'Datastores' }).getByRole('checkbox').first());
    await choose(adminPage, dialog, /Network \(port group\)/, /.+/);
    await dialog.getByRole('button', { name: 'Create pool' }).click();
    await expect(adminPage.getByRole('heading', { name: /E2E Pool/ })).toBeVisible();
    await expect(adminPage.getByRole('rowheader', { name: 'Physical total' })).toBeVisible();
    await expect(adminPage.getByRole('rowheader', { name: 'Management and safety headroom' })).toBeVisible();

    await adminPage.getByRole('button', { name: 'Add custom resource rule' }).click();
    await adminPage.getByLabel('Price per vCPU').fill('5');
    await adminPage.getByLabel('Price per GB RAM').fill('2');
    await adminPage.getByLabel('Price per GB disk').fill('0.1');
    await adminPage.getByRole('button', { name: 'Save rule' }).click();
    await expect(adminPage.getByRole('button', { name: 'Edit custom resource rule' })).toBeVisible();

    await adminPage.getByRole('tab', { name: 'Packages' }).click();
    await adminPage.getByRole('button', { name: 'New package' }).click();
    dialog = adminPage.getByRole('dialog');
    await dialog.getByLabel('Name').fill('E2E Small');
    await dialog.getByLabel('Monthly price').fill('12.1x');
    await dialog.getByRole('button', { name: 'Create package' }).click();
    await expect(dialog.getByText('Enter a valid amount (example: 12.50).')).toBeVisible();
    // The only pool is preselected.
    await expect(dialog.getByRole('group', { name: 'Offered in pools' }).getByRole('checkbox', { name: 'E2E Pool' })).toBeChecked();
    await dialog.getByLabel('Monthly price').fill('12.10');
    await dialog.getByRole('button', { name: 'Create package' }).click();
    await expect(adminPage.getByRole('row', { name: /E2E Small/ })).toContainText('€12.10');

    const customer = await (await browser.newContext({ locale: 'tr-TR' })).newPage();
    await signIn(customer, user);
    await expect(customer).toHaveURL(/\/$/);
    await customer.goto('/order');
    // The simulated pool has too little memory for 4 GB: the package is shown with the reason and cannot be picked.
    await expect(customer.getByRole('radio', { name: /E2E Small/ })).toBeDisabled();
    await expect(customer.getByText('Bu konumda şu an yer yok.')).toBeVisible();
    await tick(customer.getByRole('radio', { name: 'Özel kaynaklı' }));
    await expect(customer.getByText('fiziksel olarak ayrılmış (dedicated) işlemci garantisi değildir', { exact: false })).toBeVisible();
    // The field snaps to the allowed step (1024 MB) itself; the API still checks steps (integration tests).
    await customer.getByRole('textbox', { name: 'RAM (MB)' }).fill('4000');
    await customer.getByRole('textbox', { name: 'RAM (MB)' }).press('Tab');
    await expect(customer.getByRole('textbox', { name: 'RAM (MB)' })).toHaveValue('4096');
    // 2 x 5 + 4 GB x 2 + 40 GB x 0.1 = 22.00
    await expect(customer.locator('.quote')).toContainText('Aylık: €22,00');

    // An image (the simulator's template) and an IP pool, so the next test can create a server.
    await adminPage.getByRole('tab', { name: 'Operating system images' }).click();
    await adminPage.getByRole('button', { name: 'New image' }).click();
    dialog = adminPage.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Sim Linux');
    await choose(adminPage, dialog, /^Template|Template/, /.+/);
    await dialog.getByRole('textbox', { name: /Minimum disk/ }).fill('10');
    await dialog.getByRole('textbox', { name: /Minimum disk/ }).press('Tab');
    await dialog.getByRole('button', { name: 'Add image' }).click();
    await expect(adminPage.getByRole('row', { name: /Sim Linux/ })).toBeVisible();

    await adminPage.getByRole('tab', { name: 'IP pools' }).click();
    await adminPage.getByRole('button', { name: 'New IP pool' }).click();
    dialog = adminPage.getByRole('dialog');
    await dialog.getByLabel('Name').fill('lab-net');
    await dialog.getByLabel('Subnet (CIDR)').fill('10.30.0.0/24');
    await dialog.getByLabel('Gateway', { exact: true }).fill('10.30.0.1');
    await dialog.getByLabel('Range start').fill('10.30.0.20');
    await dialog.getByLabel('Range end').fill('10.20.0.30');
    await dialog.getByRole('button', { name: 'Add IP pool' }).click();
    await expect(dialog.getByText('Gateway and range must be inside the subnet', { exact: false })).toBeVisible();
    await dialog.getByLabel('Range end').fill('10.30.0.30');
    await dialog.getByRole('button', { name: 'Add IP pool' }).click();
    await expect(adminPage.getByRole('row', { name: /lab-net/ })).toContainText('11');

    await adminPage.getByRole('tab', { name: 'Packages' }).click();
    await adminPage.getByRole('button', { name: 'New package' }).click();
    dialog = adminPage.getByRole('dialog');
    await dialog.getByLabel('Name').fill('E2E Tiny');
    for (const [name, value] of [['vCPU', '1'], ['RAM (GB)', '0.5'], ['Disk (GB)', '10']]) {
      await dialog.getByRole('textbox', { name }).fill(value);
      await dialog.getByRole('textbox', { name }).press('Tab');
    }
    await dialog.getByLabel('Monthly price').fill('3.00');
    await tick(dialog.getByRole('group', { name: 'Allowed images' }).getByRole('checkbox', { name: 'Sim Linux' }));
    await dialog.getByRole('button', { name: 'Create package' }).click();
    await expect(adminPage.getByRole('row', { name: /E2E Tiny/ })).toBeVisible();
  });
});

test.describe('VMware connections (simulator, English browser)', () => {
  test.use({ locale: 'en-US' });
  test('admin sees discovered inventory, refreshes it and removes a connection only after typed confirmation', async ({ page }) => {
    test.skip(!process.env.E2E_VCSIM_HOST, 'needs compose.simulator.yaml and E2E_VCSIM_HOST');
    await signIn(page, admin);
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto('/admin/vmware');
    await page.getByRole('row', { name: /Simülatör vCenter/ }).getByRole('link', { name: 'Details' }).click();
    await expect(page.getByRole('heading', { name: 'Physical capacity' })).toBeVisible();
    await expect(page.getByText(/\d+ cores \/ \d+ threads/).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /Virtual machines \(\d+\)/ })).toBeAttached();
    await expect(page.getByRole('listitem').filter({ hasText: 'vCenter Automation REST API' })).toContainText('yes');
    await page.getByRole('button', { name: 'Discover again' }).click();
    await expect(page.getByText('Inventory updated.')).toBeVisible();

    // Console: browser -> Caddy (wss) -> console gateway -> the simulator's fake WebMKS endpoint.
    // Without the operator-installed VMware SDK the page says so; the gateway test still runs end to end.
    await page.getByRole('link', { name: 'Console' }).first().click();
    await expect(page.getByRole('heading', { name: /^Console: / })).toBeVisible();
    await expect(page.getByText('does not bypass the operating system', { exact: false })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Console component not installed' })).toBeVisible();
    await page.getByRole('button', { name: 'Test the gateway connection' }).click();
    await expect(page.getByText('Success: the gateway reached the VM', { exact: false })).toBeVisible();
    const consoleCookie = (await page.context().cookies()).find((c) => c.name === 'lvm_console');
    expect(consoleCookie?.httpOnly && consoleCookie.path === '/console/ws' && consoleCookie.sameSite === 'Strict').toBe(true);
    expect(page.url()).not.toContain(consoleCookie!.value);
    // Ready-made and saved commands: saving works now; typing waits for a connected console.
    await page.getByLabel('Command or text', { exact: true }).fill('uptime');
    await page.getByLabel('Name to save as (optional)', { exact: true }).fill('Uptime check');
    await page.getByRole('button', { name: 'Save command' }).click();
    await expect(page.getByText('Command saved.')).toBeVisible();
    const mine = page.getByRole('button', { name: 'Type into the console: Uptime check (uptime)' });
    await expect(mine).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Type into the console: Disk usage (df -h)' })).toBeDisabled();
    // Windows guests get PowerShell versions of the same commands; the choice is remembered.
    await page.getByRole('button', { name: 'Windows (PowerShell)' }).click();
    await expect(page.getByRole('button', { name: 'Type into the console: Disk usage (Get-PSDrive -PSProvider FileSystem)' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Windows (PowerShell)' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#boot-loader')).toHaveCSS('opacity', '0'); // the reload's loader fades out
    await page.setViewportSize({ width: 390, height: 900 });
    await expectNoOverflow(page, 'console commands at 390 px');
    await expect(page.getByText('Command saved.')).toBeHidden({ timeout: 15_000 });
    await mine.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: 'test-results/tour/console-snippets-390.png' });
    await page.setViewportSize({ width: 1280, height: 720 });
    // Copy works without a console; editing loads the form and saves in place.
    await page.getByRole('button', { name: 'Copy to clipboard: Uptime check' }).click();
    await expect(page.getByText('Uptime check copied to the clipboard.')).toBeVisible();
    await page.getByRole('button', { name: 'Edit: Uptime check' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Editing: Uptime check' })).toBeVisible();
    await page.getByLabel('Command or text', { exact: true }).fill('uptime -p');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Command updated.')).toBeVisible();
    const edited = page.getByRole('button', { name: 'Type into the console: Uptime check (uptime -p)' });
    await expect(edited).toBeVisible();
    await expect(mine).toBeHidden();
    await page.getByRole('button', { name: 'Delete saved command: Uptime check' }).click();
    await expect(edited).toBeHidden();
    // An administrator can share a command with every user; it is listed apart and they may remove it.
    await page.getByLabel('Command or text', { exact: true }).fill('free -h');
    await tick(page.getByRole('checkbox', { name: /Share with every user/ }));
    await page.getByRole('button', { name: 'Save command' }).click();
    const shared = page.getByRole('list', { name: 'Shared commands' }).getByRole('button', { name: 'Type into the console: free -h (free -h)' });
    await expect(shared).toBeVisible();
    await page.getByRole('button', { name: 'Delete saved command: free -h' }).click();
    await expect(shared).toBeHidden();

    // The vCenter now backs a resource pool, so a separate simulated ESXi is added and removed.
    await page.goto('/admin/vmware');
    await page.getByRole('button', { name: 'Add connection' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Display name').fill('Sim ESXi');
    await dialog.getByLabel('Address').fill(process.env.E2E_VCSIM_ESXI ?? 'vcsim-esxi');
    await dialog.getByLabel('Port').fill('8989');
    await dialog.getByLabel('Service account').fill('sim-root');
    await dialog.getByLabel('Password').fill('sim-password-2');
    await dialog.getByRole('button', { name: 'Test connection' }).click();
    await dialog.getByRole('button', { name: 'I verified the fingerprint, pin this certificate' }).click();
    // Pinning changed the form: it is tested again before "Save" is offered.
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Test connection' }).click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('row', { name: /Sim ESXi/ }).getByRole('link', { name: 'Details' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: 'vCenter Automation REST API' })).toContainText('no');
    const remove = page.getByRole('button', { name: 'Remove connection' });
    await expect(remove).toBeDisabled();
    await page.getByLabel('Type “Sim ESXi” to confirm').fill('Sim ESXi');
    await remove.click();
    await expect(page.getByText('Connection removed.')).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/vmware$/);
    await expect(page.getByRole('row', { name: /Sim ESXi/ })).toHaveCount(0);
  });
});

test.describe('server lifecycle (simulator, Turkish customer)', () => {
  test.use({ locale: 'tr-TR' });
  test('a customer creates a server, sees it become ready, powers it off with confirmation and deletes it', async ({ page }) => {
    test.setTimeout(240_000);
    test.skip(!process.env.E2E_VCSIM_HOST, 'needs compose.simulator.yaml and E2E_VCSIM_HOST');
    await signIn(page, user);
    await expect(page).toHaveURL(/\/$/);
    await page.goto('/account?tab=keys');
    await page.getByLabel('Anahtar adı').fill('dizüstü');
    await page.getByLabel('Açık anahtar').fill('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMa0iBTtZu9kbSNXzg5M6pZ1rn8F1143iWq3JIcGimfn e2e');
    await page.getByRole('button', { name: 'Anahtar ekle' }).click();
    await expect(page.getByText('SHA256:', { exact: false })).toBeVisible();

    await page.goto('/order');
    await choose(page, page, /İşletim sistemi/, /Sim Linux/);
    await tick(page.getByRole('radio', { name: /E2E Tiny/ }));
    await expect(page.locator('.quote')).toContainText('Aylık: €3,00', { timeout: 15_000 });
    await page.getByLabel('Sunucu adı').fill('Web_1');
    await tick(page.getByRole('checkbox', { name: 'dizüstü' }));
    await page.getByRole('button', { name: 'Sunucuyu oluştur' }).click();
    await expect(page.getByText('Küçük harf, rakam ve tire kullanın', { exact: false })).toBeVisible();
    await page.getByLabel('Sunucu adı').fill('web-1');
    await page.getByRole('button', { name: 'Sunucuyu oluştur' }).click();

    await expect(page).toHaveURL(/\/servers\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('web-1');
    // The task manager (bottom right) shows the background work while it runs.
    await expect(page.getByRole('button', { name: /iş sürüyor|Son işler/ })).toBeVisible();
    await expect(page.getByText(/Hazır · açık/).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('10.30.0.20').first()).toBeVisible(); // overview and the IP addresses section
    // Live metrics from the simulator's performance manager (20-second samples).
    await expect(page.getByText('Canlı performans')).toBeVisible();
    await expect(page.getByText(/\d+ örnek, 20 saniye aralıkla/)).toBeVisible({ timeout: 30_000 });
    // Health score with its reasons; a new server has no week of CPU data, so no sizing advice yet.
    await expect(page.getByRole('img', { name: /Sağlık puanı 100 üzerinden \d+/ })).toBeVisible();
    await expect(page.getByText('Henüz yeterli veri yok', { exact: false })).toBeVisible();
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoOverflow(page, `server page at ${width} px`);
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    // Connect commands to copy, then the owner's tags and notes; the list filters by tag and search.
    await expect(page.getByText('ssh root@10.30.0.20')).toBeVisible();
    await page.getByLabel('Yeni etiket').fill('üretim');
    await page.keyboard.press('Enter');
    await page.getByLabel('Yeni etiket').fill('web');
    await page.getByRole('button', { name: 'Ekle', exact: true }).click();
    await page.getByLabel('Notlar').fill('Ana web sunucusu');
    await page.getByRole('button', { name: 'Kaydet', exact: true }).click();
    await expect(page.getByText('Etiketler ve notlar kaydedildi.')).toBeVisible();
    // Power schedule: "office hours" adds a weekday start and shutdown in one click.
    await page.getByRole('button', { name: 'Mesai saatleri' }).click();
    await expect(page.getByText('08:00', { exact: true })).toBeVisible();
    await expect(page.getByText('19:00', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /19:00 Kapat zamanlamasını kaldır/ }).click();
    await expect(page.getByText('19:00', { exact: true })).toBeHidden();
    // Automatic snapshots: "nightly snapshot" adds a daily 02:00 one that keeps the newest three.
    await page.getByRole('button', { name: 'Gece anlık görüntüsü' }).click();
    await expect(page.getByText('02:00', { exact: true })).toBeVisible();
    await expect(page.getByText(/3 tane saklar/)).toBeVisible();
    // Snapshot: taken as an operation, then listed as the current state.
    await page.getByLabel('Ad', { exact: true }).fill('guncelleme-oncesi');
    await page.getByRole('button', { name: 'Anlık görüntü al', exact: true }).click();
    // The page, not the toast that the live notification shows at the same moment.
    await expect(page.locator('main').getByText('guncelleme-oncesi')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText('Şu anki durum buna dayanıyor')).toBeVisible();
    await page.screenshot({ path: 'test-results/tour/server-page.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 900 });
    await expectNoOverflow(page, 'server page with schedules at 390 px');
    await page.screenshot({ path: 'test-results/tour/server-page-390.png', fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole('button', { name: 'Benzerini sipariş et' }).click();
    await expect(page).toHaveURL(/\/order$/);
    await expect(page.getByLabel('Sunucu adı')).toHaveValue('web-2');
    await page.goto('/');
    await expect(page.getByText('üretim').first()).toBeVisible();
    // Search reaches notes ("ana web" is only in the note), and the card shows the note line.
    // "/" jumps to the list's search from anywhere on the page, selecting what was there.
    await page.goto('/?q=x');
    await expect(page.getByRole('searchbox', { name: 'Ara' })).toHaveValue('x');
    await page.locator('main h1').click();
    await page.keyboard.press('/');
    await page.keyboard.type('ana web');
    await expect(page).toHaveURL(/q=ana(\+|%20)web/);
    await expect(page.locator('main li').getByText('Ana web sunucusu')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 900 });
    await expectNoOverflow(page, 'server list note search at 390 px');
    await expect(page.getByText('Yükleniyor…').filter({ visible: true })).toHaveCount(0);
    await page.locator('main li').getByText('Ana web sunucusu').scrollIntoViewIfNeeded();
    // The card copies its IP in one tap, without opening the server.
    await page.getByRole('button', { name: 'Kopyala: web-1 IP' }).click();
    await expect(page.getByText('web-1 IP kopyalandı.')).toBeVisible();
    await expect(page).toHaveURL(/\/\?q=/);
    await page.screenshot({ path: 'test-results/tour/servers-note-search-390.png' });
    await page.setViewportSize({ width: 1280, height: 720 });
    await choose(page, page, /Sırala/, 'En büyük önce');
    await expect(page).toHaveURL(/sort=size/);
    await page.goto('/?q=yok-boyle');
    await expect(page.getByText('Bu süzgeçlere uyan sunucu yok.').or(page.getByText('web-1'))).toBeVisible();
    // Ctrl+K lists the server just opened under "recent".
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('listbox').getByText('Son açılanlar')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/servers\/[0-9a-f-]{36}$/);
    // Typing a server's name also offers its console and next power step.
    await page.keyboard.press('Control+k');
    await page.keyboard.type('web-1');
    await expect(page.getByRole('option', { name: /web-1: Konsol/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /web-1: (Düzgün kapat|Aç)/ })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Zorla kapat' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('kaydedilmemiş veriler kaybolabilir');
    await page.getByRole('button', { name: 'Evet, Zorla kapat' }).click();
    await expect(page.getByText(/Hazır · kapalı/).first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Aç', exact: true }).click();
    await expect(page.getByText(/Hazır · açık/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('grid', { name: 'İşlem geçmişi' })).toContainText('Oluşturma');

    // Deleting a ready server first moves it to the grace period (24 hours by default).
    await expect(page.getByText('24 saat bekler', { exact: false })).toBeVisible();
    const del = page.getByRole('button', { name: 'Sunucuyu sil', exact: true });
    await expect(del).toBeDisabled();
    await page.getByLabel('Onaylamak için “web-1” yazın').fill('web-1');
    // Locked: deleting stays off until the lock is removed.
    await page.getByRole('button', { name: 'Kilitle' }).click();
    await expect(page.getByText('Silme koruması açık')).toBeVisible();
    await expect(del).toBeDisabled();
    await page.screenshot({ path: 'test-results/tour/server-locked.png', fullPage: true });
    await page.getByRole('button', { name: 'Kilidi aç' }).click();
    await expect(page.getByText('Silme koruması kapalı')).toBeVisible();
    await expect(del).toBeEnabled();
    await del.click();
    await expect(page.getByText('Bu sunucu silinmek üzere')).toBeVisible();
    await expect(page.getByText(/kalıcı olarak silinecek/)).toBeVisible();
    await page.screenshot({ path: 'test-results/tour/server-trash.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 900 });
    await expectNoOverflow(page, 'server waiting for deletion at 390 px');
    await page.screenshot({ path: 'test-results/tour/server-trash-390.png', fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });
    // The home page points it out; the finding can be hidden for a day and shown again.
    const serverUrl = page.url();
    await page.goto('/');
    const finding = page.getByRole('link', { name: /web-1 yaklaşık \d+ saat içinde silinecek/ });
    await expect(finding).toBeVisible();
    await page.getByRole('button', { name: /^Gizle: web-1/ }).click();
    await page.getByRole('menuitem', { name: '1 gün gizle' }).click();
    await expect(finding).toBeHidden();
    const showHidden = page.getByRole('button', { name: /gizli öneriyi göster/ });
    await expect(showHidden).toBeVisible();
    await page.setViewportSize({ width: 390, height: 900 });
    await expectNoOverflow(page, 'home with a hidden finding at 390 px');
    await page.screenshot({ path: 'test-results/tour/insights-hidden-390.png', fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });
    await showHidden.click();
    await expect(finding).toBeVisible();
    await page.waitForTimeout(800); // layout animation of the returning cards
    await page.screenshot({ path: 'test-results/tour/insights-pending-deletion.png', fullPage: true });
    // The finding's own button takes the server back without opening it.
    await page.getByRole('button', { name: 'web-1 sunucusunu geri al' }).click();
    await expect(page.getByText('İşlem başlatıldı')).toBeVisible();
    await expect(finding).toBeHidden();
    await page.goto(serverUrl);
    await expect(page.getByRole('button', { name: 'Benzerini sipariş et' })).toBeVisible();
    await expect(page.getByText('Bu sunucu silinmek üzere')).toBeHidden();

    // A second server, so the list offers selection; the bar acts on the chosen ones.
    await page.getByRole('button', { name: 'Benzerini sipariş et' }).click();
    await expect(page.getByLabel('Sunucu adı')).toHaveValue('web-2');
    const key = page.getByRole('checkbox', { name: 'dizüstü' });
    if (!(await key.isChecked())) await tick(key);
    await page.getByRole('button', { name: 'Sunucuyu oluştur' }).click();
    await expect(page).toHaveURL(/\/servers\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    await page.goto('/');
    await expect(page.getByRole('link', { name: /web-2/ })).toBeVisible();
    await page.getByRole('button', { name: 'Seç', exact: true }).click();
    await page.getByRole('checkbox', { name: 'web-1 sunucusunu seç' }).click();
    await expect(page.getByRole('region', { name: 'Seçili sunucular için işlemler' })).toContainText('1 sunucu seçili');
    // Shift+click selects the range from the last clicked card; a plain click toggles one.
    await page.getByRole('checkbox', { name: 'web-2 sunucusunu seç' }).click({ modifiers: ['Shift'] });
    await expect(page.getByText('2 sunucu seçili')).toBeVisible();
    await page.getByRole('checkbox', { name: 'web-2 sunucusunu seç' }).click();
    await expect(page.getByText('1 sunucu seçili')).toBeVisible();
    await page.getByRole('button', { name: 'Tümünü seç' }).click();
    await expect(page.getByText('2 sunucu seçili')).toBeVisible();
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoOverflow(page, `server selection at ${width} px`);
      // The selection bar stays clear of the background-work button in the corner.
      const tasksButton = page.getByRole('button', { name: /iş sürüyor|Son işler/ });
      if (await tasksButton.isVisible()) {
        const barBox = (await page.getByRole('region', { name: 'Seçili sunucular için işlemler' }).boundingBox())!;
        expect(barBox.y + barBox.height, `selection bar above the tasks button at ${width} px`).toBeLessThanOrEqual((await tasksButton.boundingBox())!.y);
      }
      await page.screenshot({ path: `test-results/tour/servers-select-${width}.png` });
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.screenshot({ path: 'test-results/tour/servers-select.png', fullPage: true });
    await page.getByRole('region', { name: 'Seçili sunucular için işlemler' }).getByRole('button', { name: "IP'leri kopyala" }).click();
    await expect(page.getByText('2 IP panoya kopyalandı (her satırda bir tane).')).toBeVisible();
    await page.getByRole('region', { name: 'Seçili sunucular için işlemler' }).getByRole('button', { name: 'SSH yapılandırması' }).click();
    await expect(page.getByText('2 sunucu için SSH yapılandırması panoya kopyalandı', { exact: false })).toBeVisible();
    // Tags for both at once: added, shown as on the selection, removed again; Escape closes only the popover.
    const bar = page.getByRole('region', { name: 'Seçili sunucular için işlemler' });
    await bar.getByRole('button', { name: 'Etiket', exact: true }).click();
    const tags = page.getByRole('dialog');
    await tags.getByRole('textbox', { name: 'Yeni etiket' }).fill('e2e');
    await tags.getByRole('button', { name: 'Ekle', exact: true }).click();
    await expect(page.getByText('2 sunucunun etiketi güncellendi.')).toBeVisible();
    await expect(tags.getByRole('button', { name: 'e2e etiketini hepsinden kaldır' })).toBeVisible();
    await tags.getByRole('textbox', { name: 'Yeni etiket' }).fill('ops');
    await tags.getByRole('button', { name: 'Ekle', exact: true }).click();
    await expect(tags.getByRole('button', { name: 'ops etiketini hepsinden kaldır' })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 900 });
    await expectNoOverflow(page, 'bulk tags at 390 px');
    await page.screenshot({ path: 'test-results/tour/servers-bulk-tags-390.png' });
    await page.setViewportSize({ width: 1280, height: 720 });
    await tags.getByRole('button', { name: 'e2e etiketini hepsinden kaldır' }).click();
    await expect(tags.getByRole('button', { name: 'e2e etiketini hepsinden kaldır' })).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(tags).toBeHidden();
    await expect(bar).toContainText('2 sunucu seçili');
    await page.getByRole('region', { name: 'Seçili sunucular için işlemler' }).getByRole('button', { name: 'Aç', exact: true }).click();
    await expect(page.getByText(/sunucuda işlem başladı/)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Seçili sunucular için işlemler' })).toBeHidden();

    // Ctrl+K copies a server's SSH command without opening its page.
    await page.keyboard.press('Control+k');
    await page.keyboard.type('web-1: ssh');
    const sshOption = page.getByRole('option', { name: /web-1: SSH komutunu kopyala/ });
    await expect(sshOption).toContainText('ssh root@');
    await page.setViewportSize({ width: 390, height: 900 });
    await page.screenshot({ path: 'test-results/tour/palette-ssh-390.png' });
    await page.setViewportSize({ width: 1280, height: 720 });
    await sshOption.click();
    await expect(page.getByText('web-1 SSH komutu kopyalandı.')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Komut paleti' })).toBeHidden();

    // The tag filter (from the URL) offers renaming the tag on every server, then removing it.
    // Searching a tag in Ctrl+K opens the list filtered to it.
    await page.keyboard.press('Control+k');
    await page.keyboard.type('ops');
    const tagOption = page.getByRole('option', { name: /Etiket: ops/ });
    await expect(tagOption).toContainText('2 sunucu');
    await page.setViewportSize({ width: 390, height: 900 });
    await page.screenshot({ path: 'test-results/tour/palette-tag-390.png' });
    await page.setViewportSize({ width: 1280, height: 720 });
    await tagOption.click();
    await expect(page).toHaveURL(/\?tag=ops$/);
    await expect(page.getByRole('group', { name: 'Etiket' }).getByRole('button', { name: 'ops 2' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Yeniden adlandır' }).click();
    const rename = page.getByRole('dialog');
    await rename.getByRole('textbox', { name: 'Yeni ad' }).fill('prod');
    await page.setViewportSize({ width: 390, height: 900 });
    await expectNoOverflow(page, 'tag rename at 390 px');
    await rename.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/tour/servers-tag-rename-390.png' });
    await page.setViewportSize({ width: 1280, height: 720 });
    await rename.getByRole('button', { name: 'Kaydet' }).click();
    await expect(page.getByText('2 sunucuda etiket yeniden adlandırıldı.')).toBeVisible();
    await expect(page).toHaveURL(/tag=prod/);
    await expect(page.getByRole('group', { name: 'Etiket' }).getByRole('button', { name: 'prod 2' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Etiketi kaldır' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Etiketi kaldır' }).click();
    await expect(page.getByText('Etiket 2 sunucudan kaldırıldı.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Etiketi kaldır' })).toBeHidden();

    // The admin's bulk delete on the same two servers: asked first, with what happens to them (cancelled here).
    const staff = await (await page.context().browser()!.newContext({ locale: 'tr-TR' })).newPage();
    await signIn(staff, admin);
    await expect(staff).toHaveURL(/\/admin$/);
    await staff.goto('/admin/servers');
    // The table copies an IP in one tap, and the owner's e-mail opens that customer in the user list.
    await staff.getByRole('button', { name: 'Kopyala: web-1 IP' }).click();
    await expect(staff.getByText('web-1 IP kopyalandı.')).toBeVisible();
    // The owner's e-mail opens that customer in the user list, and their server count leads back, filtered to them.
    await staff.getByRole('link', { name: user.email }).first().click();
    await expect(staff).toHaveURL(/\/admin\/users\?q=/);
    await staff.setViewportSize({ width: 390, height: 900 });
    await expectNoOverflow(staff, 'user list filtered to the owner at 390 px');
    await staff.getByRole('link', { name: `${user.email} kişisinin 2 sunucusunu göster` }).scrollIntoViewIfNeeded();
    await staff.screenshot({ path: 'test-results/tour/admin-user-servers-390.png' });
    await staff.setViewportSize({ width: 1280, height: 720 });
    // Their summary links to the same filtered server list.
    await staff.getByRole('button', { name: new RegExp(user.email) }).first().click();
    await expect(staff.getByRole('dialog').getByRole('link', { name: 'Sunucu listesinde aç' })).toHaveAttribute('href', `/admin/servers?owner=${encodeURIComponent(user.email)}`);
    await staff.keyboard.press('Escape');
    await expect(staff.getByRole('dialog')).toBeHidden();
    await staff.getByRole('link', { name: `${user.email} kişisinin 2 sunucusunu göster` }).click();
    // Exactly that owner's servers (not every e-mail containing theirs), with a chip that clears it.
    await expect(staff).toHaveURL(/\/admin\/servers\?owner=/);
    await expect(staff.getByRole('button', { name: `Sahip süzgecini kaldır: ${user.email}` })).toBeVisible();
    await expect(staff.getByText('2 sunucudan 2 gösteriliyor')).toBeVisible();
    await staff.setViewportSize({ width: 390, height: 900 });
    await expectNoOverflow(staff, 'admin servers filtered to an owner at 390 px');
    await staff.screenshot({ path: 'test-results/tour/admin-servers-owner-390.png' });
    await staff.setViewportSize({ width: 1280, height: 720 });
    await staff.getByRole('button', { name: `Sahip süzgecini kaldır: ${user.email}` }).click();
    await expect(staff).not.toHaveURL(/owner=/);
    // Ctrl+K: searching a customer's e-mail offers their servers, opening the same owner filter.
    await staff.keyboard.press('Control+k');
    await staff.keyboard.type(user.email.slice(0, 12));
    const ownerOption = staff.getByRole('option', { name: new RegExp(`Sunucuları: ${user.email}`) });
    await expect(ownerOption).toContainText('2 sunucu');
    await staff.setViewportSize({ width: 390, height: 900 });
    await staff.screenshot({ path: 'test-results/tour/palette-owner-390.png' });
    await staff.setViewportSize({ width: 1280, height: 720 });
    await ownerOption.click();
    await expect(staff).toHaveURL(/\/admin\/servers\?owner=/);
    await choose(staff, staff, /Görünen sunucular için işlem/, 'Sil (geri alma süresiyle)');
    await staff.getByRole('button', { name: /sunucuya uygula/ }).click();
    // The copy toast is an alertdialog too; the confirmation is the one that explains the delete.
    const ask = staff.getByRole('alertdialog').filter({ hasText: 'sahiplerine bildirim gider' });
    await expect(ask).toBeVisible();
    for (const width of [390, 1280]) {
      await staff.setViewportSize({ width, height: 900 });
      await staff.waitForTimeout(400);
      await staff.screenshot({ path: `test-results/tour/admin-bulk-delete-${width}.png` });
    }
    await ask.getByRole('button', { name: 'Vazgeç' }).click();
    await staff.context().close();

    // Both go: web-1 from the grace period (bulk delete while two are listed) with "delete for good now", then web-2 at once.
    for (const name of ['web-1', 'web-2']) {
      await page.getByRole('link', { name: new RegExp(name) }).click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
      await expect(page.getByText(/Hazır · açık/).first()).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('button', { name: /Benzerini/ })).toBeVisible();
      // The bulk "power on" may still be running; deleting waits for it.
      await expect(page.getByText('İşlem ilerlemesi')).toBeHidden({ timeout: 60_000 });
      if (name === 'web-2') {
        await page.getByLabel(`Onaylamak için “${name}” yazın`).fill(name);
        await tick(page.getByRole('checkbox', { name: /Beklemeden hemen sil/ }));
        await page.getByRole('button', { name: 'Sunucuyu kalıcı olarak sil' }).click();
      } else {
        // From the list: selected and deleted in bulk (grace period), found under "To be deleted", then deleted for good.
        await page.goto('/');
        await page.getByRole('button', { name: 'Seç', exact: true }).click();
        await page.getByRole('checkbox', { name: 'web-1 sunucusunu seç' }).click();
        const bar = page.getByRole('region', { name: 'Seçili sunucular için işlemler' });
        await bar.getByRole('button', { name: 'Sil', exact: true }).click();
        const ask = page.getByRole('alertdialog', { name: 'Sil' });
        await expect(ask).toContainText('geri alabilirsiniz');
        await ask.getByRole('button', { name: 'Sil', exact: true }).click();
        await expect(page.getByText(/1 sunucuda işlem başladı/)).toBeVisible();
        await page.getByRole('button', { name: /^Silinecek/ }).click();
        await expect(page.getByText(/Silinecek · /)).toBeVisible();
        await page.setViewportSize({ width: 390, height: 900 });
        await expectNoOverflow(page, 'list filtered to servers awaiting deletion at 390 px');
        await page.screenshot({ path: 'test-results/tour/servers-trash-filter-390.png', fullPage: true });
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.getByRole('link', { name: /^web-1 / }).click();
        await page.getByRole('button', { name: 'Şimdi kalıcı olarak sil' }).click();
        const sure = page.getByRole('alertdialog', { name: 'Şimdi kalıcı olarak sil' });
        await expect(sure).toContainText('geri alınamaz');
        await sure.getByRole('button', { name: 'Şimdi kalıcı olarak sil' }).click();
      }
      await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
    }
    await expect(page.getByText('Henüz sunucunuz yok.')).toBeVisible({ timeout: 60_000 });
    // The account activity lists the customer's own sign-in and server actions.
    await page.goto('/account?tab=activity');
    await expect(page.getByText('Sunucu silindi').first()).toBeVisible();
    await expect(page.getByText('Sunucu silme işlemi geri alındı').first()).toBeVisible();
    await expect(page.getByText('Güç zamanlaması eklendi').first()).toBeVisible();
  });
});

test.describe('language', () => {
  test('unsupported browser language falls back to English', async ({ browser }) => {
    const page = await (await browser.newContext({ locale: 'de-DE' })).newPage();
    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });

  test('choosing Türkçe overrides an English browser and persists', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    await page.goto('/login');
    await page.getByRole('button', { name: 'Language' }).click();
    await page.getByRole('menuitem', { name: 'Türkçe' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Giriş yap');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
    expect((await context.cookies()).find((c) => c.name === 'NEXT_LOCALE')?.value).toBe('tr');
  });

  test('API error codes are translated; network failures are shown separately', async ({ browser }) => {
    const page = await (await browser.newContext({ locale: 'tr-TR' })).newPage();
    await signIn(page, admin);
    await expect(page).toHaveURL(/\/admin$/);
    await page.route('**/api/ready', (r) => r.fulfill({ status: 503, json: { code: 'DEPENDENCY_UNAVAILABLE', message: 'x' } }));
    await page.goto('/admin/system');
    await expect(health(page)).toHaveText('PostgreSQL veya Redis şu anda erişilemiyor.');
    await page.route('**/api/ready', (r) => r.fulfill({ status: 500, json: { code: 'SOMETHING_NEW' } }));
    await page.reload();
    await expect(health(page)).toHaveText('Bilinmeyen bir hata oluştu.');
    await page.route('**/api/ready', (r) => r.abort());
    await page.reload();
    await expect(health(page)).toContainText('Sunucuya ulaşılamadı');
  });

  test('pages render without console errors', async ({ browser }) => {
    const page = await (await browser.newContext({ locale: 'en-US' })).newPage();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    for (const path of ['/login', '/register', '/forgot-password']) await page.goto(path);
    await signIn(page, admin);
    await expect(page).toHaveURL(/\/admin$/);
    for (const path of ['/admin/servers', '/admin/vmware', '/admin/catalog', '/admin/system', '/admin/users', '/admin/roles', '/admin/settings',
      '/admin/settings?tab=mail', '/admin/settings?tab=captcha', '/admin/settings?tab=sms', '/admin/settings?tab=payments', '/admin/settings?tab=rdns', '/admin/settings?tab=notifications', '/admin/catalog?tab=ip', '/', '/order', '/firewalls', '/account',
      '/account?tab=security', '/account?tab=notifications', '/admin/settings?tab=chat']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
});

// These tests sign the admin in once and share the session: signing in for every test would hit the
// per-account sign-in limit (15 per 15 minutes) that the API enforces.
let adminCookies: Awaited<ReturnType<BrowserContext['cookies']>> | undefined;
async function signInAdmin(page: Page) {
  if (adminCookies) { await page.context().addCookies(adminCookies); await page.goto('/admin'); return; }
  await signIn(page, admin);
  await expect(page).toHaveURL(/\/admin$/);
  adminCookies = await page.context().cookies();
}

test.describe('people, settings and smart features (English browser)', () => {
  test.use({ locale: 'en-US' });

  test('users, roles and permissions are managed from the panel', async ({ page }) => {
    await signInAdmin(page);
    await expect(page).toHaveURL(/\/admin$/);
    await page.getByRole('link', { name: 'Users', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Users');
    await expect(page.getByRole('grid', { name: 'Users' })).toContainText(admin.email);
    await page.getByRole('link', { name: 'Roles' }).click();
    for (const name of ['Administrator', 'Customer', 'Operator', 'Support', 'Auditor']) await expect(page.getByRole('heading', { name: new RegExp('^' + name) })).toBeVisible();
    // A custom role with one permission.
    await page.getByRole('button', { name: 'New role' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('E2E Viewer');
    await tick(dialog.getByRole('checkbox', { name: /See the catalog/ }));
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Role saved.')).toBeVisible();
    await expect(page.getByText('E2E Viewer')).toBeVisible();
  });

  test('settings: branding colour and notification rules; inbox and command palette', async ({ page }) => {
    await signInAdmin(page);
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto('/admin/settings?tab=branding');
    await page.getByLabel('Panel name').fill('Lightning VM');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.').first()).toBeVisible();
    // E-mail: an API provider instead of SMTP shows its own fields and its documentation.
    await page.goto('/admin/settings?tab=mail');
    await page.getByRole('radio', { name: 'Resend' }).click();
    await expect(page.getByLabel('API key')).toBeVisible();
    await expect(page.getByRole('link', { name: 'API documentation' })).toHaveAttribute('href', /resend\.com\/docs/);
    await expect(page.getByLabel('Server', { exact: true })).toHaveCount(0);
    await page.getByRole('radio', { name: 'SMTP', exact: true }).click();
    await expect(page.getByLabel('Server', { exact: true })).toBeVisible();
    await page.goto('/admin/settings?tab=notifications');
    await expect(page.getByText('User notifications')).toBeVisible();
    await expect(page.getByText('Server ready').first()).toBeVisible();
    // The sign-in above produced an in-app notification (written in the language saved on the account).
    await page.getByRole('button', { name: /notifications/i }).first().click();
    await expect(page.getByText(/New sign-in to your account|Hesabınıza yeni giriş/).first()).toBeVisible();
    await page.keyboard.press('Escape');
    // Ctrl+K jumps anywhere.
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('combobox', { name: 'Command palette' });
    await palette.fill('roles');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/admin\/roles$/);
    // "?" lists the shortcuts; "g" then "d" goes to the overview.
    await page.getByRole('heading', { level: 1 }).click();
    await page.keyboard.press('Shift+?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await expect(page.getByRole('dialog').getByText('Jump to the page search')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.keyboard.press('g');
    await page.keyboard.press('d');
    await expect(page).toHaveURL(/\/admin$/);
    // An announcement shows on every signed-in page until closed; the audit log finds its save.
    await page.goto('/admin/settings?tab=announcement');
    await page.getByLabel('Text (English)').fill('Maintenance tonight at 22:00');
    await page.getByText('Show the announcement').click();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Announcement saved.').first()).toBeVisible();
    await page.goto('/admin');
    await expect(page.getByRole('status').filter({ hasText: 'Maintenance tonight at 22:00' })).toBeVisible();
    await page.getByRole('button', { name: 'Close the announcement' }).click();
    await expect(page.getByText('Maintenance tonight at 22:00')).toBeHidden();
    await page.goto('/admin/audit?q=announcement');
    await expect(page.getByText('Announcement saved').first()).toBeVisible();
    await page.goto('/admin/settings?tab=announcement');
    await page.getByText('Show the announcement').click();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Announcement saved.').first()).toBeVisible();
  });

  test('firewalls: created from a template, rules edited and checked, deleted', async ({ page }) => {
    await signInAdmin(page);
    await expect(page).toHaveURL(/\/admin$/);
    await page.getByRole('link', { name: 'Firewalls' }).click();
    await page.getByRole('button', { name: 'Create firewall' }).first().click();
    const dialog = page.getByRole('dialog');
    const name = 'e2e-web-' + Date.now().toString(36);
    await dialog.getByLabel('Name').fill(name);
    await dialog.getByRole('button', { name: 'Create firewall' }).click();
    await expect(page).toHaveURL(/\/firewalls\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    // The web template: SSH, HTTP, HTTPS and ping.
    const descriptions = page.getByRole('textbox', { name: 'Description' });
    await expect(descriptions).toHaveCount(4);
    for (const [i, d] of ['SSH', 'HTTP', 'HTTPS', 'Ping'].entries()) await expect(descriptions.nth(i)).toHaveValue(d);
    await expect(page.getByText('No outbound rules: all outgoing traffic is allowed.')).toBeVisible();
    // A bad port is refused by the API and shown under the field.
    await page.getByRole('button', { name: 'Rule', exact: true }).first().click();
    await page.getByRole('textbox', { name: 'Port or range' }).last().fill('70000');
    await page.getByRole('button', { name: 'Save rules' }).click();
    await expect(page.getByText('Port must be between 1 and 65535.')).toBeVisible();
    await page.getByRole('textbox', { name: 'Port or range' }).last().fill('8000-8100');
    await page.getByRole('button', { name: 'Save rules' }).click();
    await expect(page.getByText('Saved.').first()).toBeVisible();
    await expect(page.getByText('5 of 50 rules')).toBeVisible();
    await page.goto('/firewalls');
    const card = page.getByRole('link', { name: new RegExp(name) });
    await expect(card).toContainText('5 inbound · 0 outbound rules');
    await card.click();
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page).toHaveURL(/\/firewalls$/);
    await expect(page.getByRole('link', { name: new RegExp(name) })).toHaveCount(0);
  });

  test('payments: live credentials saved apart from test ones, checked, activated and removed', async ({ page }) => {
    await signInAdmin(page);
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto('/admin/settings?tab=payments');
    await expect(page.getByText('No payment method is active.', { exact: false })).toBeVisible();
    await page.getByLabel('Search providers').fill('shopier');
    await page.getByRole('button', { name: /Shopier/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Live credentials' }).click();
    await dialog.getByRole('textbox', { name: 'API key' }).fill('e2e-live-key');
    await dialog.getByLabel('API secret').fill('e2e-live-secret');
    await dialog.getByRole('button', { name: 'Mode in use' }).click();
    await page.getByRole('option', { name: /^Live/ }).click();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.').first()).toBeVisible();
    // Not checked yet: activating is refused with the reason.
    await dialog.getByRole('switch').dispatchEvent('click'); // a toast may cover its spot
    await expect(page.getByText('Check the saved credentials of this mode first.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Check Live credentials' }).click();
    await expect(dialog.getByText('Cannot be checked').first()).toBeVisible();
    await dialog.getByRole('switch').dispatchEvent('click'); // a toast may cover its spot
    await expect(page.getByText('Activated in Live mode.')).toBeVisible();
    // The secret is never sent back: the field stays empty with a "saved" hint.
    await expect(dialog.getByLabel('API secret')).toHaveValue('');
    await dialog.getByRole('button', { name: 'Close' }).last().click();
    await expect(page.getByRole('button', { name: /Shopier/ }).last()).toContainText('Active · live'); // the card; the first one is the active list
    await page.getByRole('button', { name: /Shopier/ }).last().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('Provider removed.')).toBeVisible();
  });

  test('billing: an invoice awaits payment, a declined card keeps it awaiting, a good one pays it; staff see it all', async ({ page }) => {
    test.setTimeout(180_000);
    const shot = async (name: string) => page.screenshot({ path: `test-results/tour/${name}.png`, fullPage: true });
    const csrf = { 'x-lightning-csrf': '1' };
    await signInAdmin(page);
    // Settings → Billing: turned on with the seller and the sandbox provider.
    await page.goto('/admin/settings?tab=billing');
    await expect(page.getByText('Billing on', { exact: true }).first()).toBeVisible();
    await page.getByLabel('Company title').fill('Lightning Bilişim A.Ş.');
    await page.getByLabel('VKN').fill('1234567890');
    await page.getByLabel('Tax office').fill('Kadıköy');
    await page.getByLabel('Address', { exact: true }).fill('Moda Cd. 1');
    await page.getByLabel('District').fill('Kadıköy');
    await page.getByLabel('City').fill('İstanbul');
    for (const name of ['Billing on', 'Sandbox provider']) await tick(page.getByRole('switch', { name }));
    await page.waitForTimeout(400);
    await shot('billing-settings');
    await page.getByRole('button', { name: 'Save', exact: true }).last().click();
    await expect(page.getByText('Billing settings saved.')).toBeVisible();
    // Settings → e-Invoice: the integrators with what was tried against their test systems.
    await page.goto('/admin/settings?tab=einvoice');
    await choose(page, page, 'Integrator', 'İzibiz');
    await expect(page.getByText(/Tested with its test system: e-Arşiv/)).toBeVisible();
    await page.waitForTimeout(400);
    await shot('einvoice-settings');
    // An invoice for the admin's own account (a service), then the customer's side of it.
    const me = await (await page.request.get('/api/auth/me')).json();
    const made = await page.request.post('/api/admin/billing/invoices', { headers: csrf, data: { userId: me.id, currency: 'TRY', lines: [{ description: 'Kurulum hizmeti', unitPrice: '250', quantity: 1 }], dueDays: 7 } });
    expect(made.ok()).toBe(true);
    const { invoiceId } = await made.json();
    await page.goto('/billing');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Billing');
    await expect(page.getByText('Your invoice details are missing')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Billing', exact: true }).first()).toBeVisible();
    await page.waitForTimeout(600);
    await shot('billing-customer');
    // Invoice details: a wrong TCKN is refused, a right one saved.
    await page.getByRole('tab', { name: 'Invoice details' }).click();
    await page.getByLabel('Full name').fill('Admin Example');
    await page.getByLabel('TCKN').fill('12345678901');
    await page.getByLabel('City').fill('İstanbul');
    await page.getByLabel('District').fill('Kadıköy');
    await page.getByLabel('Address', { exact: true }).fill('Moda Cd. 2');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Not a valid T.C. identity number.')).toBeVisible();
    await page.getByLabel('TCKN').fill('10000000146');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Invoice details saved.')).toBeVisible();
    await page.waitForTimeout(400);
    await shot('billing-profile');
    // Pay: the sandbox page, a declined card first (the invoice still awaits payment), then a good one.
    await page.goto(`/billing/invoices/${invoiceId}`);
    await expect(page.getByText('Pro forma · awaiting payment')).toBeVisible();
    await expect(page.getByText('Awaiting payment', { exact: true }).first()).toBeVisible();
    await page.waitForTimeout(500);
    await shot('billing-invoice-unpaid');
    await page.getByRole('button', { name: /Sandbox/ }).click();
    await expect(page).toHaveURL(/\/billing\/checkout\//);
    await expect(page.getByText('Secure payment', { exact: true })).toBeVisible();
    await page.getByLabel('Card number').fill('4000 0000 0000 0002');
    await page.waitForTimeout(300);
    await shot('billing-checkout');
    await page.getByRole('button', { name: 'Pay', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/billing/invoices/${invoiceId}`));
    await expect(page.getByText(/The last attempt failed: The bank declined the card/)).toBeVisible();
    await expect(page.getByText('Pro forma · awaiting payment')).toBeVisible();
    await page.getByRole('button', { name: /Sandbox/ }).click();
    await page.getByLabel('Card number').fill('4242 4242 4242 4242');
    await page.getByRole('button', { name: 'Pay', exact: true }).click();
    await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('heading', { level: 2 }).filter({ hasText: /^LVM\d{13}$/ })).toBeVisible();
    await page.waitForTimeout(600);
    await shot('billing-invoice-paid');
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoOverflow(page, 'paid invoice at 390 px');
    await shot('billing-invoice-390');
    await page.goto('/billing');
    await expectNoOverflow(page, 'billing at 390 px');
    await expect(page.getByText('Balance', { exact: true }).first()).toBeVisible();
    await page.waitForTimeout(900);
    await shot('billing-customer-390');
    await page.setViewportSize({ width: 1280, height: 720 });
    // Staff: revenue, the invoice with its two payments, and the actions on it.
    await page.goto('/admin/billing');
    await expect(page.getByText('Monthly recurring revenue')).toBeVisible();
    await expect(page.getByRole('grid', { name: 'Invoices' })).toContainText('Admin Example');
    await page.waitForTimeout(900);
    await shot('billing-admin');
    await page.getByRole('tab', { name: 'Payments' }).click();
    await expect(page.getByRole('grid', { name: 'Payments' }).getByText('Failed', { exact: true }).first()).toBeVisible();
    await page.waitForTimeout(400);
    await shot('billing-admin-payments');
    await page.goto(`/admin/billing/invoices/${invoiceId}`);
    await page.getByRole('button', { name: 'Refund', exact: true }).click();
    await page.getByLabel('Amount', { exact: true }).fill('50');
    await tick(page.getByRole('checkbox', { name: /Refund to the customer.s balance instead/ }));
    await page.getByRole('dialog').getByRole('button', { name: 'Refund', exact: true }).click();
    await expect(page.getByText('Partly refunded').first()).toBeVisible();
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto('/admin/billing');
    await expectNoOverflow(page, 'admin billing at 820 px');
    await page.waitForTimeout(600);
    await shot('billing-admin-820');
    await page.setViewportSize({ width: 1280, height: 720 });
    // Off again for the rest of the suite.
    expect((await page.request.put('/api/admin/settings/billing', { headers: csrf, data: { enabled: false, sandbox: false } })).ok()).toBe(true);
  });

  test('IP pools: quarantine and IPv6 are edited, addresses are listed; reverse DNS settings validate', async ({ page }) => {
    await signInAdmin(page);
    await page.goto('/admin/catalog?tab=ip');
    await page.getByRole('button', { name: 'Edit' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Quarantine (hours)' }).fill('12');
    await dialog.getByLabel('IPv6 prefix').fill('2001:db8:30::/64');
    await dialog.getByLabel('IPv6 gateway').fill('2001:db8:99::1');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByText('The gateway must be inside the IPv6 prefix.')).toBeVisible();
    await dialog.getByLabel('IPv6 gateway').fill('2001:db8:30::1');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('quarantine 12 h').filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByText('2001:db8:30::/64').filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Addresses' })).toBeVisible();

    await page.goto('/admin/settings?tab=rdns');
    await page.getByRole('button', { name: 'Provider' }).click();
    await page.getByRole('option', { name: /PowerDNS/ }).click();
    await page.getByLabel('API address').fill('not a url');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Enter only scheme, host name/IP and optional port.', { exact: false })).toBeVisible();
    await expect(page.getByText('This field is required.')).toBeVisible();
  });

  // Phone and tablet: every page without sideways scrolling.
  // Phone, tablet and a wide desktop: no sideways scrolling, and on the wide screen the content uses the width
  // beside the menu instead of sitting in a narrow middle column.
  for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1920, height: 1080 }]) test(`every page fits ${viewport.width} px without sideways scrolling`, async ({ browser }) => {
    test.setTimeout(150_000);
    const page = await (await browser.newContext({ locale: 'en-US', viewport })).newPage();
    await signInAdmin(page);
    await expect(page).toHaveURL(/\/admin$/);
    for (const path of ['/admin', '/admin/servers', '/admin/vmware', '/admin/catalog', '/admin/users', '/admin/roles', '/admin/settings?tab=mail', '/admin/system', '/', '/order', '/firewalls', '/admin/settings?tab=rdns', '/admin/catalog?tab=ip', '/account?tab=security',
      '/admin/topology', '/admin/energy', '/admin/abuse', '/admin/catalog?tab=locations', '/admin/catalog?tab=isos', '/admin/catalog?tab=vdcs', '/admin/settings?tab=domain', '/admin/settings?tab=servers', '/topology', '/vdc', '/account?tab=accessibility',
      '/admin/catalog?tab=packages', '/admin/catalog?tab=apps', '/admin/settings?tab=security', '/admin/settings?tab=notifications', '/account?tab=keys', '/account?tab=notifications', '/admin/audit', '/account?tab=activity', '/admin/settings?tab=announcement', '/admin/terminal', '/admin/settings?tab=chat', '/admin/settings?tab=directory', '/admin/roles', '/admin/settings?tab=status', '/status', '/support', '/admin/support', '/admin/settings?tab=support', '/admin/stats', '/account?tab=api', '/reseller', '/networks']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoOverflow(page, `${path} at ${viewport.width} px`);
      // Panel pages use the width beside the menu; the public status page is a centred column on purpose.
      if (viewport.width >= 1600 && path !== '/status') {
        const used = await page.evaluate(() => {
          const free = window.innerWidth - (document.querySelector('aside')?.getBoundingClientRect().width ?? 0);
          return (document.querySelector('main > div')?.getBoundingClientRect().width ?? 0) / free;
        });
        expect(used, `${path}: content uses ${Math.round(used * 100)}% of the width beside the menu`).toBeGreaterThan(0.85);
      }
    }
  });

  // New screens render and carry their heading; full-page screenshots go to test-results/tour for review.
  // Dark mode: the newer screens keep their contrast and surfaces (charts, heatmap, cards, dialogs).
  test('dark mode on the newer screens', async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await (await browser.newContext({ locale: 'en-US', colorScheme: 'dark', viewport: { width: 1280, height: 900 } })).newPage();
    await signInAdmin(page);
    for (const [path, name, heading] of [['/admin/stats', 'dark-stats', 'Statistics'], ['/admin/system', 'dark-system', 'System'], ['/admin/support', 'dark-support', 'Support queue'],
      ['/account', 'dark-account', 'My account']] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.classList.contains('dark') || document.documentElement.dataset.theme === 'dark')).toBe(true);
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `test-results/tour/${name}.png`, fullPage: true });
    }
  });

  test('tour of the newer screens', async ({ browser }) => {
    test.setTimeout(360_000);
    const shot = async (page: Page, name: string) => page.screenshot({ path: `test-results/tour/${name}.png`, fullPage: true });
    const guest = await (await browser.newContext({ locale: 'tr-TR' })).newPage();
    // The public status page needs no sign-in.
    await guest.goto('/status');
    await expect(guest.getByRole('heading', { level: 1 })).toHaveText('Sistem durumu');
    await expect(guest.getByRole('status').first()).toBeVisible();
    await guest.waitForTimeout(800);
    await shot(guest, 'status-page');
    for (const path of ['/login', '/register']) {
      await guest.goto(path);
      await expect(guest.getByRole('heading', { level: 1 })).toBeVisible();
      await guest.waitForTimeout(1200);
      await shot(guest, path.slice(1));
    }
    // The method used last time is a tag on its button, not text squeezed next to the label.
    await guest.context().addCookies([{ name: 'better-auth.last_used_login_method', value: 'email', url: new URL(guest.url()).origin }]);
    await guest.goto('/login');
    await expect(guest.getByText('Son kullanılan')).toBeVisible();
    await guest.waitForTimeout(800);
    await shot(guest, 'login-last-used');
    // A wrong password: the error, the shake and the red glow.
    await guest.getByLabel('E-posta').fill('nobody@example.test');
    await guest.getByLabel('Parola', { exact: true }).fill('wrong-password-123');
    await guest.getByRole('button', { name: 'Giriş yap', exact: true }).click();
    await expect(guest.locator('form').getByRole('alert')).toBeVisible();
    await guest.waitForTimeout(150);
    await shot(guest, 'login-failure');
    const page = await (await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })).newPage();
    await signInAdmin(page);
    await page.goto('/admin/energy');
    await page.getByRole('button', { name: 'Measure now' }).click();
    await page.waitForTimeout(6000);
    for (const [path, name] of [['/admin', 'admin-dashboard'], ['/', 'my-servers'], ['/admin/topology', 'admin-topology'], ['/admin/energy', 'energy'], ['/admin/abuse', 'abuse'], ['/admin/catalog?tab=locations', 'locations'],
      ['/admin/catalog?tab=isos', 'isos'], ['/admin/catalog?tab=apps', 'apps'], ['/admin/catalog?tab=vdcs', 'vdcs'], ['/admin/settings?tab=domain', 'domain'],
      ['/admin/settings?tab=security', 'security'], ['/admin/settings?tab=servers', 'server-settings'], ['/topology', 'my-topology'], ['/vdc', 'my-vdc'], ['/order', 'order'], ['/admin/audit', 'audit'], ['/account?tab=activity', 'activity'], ['/admin/settings?tab=announcement', 'announcement'], ['/admin/terminal', 'terminal'], ['/admin/settings?tab=mail', 'mail'], ['/admin/settings?tab=payments', 'payments'], ['/admin/settings?tab=sms', 'sms'], ['/admin/settings?tab=chat', 'chat-settings'], ['/admin/settings', 'settings-general'], ['/admin/settings?tab=directory', 'directory'], ['/account?tab=notifications', 'my-notifications']] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForTimeout(1500);
      await shot(page, name);
    }
    // API: a token is shown once after it is made.
    await page.goto('/account?tab=api');
    await expect(page.getByText('API tokens', { exact: true })).toBeVisible(); // the tab comes from the address after the first paint
    // Typed again until the page has hydrated and keeps it (text typed into the server-rendered field is dropped).
    await expect(async () => {
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill('ci');
      await expect(page.getByRole('button', { name: 'Create token' })).toBeEnabled({ timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Create token' }).click();
    await expect(page.getByText('Copy it now: it is shown only once')).toBeVisible();
    await expect(page.getByText(/^lvm_/).first()).toBeVisible();
    await page.waitForTimeout(600);
    await shot(page, 'account-api');
    // Coupons: one made in the billing admin, then listed with its discount. Transfers: the account's tab.
    const code = `E2E${Date.now().toString(36).toUpperCase()}`;
    await page.goto('/admin/billing?tab=coupons');
    await expect(page.getByText('New coupon', { exact: true })).toBeVisible();
    await expect(async () => {
      await page.getByRole('textbox', { name: 'Code', exact: true }).fill(code);
      await page.getByRole('textbox', { name: 'Percent off' }).fill('10');
      await expect(page.getByRole('textbox', { name: 'Code', exact: true })).toHaveValue(code, { timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Create coupon' }).click();
    await expect(page.getByText(`Coupon ${code} created.`)).toBeVisible();
    await expect(page.getByRole('grid', { name: 'Coupons' }).getByText(code, { exact: true })).toBeVisible();
    await shot(page, 'coupons');
    await page.goto('/account?tab=transfers');
    await expect(page.getByText('Offered to you', { exact: true })).toBeVisible();
    await shot(page, 'transfers');
    await page.goto('/account?tab=notifications');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Messaging apps: the picker, then one app's form.
    await page.getByRole('button', { name: 'Connect an app' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, 'chat-connect');
    await page.getByRole('dialog').getByRole('button', { name: 'Slack' }).click();
    await expect(page.getByLabel('Webhook URL')).toBeVisible();
    await shot(page, 'chat-connect-slack');
    await page.keyboard.press('Escape');
    // No field outside signing in is filled or remembered by the browser: autocomplete is off everywhere and secret
    // fields are masked text, so password managers do not see a password field.
    for (const path of ['/admin/settings?tab=mail', '/admin/settings?tab=captcha', '/admin/users', '/account?tab=security', '/order']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForTimeout(500);
      const bad = await page.evaluate(() => [...document.querySelectorAll('input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]), textarea')]
        .filter((el) => el.getAttribute('autocomplete') !== 'off' || (el as HTMLInputElement).type === 'password').map((el) => el.outerHTML.slice(0, 120)));
      expect(bad, path).toEqual([]);
    }
    // The order page's workload advisor marks a recommended package.
    await page.goto('/order');
    await page.getByRole('radio', { name: 'Website' }).click();
    await page.getByRole('radio', { name: 'Medium' }).click();
    await expect(page.getByText(/Suggested to start/)).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, 'order-advisor');
    // An incident: opened in settings, shown in the panel bar and on the status page, then deleted.
    await page.goto('/admin/settings?tab=status');
    await page.getByLabel('Title').fill('Planned network work');
    await page.getByLabel('First update').fill('We are moving the uplinks; short interruptions are possible.');
    await page.getByRole('button', { name: 'Open the incident' }).click();
    await expect(page.getByText('Incident opened.')).toBeVisible();
    await shot(page, 'incidents-admin');
    await page.goto('/');
    await expect(page.getByText('Planned network work').first()).toBeVisible();
    await shot(page, 'incident-banner');
    await page.goto('/status');
    await expect(page.getByRole('heading', { name: 'Planned network work' })).toBeVisible();
    await page.waitForTimeout(600);
    await shot(page, 'status-incident');
    await page.goto('/admin/settings?tab=status');
    await page.getByRole('button', { name: 'Delete' }).first().click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('No incidents yet.')).toBeVisible();
    // Support: a ticket opened from the customer side, then the staff queue and an internal note.
    await page.goto('/support');
    await page.getByRole('button', { name: 'New ticket' }).first().click();
    await page.getByLabel('Subject').fill('Cannot reach my server over SSH');
    await page.getByRole('radio', { name: /High/ }).click();
    await page.getByLabel('Message').fill('SSH times out since this morning. I already restarted the server.');
    await page.waitForTimeout(400);
    await shot(page, 'support-new');
    await page.getByRole('button', { name: 'Send the ticket' }).click();
    await expect(page).toHaveURL(/\/support\/[0-9a-f-]{36}$/);
    await expect(page.getByText('SSH times out since this morning.')).toBeVisible();
    await shot(page, 'support-ticket');
    await page.goto('/admin/support');
    await expect(page.getByText('Cannot reach my server over SSH')).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, 'support-queue');
    // Canned replies are kept from the queue, with placeholders filled in when picked.
    await page.getByRole('button', { name: 'Canned replies' }).click();
    await page.getByLabel('Title').fill('Firewall check');
    await page.getByLabel('Reply', { exact: true }).fill('Hi {name}, about {ticket}: please check the firewall of {server}.');
    await page.getByRole('button', { name: 'Add canned reply' }).click();
    await expect(page.getByRole('dialog').getByText('Firewall check')).toBeVisible();
    await page.waitForTimeout(500);
    await shot(page, 'support-canned');
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByText('Cannot reach my server over SSH').click();
    // On your own ticket you write as a customer (internal notes are for other people's tickets).
    await expect(page.getByRole('button', { name: 'Internal note' })).toHaveCount(0);
    await page.getByLabel('Your reply').fill('Probably the firewall; checking.');
    // An unsent reply survives a reload; Ctrl+Enter sends it.
    await page.reload();
    await expect(page.getByLabel('Your reply')).toHaveValue('Probably the firewall; checking.');
    await page.getByLabel('Your reply').press('Control+Enter');
    await expect(page.locator('main').getByText('Probably the firewall; checking.')).toBeVisible();
    await expect(page.getByLabel('Your reply')).toHaveValue('');
    await shot(page, 'support-staff');
    // Statistics: headline numbers with their trend, charts, breakdowns and the weekday × hour map, on desktop and a phone.
    await page.goto('/admin/stats');
    await expect(page.getByRole('heading', { name: 'Statistics', level: 1 })).toBeVisible();
    await expect(page.getByText('Live servers', { exact: true })).toBeVisible();
    await expect(page.getByText('When people act')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Highlights' }).getByRole('listitem').first()).toBeVisible();
    await page.waitForTimeout(2200);
    await shot(page, 'stats');
    // The series downloads as CSV.
    const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download CSV' }).click()]);
    expect(csv.suggestedFilename()).toBe('statistics-30d.csv');
    await page.getByRole('radio', { name: '1 year' }).click();
    await expect(page).toHaveURL(/days=365/);
    await page.waitForTimeout(2000);
    await shot(page, 'stats-year');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/admin/stats?days=7');
    await page.waitForTimeout(2200);
    await shot(page, 'stats-phone');
    await page.setViewportSize({ width: 1280, height: 720 });
    // A personal time zone: searched, picked, saved; then back to automatic.
    await page.goto('/account');
    await page.getByRole('combobox', { name: 'Time zone' }).fill('Istanbul');
    await page.getByRole('option', { name: /Europe\/Istanbul/ }).click();
    await expect(page.getByText('Time zone saved').first()).toBeVisible();
    await page.waitForTimeout(600);
    await shot(page, 'account-region');
    await page.getByRole('combobox', { name: 'Time zone' }).fill('Automatic');
    await page.getByRole('option', { name: /^Automatic/ }).click();
    // This server: its clock, details and settings form (applied by the host agent).
    await page.goto('/admin/system');
    await expect(page.getByRole('heading', { name: 'This server' })).toBeVisible();
    await page.waitForTimeout(800);
    await shot(page, 'host-settings');
    // Sign-in methods: GitHub and user names on; the sign-in page then offers them. Turned off again afterwards.
    await page.goto('/admin/settings?tab=signin');
    await expect(page.getByText('Social sign-in', { exact: true })).toBeVisible();
    await tick(page.getByRole('switch', { name: 'Turn on GitHub' }));
    await page.getByLabel('Client ID').fill('Iv1.e2etest');
    await page.getByLabel('Client secret').fill('e2e-secret-value');
    await tick(page.getByRole('switch', { name: 'Sign in with a user name' }));
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved.').first()).toBeVisible();
    await expect(page.getByText(/\/api\/auth\/callback\/github$/)).toBeVisible();
    await page.waitForTimeout(500);
    await shot(page, 'signin-settings');
    const visitor = await (await browser.newContext({ locale: 'en-US' })).newPage();
    await visitor.goto('/login');
    await expect(visitor.getByRole('button', { name: 'Continue with GitHub' })).toBeVisible();
    await expect(visitor.getByLabel('E-mail or user name')).toBeVisible();
    await visitor.waitForTimeout(500);
    await visitor.screenshot({ path: 'test-results/tour/login-methods.png', fullPage: true });
    await visitor.close();
    expect((await page.request.put('/api/admin/settings/sign-in', { headers: { 'x-lightning-csrf': '1' }, data: { username: false, providers: { github: { enabled: false } } } })).ok()).toBe(true);
    // The command palette finds a ticket by its number.
    await page.goto('/admin');
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox').fill('1001');
    await expect(page.getByRole('option', { name: /#1001 Cannot reach my server over SSH/ })).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'test-results/tour/palette-ticket.png' });
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/admin\/support\/[0-9a-f-]{36}$/);
    // The inbox: grouped by day, an icon per kind.
    await page.getByRole('button', { name: /notifications/i }).first().click();
    await expect(page.getByRole('dialog').getByText('Today')).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'test-results/tour/bell.png' });
    await page.keyboard.press('Escape');
    // The menu counts tickets waiting for support; the list and the queue on a phone.
    await expect(page.locator('nav a[href="/admin/support"]')).toContainText(/\d/);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [path, name] of [['/support', 'support-list-phone'], ['/admin/support', 'support-queue-phone']]) {
      await page.goto(path);
      await expect(page.getByText('Cannot reach my server over SSH').first()).toBeVisible();
      await page.waitForTimeout(400);
      await shot(page, name);
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    // Single sign-on: the settings card and its setup guide.
    await page.goto('/admin/settings?tab=directory');
    await expect(page.getByText('Single sign-on (OpenID Connect)')).toBeVisible();
    await expect(page.getByText(/\/api\/auth\/callback\/oidc$/)).toBeVisible();
    // Outside signing in there is never a password field, not even in the first HTML: browsers fill those (and the field before them).
    expect(await (await page.request.get('/admin/settings?tab=directory')).text()).not.toContain('type="password"');
    await expect(page.locator('input[type=password]')).toHaveCount(0);
    expect(await page.locator('input').evaluateAll((els) => els.filter((e) => (e as HTMLInputElement).value.includes('@example.test')).length)).toBe(0);
    await page.waitForTimeout(400);
    await shot(page, 'sso-settings');
    await page.getByRole('button', { name: 'What is it, how to set it up?' }).nth(1).click();
    await expect(page.getByRole('dialog')).toContainText('Microsoft Entra ID');
    await page.waitForTimeout(600);
    await shot(page, 'sso-guide');
    await page.keyboard.press('Escape');
    // A person at a glance from the user list.
    await page.goto('/admin/users');
    await page.getByRole('button', { name: /admin@example.test/ }).first().click();
    await expect(page.getByRole('dialog')).toContainText('Recent activity');
    await page.waitForTimeout(900);
    await shot(page, 'user-summary');
    // Staff notes: added, pinned, and the pinned one shows under the name in the list.
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: /A call, an agreement/ }).fill('Prefers e-mail; renewal agreed for March.');
    await dialog.getByRole('button', { name: 'Add note' }).click();
    await expect(dialog.getByText('Prefers e-mail; renewal agreed for March.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Pin to the users list' }).click();
    await expect(dialog.getByText('Pinned', { exact: true })).toBeVisible();
    await page.waitForTimeout(500);
    await shot(page, 'user-notes');
    await page.getByRole('dialog').locator('[data-slot="modal-close-trigger"]').click();
    await expect(page.getByRole('dialog')).toBeHidden(); // its closing backdrop would catch the next click
    await expect(page.getByRole('row', { name: /Prefers e-mail; renewal agreed/ })).toBeVisible();
    await shot(page, 'users-pinned-note');
    // Bulk: one action for the people the list shows (yourself left out), and the list as CSV.
    await page.getByRole('button', { name: /Act on \d+ (person|people)/ }).click();
    await expect(page.getByRole('dialog')).toContainText('Filter the list first');
    await page.getByRole('dialog').getByRole('textbox', { name: 'Subject' }).fill('Maintenance tonight');
    await page.waitForTimeout(400);
    await shot(page, 'users-bulk');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    await shot(page, 'users-bulk-390');
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    expect((await download).suggestedFilename()).toMatch(/^users-\d{4}-\d{2}-\d{2}\.csv$/);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    await shot(page, 'users-390');
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.waitForTimeout(400);
    await shot(page, 'users-820');
    await page.setViewportSize({ width: 1280, height: 720 });
    // Who is here: the overview's "Online now" shows this admin; the users' "Online or active" card filters to them.
    await page.goto('/admin');
    await expect(page.getByRole('list', { name: 'Online now' }).getByRole('listitem').first()).toBeVisible();
    await page.goto('/admin/users');
    // Presence and sessions: the admin's own row is online (this tab), its sessions list device and activity.
    await expect(page.getByRole('img', { name: 'Online' }).first()).toBeVisible();
    await page.getByRole('button', { name: /Actions for admin@example.test/ }).click();
    await page.getByRole('menuitem', { name: 'Sessions' }).click();
    await expect(page.getByRole('dialog').getByText('This device').or(page.getByRole('dialog').getByText('Open now')).first()).toBeVisible();
    await page.waitForTimeout(600);
    await shot(page, 'user-sessions');
    await page.keyboard.press('Escape');
    await page.goto('/account?tab=security');
    await expect(page.getByText('Open now').first()).toBeVisible();
    await shot(page, 'account-sessions');
    // The role editor: permissions, then limits.
    await page.goto('/admin/roles');
    await page.getByRole('button', { name: 'New role' }).click();
    await expect(page.getByRole('dialog')).toContainText('Limits');
    await page.waitForTimeout(400);
    await shot(page, 'role-editor');
    await page.keyboard.press('Escape');
    // A setup guide opens in a dialog.
    await page.goto('/admin/settings?tab=rdns');
    await page.getByRole('button', { name: 'What is it, how to set it up?' }).click();
    await expect(page.getByRole('dialog')).toContainText('PowerDNS');
    await page.waitForTimeout(900);
    await shot(page, 'guide-powerdns');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Accessibility' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await shot(page, 'accessibility');
    // Loading layer: the first-load copy leaves once the page is interactive; a page change shows it (here started by
    // hand, so it stays long enough for the picture) and the next URL clears it.
    await page.keyboard.press('Escape');
    await expect(page.locator('#boot-loader')).toHaveClass(/page-loader-hidden/);
    await page.evaluate(() => window.dispatchEvent(new Event('lvm:navigation-start')));
    await expect(page.locator('.page-loader:not(.page-loader-hidden)')).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, 'page-loader');
    await page.evaluate(() => window.history.pushState(null, '', '?loader=done'));
    await expect(page.locator('.page-loader:not(.page-loader-hidden)')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByRole('heading', { level: 1 }).click();
    await page.keyboard.press('Shift+?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await shot(page, 'shortcuts');
    // The same overview screens at phone and tablet width.
    for (const width of [390, 768, 1920]) {
      const small = await (await browser.newContext({ locale: 'en-US', viewport: { width, height: 1000 } })).newPage();
      await signInAdmin(small);
      for (const [path, name] of [['/admin', 'admin-dashboard'], ['/', 'my-servers'], ['/admin/energy', 'energy'], ['/admin/settings', 'settings']] as const) {
        await small.goto(path);
        await expect(small.getByRole('heading', { level: 1 })).toBeVisible();
        await small.waitForTimeout(1200);
        await shot(small, `${name}-${width}`);
      }
    }
  });
});
