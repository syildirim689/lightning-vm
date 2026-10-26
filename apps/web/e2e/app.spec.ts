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
async function expectNoOverflow(page: Page, label: string) {
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
    test.setTimeout(120_000);
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
    await expect(page.locator('.quote')).toContainText('Aylık: €3,00');
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
    // Snapshot: taken as an operation, then listed as the current state.
    await page.getByLabel('Ad', { exact: true }).fill('guncelleme-oncesi');
    await page.getByRole('button', { name: 'Anlık görüntü al' }).click();
    await expect(page.getByText('guncelleme-oncesi')).toBeVisible({ timeout: 45_000 });
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
    await page.goto('/?q=yok-boyle');
    await expect(page.getByText('Bu süzgeçlere uyan sunucu yok.').or(page.getByText('web-1'))).toBeVisible();
    // Ctrl+K lists the server just opened under "recent".
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('listbox').getByText('Son açılanlar')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/servers\/[0-9a-f-]{36}$/);

    await page.getByRole('button', { name: 'Zorla kapat' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('kaydedilmemiş veriler kaybolabilir');
    await page.getByRole('button', { name: 'Evet, Zorla kapat' }).click();
    await expect(page.getByText(/Hazır · kapalı/).first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Aç', exact: true }).click();
    await expect(page.getByText(/Hazır · açık/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('grid', { name: 'İşlem geçmişi' })).toContainText('Oluşturma');

    const del = page.getByRole('button', { name: 'Sunucuyu kalıcı olarak sil' });
    await expect(del).toBeDisabled();
    await page.getByLabel('Onaylamak için “web-1” yazın').fill('web-1');
    await del.click();
    await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
    await expect(page.getByText('Henüz sunucunuz yok.')).toBeVisible();
    // The account activity lists the customer's own sign-in and server actions.
    await page.goto('/account?tab=activity');
    await expect(page.getByText('Sunucu silindi').first()).toBeVisible();
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
      '/account?tab=security', '/account?tab=notifications']) {
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
    await page.getByRole('link', { name: 'Users' }).click();
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
  for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }]) test(`every page fits ${viewport.width} px without sideways scrolling`, async ({ browser }) => {
    test.setTimeout(150_000);
    const page = await (await browser.newContext({ locale: 'en-US', viewport })).newPage();
    await signInAdmin(page);
    await expect(page).toHaveURL(/\/admin$/);
    for (const path of ['/admin', '/admin/servers', '/admin/vmware', '/admin/catalog', '/admin/users', '/admin/roles', '/admin/settings?tab=mail', '/admin/system', '/', '/order', '/firewalls', '/admin/settings?tab=rdns', '/admin/catalog?tab=ip', '/account?tab=security',
      '/admin/topology', '/admin/energy', '/admin/abuse', '/admin/catalog?tab=locations', '/admin/catalog?tab=isos', '/admin/catalog?tab=vdcs', '/admin/settings?tab=domain', '/admin/settings?tab=servers', '/topology', '/vdc', '/account?tab=accessibility',
      '/admin/catalog?tab=packages', '/admin/catalog?tab=apps', '/admin/settings?tab=security', '/admin/settings?tab=notifications', '/account?tab=keys', '/account?tab=notifications', '/admin/audit', '/account?tab=activity', '/admin/settings?tab=announcement']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoOverflow(page, `${path} at ${viewport.width} px`);
    }
  });

  // New screens render and carry their heading; full-page screenshots go to test-results/tour for review.
  test('tour of the newer screens', async ({ browser }) => {
    test.setTimeout(180_000);
    const shot = async (page: Page, name: string) => page.screenshot({ path: `test-results/tour/${name}.png`, fullPage: true });
    const guest = await (await browser.newContext({ locale: 'tr-TR' })).newPage();
    for (const path of ['/login', '/register']) {
      await guest.goto(path);
      await expect(guest.getByRole('heading', { level: 1 })).toBeVisible();
      await guest.waitForTimeout(1200);
      await shot(guest, path.slice(1));
    }
    const page = await (await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })).newPage();
    await signInAdmin(page);
    await page.goto('/admin/energy');
    await page.getByRole('button', { name: 'Measure now' }).click();
    await page.waitForTimeout(6000);
    for (const [path, name] of [['/admin', 'admin-dashboard'], ['/', 'my-servers'], ['/admin/topology', 'admin-topology'], ['/admin/energy', 'energy'], ['/admin/abuse', 'abuse'], ['/admin/catalog?tab=locations', 'locations'],
      ['/admin/catalog?tab=isos', 'isos'], ['/admin/catalog?tab=apps', 'apps'], ['/admin/catalog?tab=vdcs', 'vdcs'], ['/admin/settings?tab=domain', 'domain'],
      ['/admin/settings?tab=security', 'security'], ['/admin/settings?tab=servers', 'server-settings'], ['/topology', 'my-topology'], ['/vdc', 'my-vdc'], ['/order', 'order'], ['/admin/audit', 'audit'], ['/account?tab=activity', 'activity'], ['/admin/settings?tab=announcement', 'announcement']] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForTimeout(1500);
      await shot(page, name);
    }
    await page.getByRole('button', { name: 'Accessibility' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await shot(page, 'accessibility');
    await page.keyboard.press('Escape');
    await page.getByRole('heading', { level: 1 }).click();
    await page.keyboard.press('Shift+?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await shot(page, 'shortcuts');
    // The same overview screens at phone and tablet width.
    for (const width of [390, 768]) {
      const small = await (await browser.newContext({ locale: 'en-US', viewport: { width, height: 1000 } })).newPage();
      await signInAdmin(small);
      for (const [path, name] of [['/admin', 'admin-dashboard'], ['/', 'my-servers'], ['/admin/energy', 'energy']] as const) {
        await small.goto(path);
        await expect(small.getByRole('heading', { level: 1 })).toBeVisible();
        await small.waitForTimeout(1200);
        await shot(small, `${name}-${width}`);
      }
    }
  });
});
