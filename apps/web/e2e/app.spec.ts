import { expect, test, type Page } from '@playwright/test';

// Serial: the first tests perform first-run setup that later tests rely on.
test.describe.configure({ mode: 'serial' });

const admin = { email: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test', password: process.env.E2E_ADMIN_PASSWORD ?? 'e2e admin passphrase 2026' };
const user = { email: `user-${Date.now()}@example.test`, password: 'e2e user passphrase 2026' };

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel(/E-posta|Email/).fill(who.email);
  await page.getByLabel(/Parola|Password/).fill(who.password);
  await page.getByRole('button', { name: /Giriş yap|Sign in/ }).click();
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
    const saveAndContinue = () => page.getByRole('button', { name: 'Kaydet ve devam et' }).click();
    const skip = () => page.getByRole('button', { name: 'Şimdilik atla' }).click();

    await page.goto('/setup');
    await page.getByLabel('Kurulum anahtarı').fill('wrong-token');
    await page.getByRole('button', { name: 'Kuruluma başla' }).click();
    await expect(page.locator('main [role=alert]')).toHaveText('Kurulum anahtarı geçersiz veya süresi dolmuş. Sunucuda yeni anahtar üretin.');
    await page.getByLabel('Kurulum anahtarı').fill(token!);
    await page.getByRole('button', { name: 'Kuruluma başla' }).click();

    await expect(heading).toHaveText('Dil');
    await saveAndContinue();
    await expect(heading).toHaveText('Sistem ön kontrolleri');
    await page.getByRole('button', { name: 'Bağlantıyı test et' }).click();
    for (const name of ['PostgreSQL', 'Redis', "Veritabanı migration'ları", 'Arka plan çalışanı']) {
      await expect(page.locator('li.ok', { hasText: name })).toContainText('Başarılı');
    }
    await saveAndContinue();
    await expect(heading).toHaveText('Dağıtım ve erişim adresi');

    // Progress lives on the server: a reload returns to the first unfinished step.
    await page.reload();
    await expect(heading).toHaveText('Dağıtım ve erişim adresi');

    await page.getByLabel('Panel adresi').fill('http://panel.example.com/yol');
    await saveAndContinue();
    await expect(page.getByText('Yalnızca şema, alan adı/IP ve isteğe bağlı port girin.', { exact: false })).toBeVisible();
    const domain = process.env.E2E_DOMAIN;
    await page.getByLabel('Panel adresi').fill(domain ? `https://${domain}` : 'http://127.0.0.1:8080');
    await page.getByRole('button', { name: 'Bağlantıyı test et' }).click();
    if (domain) await expect(page.locator('li.ok', { hasText: 'Panel adresi' })).toContainText('Başarılı');
    else await expect(page.locator('li.fail', { hasText: 'Panel adresi' })).toContainText('Yerel adres; doğrulanamaz');
    await saveAndContinue();

    await expect(heading).toHaveText('Alan adı ve HTTPS');
    await page.getByLabel('Alan adı').fill('https://panel.example.com');
    await page.getByRole('button', { name: 'Bağlantıyı test et' }).click();
    await expect(page.getByText('Yalnızca alan adını girin', { exact: false })).toBeVisible();
    if (domain) {
      // Real deployment with a public name: DNS, HTTP and the certificate are each checked for real.
      await page.getByLabel('Alan adı').fill(domain);
      await page.getByRole('button', { name: 'Bağlantıyı test et' }).click();
      await expect(page.locator('li.ok', { hasText: 'DNS' })).toContainText('Başarılı');
      await expect(page.locator('li.ok', { hasText: 'HTTP (80)' })).toContainText("HTTPS'e yönlendiriyor");
      await expect(page.locator('li.ok', { hasText: 'HTTPS sertifikası' })).toContainText('Başarılı');
      await saveAndContinue();
    } else {
      await skip();
    }
    await expect(heading).toHaveText('PostgreSQL ve Redis');
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
      await expect(page.getByLabel('Sertifika doğrulama')).toHaveValue('pinned');
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
    await skip();

    await expect(heading).toHaveText('Son kontrol ve özet');
    await expect(page.getByText('VMware bağlantısı yapılandırılmadı', { exact: false })).toHaveCount(sim ? 0 : 1);
    await expect(page.getByText('Panel adresi bu sunucudan doğrulanamadı', { exact: false })).toHaveCount(domain ? 0 : 1);
    await expect(page.getByText('HTTPS yapılandırılmadı', { exact: false })).toHaveCount(domain ? 0 : 1);
    await page.getByRole('button', { name: 'Kurulumu tamamla' }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByText('İlk kurulum henüz tamamlanmadı.')).toHaveCount(0);

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

  test('sign-in errors are validated on the server and translated', async ({ page }) => {
    await signIn(page, { email: 'not-an-email', password: 'short' });
    await expect(page.getByText('Geçerli bir e-posta adresi girin.')).toBeVisible();
    await signIn(page, { email: admin.email, password: 'wrong passphrase here' });
    await expect(page.locator('main [role=alert]')).toHaveText('E-posta veya parola hatalı.');
  });
});

test.describe('roles and sessions (English browser)', () => {
  test.use({ locale: 'en-US' });

  test('admin sees live system health and opens registration', async ({ page }) => {
    await signIn(page, admin);
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('status')).toHaveText('API, PostgreSQL and Redis are reachable');
    await expect(page.getByText(/Background worker: Running \(last signal .*\d{4}/)).toBeVisible();
    const toggle = page.getByLabel('Allow new user registration');
    await expect(toggle).toBeEnabled();
    // Toggle off then on so the save path is exercised whatever state a previous run left.
    // Controlled input: its state flips only after the API answers.
    if (await toggle.isChecked()) { await toggle.click(); await expect(toggle).not.toBeChecked(); }
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(page.getByText('Saved.')).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Allow new user registration')).toBeChecked();
  });

  test('a registered user gets the user panel but not the admin panel or admin API', async ({ page }) => {
    await page.goto('/register');
    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Password').fill(user.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your servers');
    await expect(page.getByRole('link', { name: 'Admin panel' })).toHaveCount(0);

    await page.goto('/admin');
    await expect(page.locator('main [role=alert]')).toContainText('You do not have permission for this action.');
    const api = await page.request.get('/api/admin/users');
    expect(api.status()).toBe(403);
  });

  test('sign-out ends the session on the server', async ({ page }) => {
    await signIn(page, user);
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole('button', { name: 'Sign out' }).click();
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
    await adminPage.getByLabel('Name').first().fill('E2E Pool');
    await adminPage.getByLabel('Location', { exact: true }).fill('Lab');
    const compute = adminPage.getByLabel('Cluster or host');
    await expect(compute.locator('option', { hasText: '(cluster)' })).toHaveCount(1);
    await compute.selectOption({ label: (await compute.locator('option', { hasText: '(cluster)' }).textContent())! });
    await adminPage.getByRole('group', { name: 'Datastores' }).getByRole('checkbox').first().check();
    const network = adminPage.getByLabel('Network (port group)');
    await network.selectOption({ index: 1 });
    await adminPage.getByRole('button', { name: 'Create pool' }).click();
    await expect(adminPage.getByRole('heading', { name: /E2E Pool/ })).toBeVisible();
    await expect(adminPage.getByRole('rowheader', { name: 'Physical total' })).toBeVisible();
    await expect(adminPage.getByRole('rowheader', { name: 'Management and safety headroom' })).toBeVisible();

    await adminPage.getByText('Add custom resource rule').click();
    await adminPage.getByLabel('Price per vCPU').fill('5');
    await adminPage.getByLabel('Price per GB RAM').fill('2');
    await adminPage.getByLabel('Price per GB disk').fill('0.1');
    await adminPage.getByRole('button', { name: 'Save rule' }).click();
    await expect(adminPage.getByText('Edit custom resource rule')).toBeVisible();

    const pkg = adminPage.locator('form', { has: adminPage.getByRole('heading', { name: 'New package' }) });
    await pkg.getByLabel('Name').fill('E2E Small');
    await pkg.getByLabel('Monthly price').fill('12.1x');
    await pkg.getByRole('button', { name: 'Create package' }).click();
    await expect(pkg.getByText('Enter a valid amount (example: 12.50).')).toBeVisible();
    await expect(pkg.getByText('This field is required.')).toBeVisible();
    await pkg.getByLabel('Monthly price').fill('12.10');
    await pkg.getByRole('group', { name: 'Offered in pools' }).getByLabel('E2E Pool').check();
    await pkg.getByRole('button', { name: 'Create package' }).click();
    await expect(adminPage.getByRole('row', { name: /E2E Small/ })).toContainText('€12.10');

    const customer = await (await browser.newContext({ locale: 'tr-TR' })).newPage();
    await signIn(customer, user);
    await expect(customer).toHaveURL(/\/$/);
    await customer.getByRole('combobox', { name: 'Paket' }).selectOption({ index: 1 });
    await customer.getByRole('button', { name: 'Fiyatı hesapla' }).click();
    await expect(customer.locator('.quote')).toContainText('Aylık: €12,10');
    await customer.getByLabel('Özel kaynaklı').check();
    await expect(customer.getByText('fiziksel olarak ayrılmış (dedicated) işlemci garantisi değildir', { exact: false })).toBeVisible();
    await customer.getByLabel('RAM (MB)').fill('4000');
    await customer.getByRole('button', { name: 'Fiyatı hesapla' }).click();
    await expect(customer.getByText('Değer, izin verilen artış adımına uymuyor.')).toBeVisible();
    await customer.getByLabel('RAM (MB)').fill('4096');
    await customer.getByRole('button', { name: 'Fiyatı hesapla' }).click();
    // 2 x 5 + 4 GB x 2 + 40 GB x 0.1 = 22.00
    await expect(customer.locator('.quote')).toContainText('Aylık: €22,00');

    // An image (the simulator's template) and an IP pool, so the next test can create a server.
    const img = adminPage.locator('form', { has: adminPage.getByRole('heading', { name: 'New image' }) });
    await img.getByLabel('Name').fill('Sim Linux');
    await img.getByLabel('Template').selectOption({ index: 1 });
    await img.getByLabel('Minimum disk').fill('10');
    await img.getByRole('button', { name: 'Add image' }).click();
    await expect(adminPage.getByRole('row', { name: /Sim Linux/ })).toBeVisible();
    const ip = adminPage.locator('form', { has: adminPage.getByRole('heading', { name: 'New IP pool' }) });
    await ip.getByLabel('Name').fill('lab-net');
    await ip.getByLabel('Subnet (CIDR)').fill('10.30.0.0/24');
    await ip.getByLabel('Gateway').fill('10.30.0.1');
    await ip.getByLabel('Range start').fill('10.30.0.20');
    await ip.getByLabel('Range end').fill('10.20.0.30');
    await ip.getByRole('button', { name: 'Add IP pool' }).click();
    await expect(ip.getByText('Gateway and range must be inside the subnet', { exact: false })).toBeVisible();
    await ip.getByLabel('Range end').fill('10.30.0.30');
    await ip.getByRole('button', { name: 'Add IP pool' }).click();
    await expect(adminPage.getByRole('row', { name: /lab-net/ })).toContainText('11');
    const small = adminPage.locator('form', { has: adminPage.getByRole('heading', { name: 'New package' }) });
    await small.getByLabel('Name').fill('E2E Tiny');
    await small.getByLabel('vCPU').fill('1');
    await small.getByLabel('RAM (MB)').fill('512');
    await small.getByLabel('Disk (GB)').fill('10');
    await small.getByLabel('Monthly price').fill('3.00');
    await small.getByRole('group', { name: 'Offered in pools' }).getByLabel('E2E Pool').check();
    await small.getByRole('group', { name: 'Allowed images' }).getByLabel('Sim Linux').check();
    await small.getByRole('button', { name: 'Create package' }).click();
    await expect(adminPage.getByRole('row', { name: /E2E Tiny/ })).toBeVisible();
  });
});

test.describe('VMware connections (simulator, English browser)', () => {
  test.use({ locale: 'en-US' });
  test('admin sees discovered inventory, refreshes it and removes the connection only after typed confirmation', async ({ page }) => {
    test.skip(!process.env.E2E_VCSIM_HOST, 'needs compose.simulator.yaml and E2E_VCSIM_HOST');
    await signIn(page, admin);
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto('/admin/vmware');
    await page.getByRole('row', { name: /Simülatör vCenter/ }).getByRole('button', { name: 'Details' }).click();
    await expect(page.getByRole('heading', { name: 'Physical capacity' })).toBeVisible();
    await expect(page.getByText(/\d+ cores \/ \d+ threads/).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /Virtual machines \(\d+\)/ })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'vCenter Automation REST API' })).toContainText('yes');
    await page.getByRole('button', { name: 'Discover again' }).click();
    await expect(page.getByText('Inventory updated.')).toBeVisible();

    // Console: browser -> Caddy (wss) -> console gateway -> the simulator's fake WebMKS endpoint.
    // Without the operator-installed VMware SDK the page says so; the gateway test still runs end to end.
    await page.getByRole('link', { name: 'Console' }).first().click();
    await expect(page.getByRole('heading', { name: /^Console: / })).toBeVisible();
    await expect(page.getByText('does not bypass the operating system', { exact: false })).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('Console component not installed');
    await page.getByRole('button', { name: 'Test the gateway connection' }).click();
    await expect(page.getByText('Success: the gateway reached the VM', { exact: false })).toBeVisible();
    const consoleCookie = (await page.context().cookies()).find((c) => c.name === 'lvm_console');
    expect(consoleCookie?.httpOnly && consoleCookie.path === '/console/ws' && consoleCookie.sameSite === 'Strict').toBe(true);
    expect(page.url()).not.toContain(consoleCookie!.value);
    // The vCenter now backs a resource pool, so a separate simulated ESXi is added and removed.
    await page.goto('/admin/vmware');
    await page.getByRole('button', { name: 'Add connection' }).click();
    await page.getByLabel('Display name').fill('Sim ESXi');
    await page.getByLabel('Address').fill(process.env.E2E_VCSIM_ESXI ?? 'vcsim-esxi');
    await page.getByLabel('Port').fill('8989');
    await page.getByLabel('Service account').fill('sim-root');
    await page.getByLabel('Password').fill('sim-password-2');
    await page.getByRole('button', { name: 'Test connection' }).click();
    await page.getByRole('button', { name: 'I verified the fingerprint, pin this certificate' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('row', { name: /Sim ESXi/ }).getByRole('button', { name: 'Details' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: 'vCenter Automation REST API' })).toContainText('no');
    const remove = page.getByRole('button', { name: 'Remove connection' });
    await expect(remove).toBeDisabled();
    await page.getByLabel('Type “Sim ESXi” to confirm').fill('Sim ESXi');
    await remove.click();
    await expect(page.getByText('Connection removed.')).toBeVisible();
    await expect(page.getByRole('row', { name: /Sim ESXi/ })).toHaveCount(0);
  });
});

test.describe('server lifecycle (simulator, Turkish customer)', () => {
  test.use({ locale: 'tr-TR' });
  test('a customer creates a server, sees it become ready, powers it off with confirmation and deletes it', async ({ page }) => {
    test.skip(!process.env.E2E_VCSIM_HOST, 'needs compose.simulator.yaml and E2E_VCSIM_HOST');
    await signIn(page, user);
    await expect(page).toHaveURL(/\/$/);
    await page.getByLabel('Anahtar adı').fill('dizüstü');
    await page.getByLabel('Açık anahtar').fill('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMa0iBTtZu9kbSNXzg5M6pZ1rn8F1143iWq3JIcGimfn e2e');
    await page.getByRole('button', { name: 'Anahtar ekle' }).click();
    await expect(page.getByText('SHA256:', { exact: false })).toBeVisible();
    await page.getByLabel('İşletim sistemi').selectOption({ label: 'Sim Linux' });
    await page.getByRole('combobox', { name: 'Paket' }).selectOption({ label: 'E2E Tiny: 1 vCPU, 0,5 GB RAM, 10 GB disk, aylık €3,00' });
    await page.getByRole('button', { name: 'Fiyatı hesapla' }).click();
    await page.getByLabel('Sunucu adı').fill('Web_1');
    await page.getByLabel('dizüstü').check();
    await page.getByRole('button', { name: 'Sunucuyu oluştur' }).click();
    await expect(page.getByText('Küçük harf, rakam ve tire kullanın', { exact: false })).toBeVisible();
    await page.getByLabel('Sunucu adı').fill('web-1');
    await page.getByRole('button', { name: 'Sunucuyu oluştur' }).click();

    await expect(page).toHaveURL(/\/servers\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('web-1');
    await expect(page.locator('header').getByText(/Hazır · açık/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('10.30.0.20')).toBeVisible();
    await expect(page.getByText('henüz metrik toplanmıyor', { exact: false })).toBeVisible();

    await page.getByRole('button', { name: 'Zorla kapat' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('kaydedilmemiş veriler kaybolabilir');
    await page.getByRole('button', { name: 'Evet, Zorla kapat' }).click();
    await expect(page.locator('header').getByText(/Hazır · kapalı/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Aç', exact: true }).click();
    await expect(page.locator('header').getByText(/Hazır · açık/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('table').last()).toContainText('Oluşturma');

    const del = page.getByRole('button', { name: 'Sunucuyu kalıcı olarak sil' });
    await expect(del).toBeDisabled();
    await page.getByLabel('Onaylamak için “web-1” yazın').fill('web-1');
    await del.click();
    await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
    await expect(page.getByText('Henüz sunucunuz yok.')).toBeVisible();
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
    await page.getByRole('button', { name: 'Türkçe' }).click();
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
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('PostgreSQL veya Redis şu anda erişilemiyor.');
    await page.route('**/api/ready', (r) => r.fulfill({ status: 500, json: { code: 'SOMETHING_NEW' } }));
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('Bilinmeyen bir hata oluştu.');
    await page.route('**/api/ready', (r) => r.abort());
    await page.reload();
    await expect(page.getByRole('status')).toContainText('Sunucuya ulaşılamadı');
  });

  test('pages render without console errors', async ({ browser }) => {
    const page = await (await browser.newContext({ locale: 'en-US' })).newPage();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    for (const path of ['/login', '/register']) await page.goto(path);
    await signIn(page, admin);
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto('/');
    expect(errors).toEqual([]);
  });
});
