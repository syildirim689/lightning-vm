import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
// A list that filters while typing (React Aria ComboBox): typed into, then one option clicked. Its list comes in over
// 150 ms and, unlike a select's, leaves the page behind it free to scroll; React Aria closes such a list, and puts back
// the text that was typed, as soon as the page scrolls. An option clicked while it still moves in is "not stable" for
// Playwright, which tries again, and its third try first scrolls the option to the middle of the window: the page
// scrolled, the list closed, the option was gone ("element was detached from the DOM") and nothing opened it again.
// On a development machine that was 4 of 20 runs. So the option is clicked once the list has arrived and stands still.
async function pick(page: Page, box: Locator, typed: string, option: string | RegExp, exact = false) {
  await box.fill(typed);
  const item = page.getByRole('option', { name: option, exact });
  await expect(item).toBeVisible();
  await expect(page.locator('[data-trigger="ComboBox"][data-entering]')).toHaveCount(0);
  await item.click();
}
// React Aria keeps the real input visually hidden under its styled control.
// Controlled inputs change only after the app (or the API) answers, so click and let expect() wait.
const tick = (box: Locator) => box.click({ force: true });
// A page arrives from the server already drawn and listens to the keyboard only once its scripts have run: a key
// pressed in between is lost. Measured in a new browser, as every test has one (nothing cached): the shortcuts
// listened 260-430 ms after the load event, and "?" pressed after a click on the heading came first 12 times in 200.
// The page says when it listens: it hides the loading layer of the first load itself, and did so 200-290 ms after
// the shortcuts were in place (components/page-loader.tsx). A person does not meet the gap: 400 ms after the page is
// drawn that layer covers it for as long as it does not listen.
const interactive = (page: Page) => expect(page.locator('#boot-loader')).toHaveClass(/page-loader-hidden/);
// The pictures of the tour (test-results/tour/<name>.png), taken once the page stands still: every entrance effect
// and transition that ends by itself has ended (a spinner that turns for ever is not waited for), so nothing is
// caught half faded. A picture of the whole page or of one element is stitched from a page that does not scroll, so
// what stays in place while the page scrolls (the menu beside the page, the bar above it, a section menu) is drawn
// where it starts instead of across the middle of the picture: for those pictures alone it is laid out in the flow.
const inFlow = '[data-shell-nav] { position: relative !important; height: auto !important; overflow: visible !important; }'
  + ' [data-shell-bar], [data-section-menu] { position: relative !important; top: auto !important; }';
async function settled(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity),
    null, { timeout: 3_000 }).catch(() => undefined);
  // Effects driven by script (the charts, the layout animations) have no entry there: two quiet frames after them.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
}
async function tour(target: Page | Locator, name: string, fullPage = false) {
  const element = 'page' in target ? target : null;
  await settled(element ? element.page() : target as Page);
  const path = `test-results/tour/${name}.png`;
  if (element) await element.screenshot({ path, style: inFlow });
  else await (target as Page).screenshot({ path, fullPage, ...(fullPage && { style: inFlow }) });
}
// No sideways scrolling at the page's current width; on failure the message names the innermost elements sticking out.
// Charts redraw at the new width a moment after a resize, so the check waits up to 3 s for the layout to settle.
// Something that must be whole on the screen (a dialog, its buttons, a search field): every one of the elements lies
// between the left and the right edge of the window.
async function expectInside(page: Page, what: Locator, label: string) {
  const width = page.viewportSize()!.width;
  await expect(what.first(), label).toBeVisible();
  await expect.poll(async () => {
    const boxes = await what.evaluateAll((list) => list.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; }));
    return boxes.filter(([left, right]) => left < 0 || right > width).map(([left, right]) => `${left}..${right}`).join(', ');
  }, { message: `${label}: inside 0..${width}`, timeout: 3_000 }).toBe('');
}
// Text that cannot be read in the theme the page is shown in: its colour against what is really behind it (the
// backgrounds from the page down, with their transparency, painted one over the other), by the WCAG contrast ratio.
// Returns the offenders with their ratio. 3:1 is the floor asked of both themes here (what WCAG asks of large text):
// low enough for the muted second lines, far above a dark word on a dark card. Text that is not shown, and the text
// of controls that are switched off, is left out; pictures and gradients behind text are not looked at.
async function unreadable(page: Page, selector: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const dark = document.documentElement.classList.contains('dark');
    const pixel = () => [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    const paint = (colour: string) => { ctx.fillStyle = '#000'; ctx.fillStyle = colour; if (ctx.fillStyle !== '#000000' || /^(rgb\(0, 0, 0\)|#0+|black)$/.test(colour)) ctx.fillRect(0, 0, 1, 1); };
    const luminance = (c: number[]) => { const [r, g, b] = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const out: string[] = [];
    const seen = new Set<Element>();
    for (const root of document.querySelectorAll(sel)) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const el = node.parentElement, text = (node.textContent ?? '').trim();
        if (!el || !text || seen.has(el)) continue;
        seen.add(el);
        const style = getComputedStyle(el), box = el.getBoundingClientRect();
        if (box.width <= 1 || box.height <= 1 || style.visibility === 'hidden' || el.closest('[disabled], [aria-disabled="true"], [data-disabled], [aria-hidden="true"]')) continue;
        const chain: Element[] = [];
        let shown = true;
        for (let e: Element | null = el; e; e = e.parentElement) { chain.unshift(e); if (Number(getComputedStyle(e).opacity) === 0) shown = false; }
        if (!shown) continue;
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = dark ? '#000000' : '#ffffff';
        ctx.fillRect(0, 0, 1, 1);
        for (const e of chain) { const bg = getComputedStyle(e).backgroundColor; if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') paint(bg); }
        const behind = pixel();
        paint(style.color);
        const a = luminance(behind), b = luminance(pixel());
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        if (ratio < 3) out.push(`"${text.slice(0, 40)}" ${ratio.toFixed(2)}:1 (${style.color} on ${behind.join(',')})`);
      }
    }
    return out;
  }, selector);
}
// A page's heading is in the HTML the server sends; its cards, charts and tables come with the API's answers. A width
// measured between the two is the width of the placeholder: /admin/stats was 202 px too wide at 390 px once its heatmap
// was drawn, and the check below saw 0 for as long as it ran before the answer came (it failed only when the answer won).
// watchApi() is called before a page loads anything: every document of that page then counts its own calls to the API
// (fetch, so the live-events stream, which never ends, is not among them). apiQuiet() waits until the page listens
// (its scripts have run and asked for their data), no call is in flight and none has started or ended for 400 ms (one
// answer often starts the next call). A page that is not watched is measured as it is: its test waits for the content
// it means.
type ApiCalls = { open: Map<number, string>; last: number; n: number };
const watched = new WeakSet<Page>();
async function watchApi(page: Page) {
  await page.addInitScript(() => {
    const calls: ApiCalls = { open: new Map(), last: Date.now(), n: 0 };
    (window as unknown as { __apiCalls: ApiCalls }).__apiCalls = calls;
    const real = window.fetch;
    window.fetch = (...args: Parameters<typeof fetch>) => {
      const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]), location.href);
      if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return real(...args);
      const id = ++calls.n;
      calls.open.set(id, url.pathname);
      calls.last = Date.now();
      return real(...args).finally(() => { calls.open.delete(id); calls.last = Date.now(); });
    };
  });
  watched.add(page);
}
async function apiQuiet(page: Page, label: string) {
  if (!watched.has(page)) return;
  await interactive(page);
  // On failure the calls still open are named.
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as unknown as { __apiCalls?: ApiCalls }).__apiCalls;
    return !calls ? 'not counted' : calls.open.size ? [...calls.open.values()].join(', ') : Date.now() - calls.last >= 400 ? 'quiet' : 'a call has just ended';
  }).catch(() => 'the page is being replaced'), { message: `${label}: the page's API calls have ended`, timeout: 15_000, intervals: [100] }).toBe('quiet');
}
async function expectNoOverflow(page: Page, label: string) {
  await apiQuiet(page, label);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { timeout: 3_000 }).toBeLessThanOrEqual(1).catch(() => undefined);
  const [overflow, culprits] = await page.evaluate(() => {
    // Measured from the left edge of the page: a page already scrolled sideways would hide what sticks out.
    window.scrollTo(0, window.scrollY);
    for (const el of document.querySelectorAll('*')) if (el.scrollLeft) el.scrollLeft = 0;
    const w = window.innerWidth;
    // Content inside its own scroll box (a wide table that scrolls sideways) does not widen the page: left out.
    const scrolled = (e: Element) => {
      for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== 'visible' && p.getBoundingClientRect().right <= w + 1) return true;
      }
      return false;
    };
    // The element where the overflow starts: it sticks out, its parent does not.
    const out = [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > w + 1 && !scrolled(e)
      && (e.parentElement?.getBoundingClientRect().right ?? 0) <= w + 1);
    const name = (e: Element) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 60)} "${(e.textContent ?? '').trim().slice(0, 30)}"`;
    // Nothing found that way (the overflow comes from a positioned or transformed element): the ones reaching furthest right.
    const widest = out.length ? [] : [...document.querySelectorAll('body *')].map((e) => [e, e.getBoundingClientRect().right] as const)
      .filter(([, r]) => r > w + 1).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([e, r]) => `${name(e)} right=${Math.round(r)} pos=${getComputedStyle(e).position} parentOverflow=${e.parentElement ? getComputedStyle(e.parentElement).overflowX : ''}`);
    return [document.documentElement.scrollWidth - w, [...out.slice(0, 5).map(name), ...widest].join(' | ')];
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
    const shot = (name: string) => tour(page, `wizard-${name}`, true);

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
    // A generated password: 20 characters of every kind, shown, rated strong; the known one is typed after the screenshot.
    await page.getByRole('button', { name: 'Güçlü parola oluştur' }).click();
    await expect(page.getByRole('textbox', { name: 'Parola' })).toHaveValue(/^.{20}$/);
    await expect(page.getByRole('textbox', { name: 'Parola' })).toHaveAttribute('type', 'text');
    await expect(page.getByText('Parola gücü: Güçlü')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /Parola (panoya kopyalandı|görünür hâlde)/ })).toBeVisible();
    await tour(page, 'setup-password-generated', true);
    await page.setViewportSize({ width: 390, height: 900 });
    await expectNoOverflow(page, 'setup password at 390 px');
    await tour(page, 'setup-password-generated-390', true);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole('textbox', { name: 'Parola' }).fill(admin.password);
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
      // Pinning tests the connection again by itself.
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
    // What waits for staff (the menu's counts) is one small read the admin may make; a count that is zero puts no
    // badge on its menu link.
    const attention = await page.request.get('/api/admin/attention');
    expect(attention.status()).toBe(200);
    const waiting = await attention.json() as { paymentsInReview?: number; failedOperations?: number; abuse?: number };
    expect(waiting.paymentsInReview).toBe(0);
    const menu = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(menu.getByRole('link', { name: 'System' })).toBeVisible();
    for (const [key, text] of [['paymentsInReview', /awaiting review/], ['failedOperations', /failed in the last 24 hours/], ['abuse', /open abuse finding/]] as const)
      if (!waiting[key]) await expect(menu.getByText(text)).toHaveCount(0);
    await expect(page.getByText(/Background worker: Running \(last signal .+\)/)).toBeVisible();
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
    await expect(page.locator('main [role=alert]')).toContainText('does not have permission for this action.');
    const api = await page.request.get('/api/admin/users');
    expect(api.status()).toBe(403);
    // The staff menu's counts are not for customers either.
    expect((await page.request.get('/api/admin/attention')).status()).toBe(403);
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
    await choose(adminPage, dialog, /Cluster or host/, /cluster/i);
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
    await expect(adminPage.getByRole('row', { name: /E2E Small/ })).toContainText('per vCPU');
    await expect(adminPage.getByRole('tab', { name: /Packages\s*[1-9]/ })).toBeVisible();
    await expect(adminPage.getByRole('button', { name: 'Download CSV' })).toBeVisible();

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
    // VMs can be found by name and narrowed by power state.
    await page.getByRole('radio', { name: /^On\s*\d+$/ }).click();
    await expect(page.getByRole('status').filter({ hasText: /^Showing \d+ of \d+ virtual machines$/ })).toBeVisible();
    await page.getByRole('radio', { name: /^All\s*\d+$/ }).click();
    await page.getByRole('searchbox', { name: 'Search name or operating system' }).fill('no-such-vm-zz');
    await expect(page.getByText('No virtual machine matches.').filter({ visible: true })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search name or operating system' }).fill('');
    await page.setViewportSize({ width: 390, height: 900 });
    await expectNoOverflow(page, 'vmware connection at 390 px');
    await tour(page, 'vmware-detail-390', true);
    await page.setViewportSize({ width: 1280, height: 720 });

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
    await tour(page, 'console-snippets-390');
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
    await page.getByRole('alertdialog', { name: 'Delete saved command: Uptime check' }).getByRole('button', { name: 'Delete' }).click();
    await expect(edited).toBeHidden();
    // An administrator can share a command with every user; it is listed apart and they may remove it.
    await page.getByLabel('Command or text', { exact: true }).fill('free -h');
    await tick(page.getByRole('checkbox', { name: /Share with every user/ }));
    await page.getByRole('button', { name: 'Save command' }).click();
    const shared = page.getByRole('list', { name: 'Shared commands' }).getByRole('button', { name: 'Type into the console: free -h (free -h)' });
    await expect(shared).toBeVisible();
    await page.getByRole('button', { name: 'Delete saved command: free -h' }).click();
    // A shared command leaves everyone's list, and the question says so.
    await expect(page.getByRole('alertdialog', { name: 'Delete saved command: free -h' })).toContainText("leaves everyone's list");
    await page.getByRole('alertdialog', { name: 'Delete saved command: free -h' }).getByRole('button', { name: 'Delete' }).click();
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
    // Pinning changed the form: it is tested again by itself, then "Save" is offered.
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

  test('a network scan finds the simulators, knows the connected vCenter and fills in the form for a new ESXi', async ({ page }) => {
    test.skip(!process.env.E2E_VCSIM_HOST, 'needs compose.simulator.yaml and E2E_VCSIM_HOST');
    await signIn(page, admin);
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto('/admin/vmware');
    await page.getByRole('link', { name: 'Find on network' }).click();
    const targets = page.getByLabel('Addresses to scan', { exact: true });
    // Mistakes are caught while typing, item by item.
    await targets.fill('172.29.0.0/16');
    await expect(page.getByText('“172.29.0.0/16”: Block too large', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start scan' })).toBeDisabled();
    await targets.fill(process.env.E2E_SCAN_BLOCK ?? '172.29.250.0/24');
    await expect(page.getByText('254 addresses to scan')).toBeVisible();
    await page.getByLabel('Port', { exact: true }).fill('8989');
    await page.getByRole('button', { name: 'Start scan' }).click();
    await expect(page.getByRole('progressbar', { name: 'Scan progress' }).or(page.getByText(/addresses scanned:/))).toBeVisible();
    await expect(page.getByText(/^254 addresses scanned: [1-9]\d* ESXi \/ vCenter/)).toBeVisible({ timeout: 90_000 });
    // The vCenter that is already a connection is recognised by its instance UUID.
    const vc = page.getByRole('row').filter({ hasText: /vCenter \d/ }).first();
    await expect(vc).toContainText('Connected');
    await expect(vc).toContainText('Simülatör vCenter');
    // An ESXi that is not connected: ignore it, then undo; then add it with the form filled in.
    const esxi = page.getByRole('row').filter({ hasText: /ESXi \d/ }).filter({ hasText: 'New' }).first();
    const address = (await esxi.locator('code').first().textContent())!.trim(); // the address cell is the row header
    await page.getByRole('button', { name: `Ignore ${address}` }).click();
    await expect(page.getByText('Ignored; the automatic scan will not count it as new.')).toBeVisible();
    await page.getByRole('button', { name: /^Ignored\s*1$/ }).click();
    const row = () => page.getByRole('row').filter({ has: page.getByText(address, { exact: true }) });
    await row().getByRole('button', { name: 'Undo' }).click();
    await page.getByRole('button', { name: /^Ignored\s*0$/ }).click();
    await row().getByRole('button', { name: 'Add connection' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Filled in from the scan. The certificate is self-signed', { exact: false })).toBeVisible();
    await expect(dialog.getByLabel('Port')).toHaveValue('8989');
    await expect(dialog.getByLabel('Service account')).toHaveValue('root');
    await dialog.getByLabel('Display name').fill('Scanned ESXi');
    await dialog.getByLabel('Service account').fill('sim-root');
    await dialog.getByLabel('Password').fill('sim-password-2');
    await dialog.getByRole('button', { name: 'Test connection' }).click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('row', { name: /Scanned ESXi/ })).toBeVisible();
    // The automatic scan: weekly over the blocks above, then off again.
    await page.getByText('Automatic scan', { exact: true }).click();
    await page.getByRole('button', { name: 'Use the blocks above' }).click();
    await choose(page, page, /How often/, 'Weekly');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Automatic scan saved.')).toBeVisible();
    await expect(page.getByText(/Weekly, next/)).toBeVisible();
    await page.setViewportSize({ width: 390, height: 900 });
    await expectNoOverflow(page, 'vmware discovery at 390 px');
    await tour(page.locator('#discovery'), 'vmware-discovery-390');
    await page.setViewportSize({ width: 1280, height: 900 });
    await tour(page.locator('#discovery'), 'vmware-discovery');
    await choose(page, page, /How often/, 'Off');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Automatic scan saved.').first()).toBeVisible();
    // Leave the panel as it was: the scanned ESXi goes again.
    await page.getByRole('row', { name: /Scanned ESXi/ }).getByRole('link', { name: 'Details' }).click();
    await page.getByLabel('Type “Scanned ESXi” to confirm').fill('Scanned ESXi');
    await page.getByRole('button', { name: 'Remove connection' }).click();
    await expect(page.getByText('Connection removed.')).toBeVisible();
  });
});

test.describe('server lifecycle (simulator, Turkish customer)', () => {
  test.use({ locale: 'tr-TR' });
  test('a customer creates a server, sees it become ready, powers it off with confirmation and deletes it', async ({ page }) => {
    test.setTimeout(240_000);
    test.skip(!process.env.E2E_VCSIM_HOST, 'needs compose.simulator.yaml and E2E_VCSIM_HOST');
    // A page opened while signed out asks for sign-in first, then opens itself.
    await page.goto('/account?tab=keys');
    await expect(page).toHaveURL(/\/login\?next=%2Faccount%3Ftab%3Dkeys$/);
    await page.getByLabel('E-posta').fill(user.email);
    await page.getByLabel('Parola').fill(user.password);
    await page.getByRole('button', { name: 'Giriş yap', exact: true }).click();
    await expect(page).toHaveURL(/\/account\?tab=keys$/);
    await page.getByLabel('Anahtar adı').fill('dizüstü');
    await page.getByLabel('Açık anahtar').fill('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMa0iBTtZu9kbSNXzg5M6pZ1rn8F1143iWq3JIcGimfn e2e');
    await page.getByRole('button', { name: 'Anahtar ekle' }).click();
    await expect(page.getByText('SHA256:', { exact: false })).toBeVisible();

    // A shared configuration link: what the catalog offers is taken (the package), what it does not is ignored (an
    // unknown image, a size out of range, a name), and the address is cleaned afterwards.
    const offered = await (await page.request.get('/api/catalog')).json() as { packages: { id: string; name: string }[] };
    const tiny = offered.packages.find((p) => p.name.includes('E2E Tiny'));
    expect(tiny).toBeTruthy();
    await page.goto(`/order?pkg=${tiny!.id}&image=no-such-image&cpu=9999&name=not-taken`);
    await expect(page).toHaveURL(/\/order$/);
    await expect(page.getByRole('radio', { name: /E2E Tiny/ })).toBeChecked();
    await expect(page.getByLabel('Sunucu adı')).not.toHaveValue('not-taken');
    await expect(page.getByRole('button', { name: 'Bu yapılandırmanın bağlantısını kopyala' })).toBeVisible();

    await page.goto('/order');
    await choose(page, page, /İşletim sistemi/, /Sim Linux/);
    await tick(page.getByRole('radio', { name: /E2E Tiny/ }));
    await expect(page.locator('.quote')).toContainText('Aylık: €3,00', { timeout: 15_000 });
    await expect(page.locator('.quote')).toContainText('Yıllık yaklaşık €36,00');
    await expect(page.getByText(/vCPU başına €3,00/).first()).toBeVisible();
    // The summary lists what is still missing, each a jump to its section; the button waits for them.
    // The only SSH key is ticked by itself; without it the order waits.
    const onlyKey = page.getByRole('checkbox', { name: 'dizüstü' });
    await expect(onlyKey).toBeChecked();
    await tick(onlyKey);
    const missing = page.getByRole('list', { name: 'Sipariş için eksik' });
    await expect(missing).toContainText('En az bir SSH anahtarı seçin');
    await expect(page.getByRole('button', { name: 'Sunucuyu oluştur' })).toBeDisabled();
    await page.getByLabel('Sunucu adı').fill('Web_1');
    await expect(page.getByText('Küçük harf, rakam ve tire kullanın', { exact: false })).toBeVisible();
    await tick(onlyKey);
    await page.getByLabel('Sunucu adı').fill('web-1');
    await expect(missing).toBeHidden();
    await page.locator('#order-summary').scrollIntoViewIfNeeded();
    await tour(page, 'order-summary', true);
    await page.getByRole('button', { name: 'Sunucuyu oluştur' }).click();

    await expect(page).toHaveURL(/\/servers\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('web-1');
    // The task manager (bottom right) shows the background work while it runs.
    await expect(page.getByRole('button', { name: /iş sürüyor|Son işler/ })).toBeVisible();
    await expect(page.getByText(/Hazır · açık/).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('10.30.0.20').first()).toBeVisible(); // overview and the IP addresses section
    // Live metrics from the simulator's performance manager (20-second samples).
    await expect(page.getByRole('heading', { name: 'Canlı performans' })).toBeVisible();
    await expect(page.getByText(/\d+ örnek, 20 saniye aralıkla/)).toBeVisible({ timeout: 30_000 });
    // Every VMware detail of the VM (cards with MAC and port, disks, tools); a customer gets no infrastructure names.
    const vmd = page.locator('[data-section="Sanal makine ayrıntıları"]');
    await expect(vmd.getByText(/Ağ kartları \(\d+\)/)).toBeVisible({ timeout: 30_000 });
    await expect(vmd.getByText('MAC', { exact: true }).first()).toBeVisible();
    await expect(vmd.getByText(/Diskler \(\d+\)/)).toBeVisible();
    await expect(vmd.getByText('Çalıştığı yer')).toHaveCount(0);
    await expect(vmd.getByText('Veri deposu')).toHaveCount(0);
    // The connection check: power, network cards and the firewall, each with its own line.
    const check = page.getByRole('list', { name: 'Bağlantı denetimi' });
    await expect(check).toContainText('Sunucu açık.');
    await expect(check).toContainText(/ağ kartı|Ağ kartı/);
    await expect(check).toContainText('Firewall yok: tüm portlar açık.');
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
    // Ctrl+Enter in a long text sends its form, as the field says.
    await expect(page.getByText('Ctrl+Enter ile gönderilir')).toBeVisible();
    await page.getByLabel('Notlar').press('Control+Enter');
    await expect(page.getByText('Etiketler ve notlar kaydedildi.')).toBeVisible();
    // Power schedule: "office hours" adds a weekday start and shutdown in one click.
    await page.getByRole('button', { name: 'Mesai saatleri' }).click();
    await expect(page.getByText('08:00', { exact: true })).toBeVisible();
    await expect(page.getByText('19:00', { exact: true })).toBeVisible();
    // The week view shows both; pressing the preset again adds no copies; deleting asks first.
    await expect(page.getByRole('list', { name: 'Haftalık görünüm' })).toBeVisible();
    await page.getByRole('button', { name: 'Mesai saatleri' }).click();
    await expect(page.getByText('Bu zamanlamalar zaten var.')).toBeVisible();
    await page.getByRole('button', { name: /19:00 Kapat zamanlamasını kaldır/ }).click();
    await page.getByRole('alertdialog', { name: /19:00 Kapat zamanlamasını kaldır/ }).getByRole('button', { name: 'Sil' }).click();
    await expect(page.getByText('19:00', { exact: true })).toBeHidden();
    // Automatic snapshots: "nightly snapshot" adds a daily 02:00 one that keeps the newest three.
    await page.getByRole('button', { name: 'Gece anlık görüntüsü' }).click();
    await expect(page.getByText('02:00', { exact: true })).toBeVisible();
    await expect(page.getByText(/3 tane saklar/)).toBeVisible();
    // The next scheduled action and when it comes.
    await expect(page.getByText(/^Sıradaki: /)).toBeVisible();
    // The tab is named after the server.
    await expect(page).toHaveTitle(/(^|\) )web-1 · /);
    // The overview copies a plain summary of the server.
    await page.getByRole('button', { name: 'Özeti kopyala' }).click();
    await expect(page.getByText('Sunucu özeti panoya kopyalandı.')).toBeVisible();
    // An address in the IP list copies in one tap and says so.
    await page.getByRole('button', { name: 'Kopyala: 10.30.0.20', exact: true }).click();
    await expect(page.getByText('10.30.0.20 kopyalandı.')).toBeVisible();
    // Reinstall: once an image is chosen, the summary says what is kept and what is erased, before the name is typed.
    const reinstall = page.locator('[data-section="Yeniden kur"]');
    await choose(page, reinstall, /İmaj/, /Sim Linux/);
    await expect(reinstall.getByText('Kalır', { exact: true })).toBeVisible();
    await expect(reinstall).toContainText('IP adresleri (10.30.0.20)');
    await expect(reinstall.getByText('Silinir', { exact: true })).toBeVisible();
    await expect(reinstall).toContainText('Diskteki tüm veriler ve anlık görüntüler');
    await expect(reinstall.getByRole('button', { name: 'Yeniden kur', exact: true })).toBeDisabled();
    // Snapshot: taken as an operation, then listed as the current state.
    // A ready name fills the field and is marked as chosen.
    await page.getByRole('button', { name: 'Güncelleme öncesi', exact: true }).click();
    await expect(page.getByLabel('Ad', { exact: true })).toHaveValue('Güncelleme öncesi');
    await page.getByLabel('Ad', { exact: true }).fill('guncelleme-oncesi');
    await page.getByRole('button', { name: 'Anlık görüntü al', exact: true }).click();
    // The page, not the toast that the live notification shows at the same moment.
    await expect(page.locator('main').getByText('guncelleme-oncesi')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText('Şu anki durum buna dayanıyor')).toBeVisible();
    await tour(page, 'server-page', true);
    await page.setViewportSize({ width: 390, height: 900 });
    await expectNoOverflow(page, 'server page with schedules at 390 px');
    await tour(page, 'server-page-390', true);
    await page.setViewportSize({ width: 1280, height: 720 });
    // Section bar: a chip jumps to its section, marks it and offers a way back to the top.
    const sections = page.getByRole('navigation', { name: 'Bölümler' });
    await expect(sections.getByRole('link')).not.toHaveCount(0);
    expect(await sections.getByRole('link').count()).toBeGreaterThanOrEqual(4);
    await sections.getByRole('link', { name: 'İşlem geçmişi' }).click();
    await expect(sections.getByRole('link', { name: 'İşlem geçmişi' })).toHaveAttribute('aria-current', 'location');
    await expect(page.getByRole('grid', { name: 'İşlem geçmişi' })).toBeInViewport();
    await expect(sections).toBeInViewport();
    await expect(sections.getByRole('button', { name: 'Başa dön' })).toBeVisible();
    // Once the header scrolled away, the bar names the server and shows its state.
    await expect(sections.locator('[data-lead]')).toBeVisible();
    await expect(sections.locator('[data-lead]')).toContainText('web-1');
    await page.waitForTimeout(400);
    await tour(page, 'server-sections');
    await page.setViewportSize({ width: 390, height: 900 });
    await expectNoOverflow(page, 'server section bar at 390 px');
    await tour(page, 'server-sections-390');
    await page.setViewportSize({ width: 768, height: 1024 });
    await expectNoOverflow(page, 'server section bar at 768 px');
    await tour(page, 'server-sections-768');
    await sections.getByRole('button', { name: 'Başa dön' }).click();
    await expect.poll(() => page.evaluate(() => scrollY)).toBeLessThan(5);
    await expect(sections.locator('[data-lead]').locator('..')).toHaveAttribute('aria-hidden', 'true');
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
    await interactive(page);
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
    // The card's quick menu copies the SSH command without opening the server.
    await page.getByRole('button', { name: 'web-1 için hızlı işlemler' }).click();
    await page.getByRole('menuitem', { name: 'SSH komutunu kopyala' }).click();
    await expect(page.getByText('SSH komutu panoya kopyalandı.')).toBeVisible();
    await tour(page, 'servers-quick-390');
    await expect(page).toHaveURL(/\/\?q=/);
    await tour(page, 'servers-note-search-390');
    await page.setViewportSize({ width: 1280, height: 720 });
    // The same menu offers a new name, the delete lock and deleting. Renamed from the list, the card shows the new
    // name (and back again, for the rest of this tour); locked and unlocked without opening the server.
    const cards = page.getByRole('list', { name: 'Sunucularınız' });
    await page.getByRole('button', { name: 'web-1 için hızlı işlemler' }).click();
    await expect(page.getByRole('menuitem', { name: 'Kilitle (silmeye karşı koru)' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Sil…' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Yeniden adlandır' }).click();
    const renameServer = page.getByRole('dialog').filter({ hasText: 'web-1 adını değiştir' });
    await renameServer.getByRole('textbox', { name: 'Yeni ad' }).fill('web-1-yeni');
    await renameServer.getByRole('button', { name: 'Kaydet' }).click();
    await expect(page.getByText('Sunucu yeniden adlandırıldı').first()).toBeVisible();
    await expect(renameServer).toBeHidden();
    await expect(cards.getByRole('link', { name: /^web-1-yeni/ })).toBeVisible();
    await page.getByRole('button', { name: 'web-1-yeni için hızlı işlemler' }).click();
    await page.getByRole('menuitem', { name: 'Yeniden adlandır' }).click();
    const renameBack = page.getByRole('dialog').filter({ hasText: 'web-1-yeni adını değiştir' });
    await renameBack.getByRole('textbox', { name: 'Yeni ad' }).fill('web-1');
    await renameBack.getByRole('button', { name: 'Kaydet' }).click();
    await expect(renameBack).toBeHidden();
    await expect(cards.getByRole('link', { name: /^web-1-yeni/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'web-1 için hızlı işlemler' }).click();
    await page.getByRole('menuitem', { name: 'Kilitle (silmeye karşı koru)' }).click();
    await expect(page.getByText('Sunucu kilitlendi.')).toBeVisible();
    await page.getByRole('button', { name: 'web-1 için hızlı işlemler' }).click();
    await page.getByRole('menuitem', { name: 'Kilidi aç' }).click();
    await expect(page.getByText('Kilit açıldı.')).toBeVisible();
    await choose(page, page, /Sırala/, 'En büyük önce');
    await expect(page).toHaveURL(/sort=size/);
    // State order puts problems and busy servers before the running ones.
    await choose(page, page, /Sırala/, 'Duruma göre (önce sorunlar)');
    await expect(page).toHaveURL(/sort=state/);
    await choose(page, page, /Sırala/, 'Önce en pahalı');
    await expect(page).toHaveURL(/sort=price/);
    await page.goto('/?q=yok-boyle');
    await expect(page.getByText('Bu süzgeçlere uyan sunucu yok.')).toBeVisible();
    // Nothing matches: one tap clears the filters and the list comes back.
    await page.getByRole('status').getByRole('button', { name: 'Süzgeçleri temizle' }).click();
    await expect(page).not.toHaveURL(/q=/);
    await expect(page.getByRole('list', { name: 'Sunucularınız' }).getByRole('link', { name: /^web-1/ })).toBeVisible();
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

    // A failed operation, and the one next step the page offers after it (lib/next-step.ts). The failure is a real
    // one: going back to a snapshot that is no longer there, asked of the API as a page left open would ask it. The
    // worker fails it for good (SNAPSHOT_NOT_FOUND), which no second try would fix: the page sends to support, with
    // a ticket that already says what happened.
    {
      const main = page.locator('main');
      const history = page.getByRole('grid', { name: 'İşlem geçmişi' });
      const id = page.url().split('/').pop()!;
      type Op = { id: string; kind: string; status: string; errorCode: string | null };
      const operations = async () => ((await (await page.request.get(`/api/servers/${id}`)).json()) as { operations: Op[] }).operations;
      const asked = await page.request.post(`/api/servers/${id}/snapshots/snapshot-999999/revert`, { headers: { 'x-lightning-csrf': '1', 'idempotency-key': `e2e-revert-${Date.now()}` } });
      expect(asked.status(), await asked.text()).toBe(202);
      await expect.poll(async () => (await operations())[0]?.status, { timeout: 45_000 }).toBe('failed');
      const failed = (await operations())[0]!;
      expect([failed.kind, failed.errorCode]).toEqual(['snapshot_revert', 'SNAPSHOT_NOT_FOUND']);
      await page.reload();
      await expect(main.getByText('Anlık görüntüye dönme başarısız oldu', { exact: true })).toBeVisible();
      // The customer reads the sentence; the code support will ask for is on it (shown on hover), not in the text.
      await expect(main.getByText(/^Bu anlık görüntü artık yok\. · /)).toBeVisible();
      await expect(main.getByText('Bu anlık görüntü artık yok.', { exact: true }).first()).toHaveAttribute('title', 'SNAPSHOT_NOT_FOUND');
      await expect(main.getByText('SNAPSHOT_NOT_FOUND')).toHaveCount(0);
      await expect(main.getByText('Yeniden denemek bunu kendiliğinden düzeltmez. Destek ekibine yazın; ayrıntılar sizin için dolduruldu.', { exact: true })).toBeVisible();
      await expect(main.getByRole('button', { name: 'Yeniden dene' })).toHaveCount(0);
      const toSupport = main.getByRole('link', { name: 'Destek ekibine yaz', exact: true });
      const ticketLink = new URL((await toSupport.getAttribute('href'))!, page.url());
      expect(ticketLink.pathname).toBe('/support');
      expect(ticketLink.searchParams.get('new')).toBe('1');
      expect(ticketLink.searchParams.get('server')).toBe(id);
      expect(ticketLink.searchParams.get('subject')).toBe('web-1: Anlık görüntüye dönme başarısız oldu');
      expect(ticketLink.searchParams.get('body')).toContain('Hata: Bu anlık görüntü artık yok. (SNAPSHOT_NOT_FOUND)');
      expect(ticketLink.searchParams.get('body')).toContain(`İşlem: ${failed.id}`);
      // The row of the history carries the same way out.
      const failedRow = history.getByRole('row').filter({ has: page.locator('[data-code="SNAPSHOT_NOT_FOUND"]') });
      await expect(failedRow).toContainText('Bu anlık görüntü artık yok.');
      await expect(failedRow).toContainText('Başarısız');
      expect(await failedRow.getByRole('link', { name: 'Bunu destekle paylaş' }).getAttribute('href')).toBe(await toSupport.getAttribute('href'));
      await page.waitForTimeout(300);
      await tour(page, 'server-failed-support', true);
      await page.setViewportSize({ width: 390, height: 900 });
      await expectNoOverflow(page, 'server page with a failed operation at 390 px');
      await page.setViewportSize({ width: 1280, height: 720 });

      // The other two answers depend on the error code alone. The simulator cannot be made to time out or to refuse
      // for an unpaid invoice, so for these the page is handed the same failed operation with another kind and code
      // (only that operation, in the page's own read of the server; everything else is the API's answer). What the
      // button then does is real again.
      let shown: { kind: string; errorCode: string } | null = { kind: 'power_on', errorCode: 'BILLING_HOLD' };
      await page.route(`**/api/servers/${id}`, async (route) => {
        if (route.request().method() !== 'GET' || !shown) return route.continue();
        // A read that was on its way when the page reloaded has nobody left to answer: not an error of the test.
        try {
          const answer = await route.fetch();
          const body = await answer.json() as { operations: Op[] };
          await route.fulfill({ response: answer, json: { ...body, operations: body.operations.map((o) => (o.id === failed.id ? { ...o, ...shown } : o)) } });
        } catch { /* the page moved on */ }
      });
      // Money stands in the way: the invoices, not a ticket and not a retry.
      await page.reload();
      await expect(main.getByText('Açma başarısız oldu', { exact: true })).toBeVisible();
      await expect(main.getByText(/^Sunucu, ödenmeyen fatura ödenene kadar askıda\. · /)).toBeVisible();
      await expect(main.getByText('BILLING_HOLD')).toHaveCount(0);
      await expect(main.getByText('İşlemin önünde bir ödeme var. Açık faturayı ödeyin ya da bakiye yükleyin, sonra işlemi yeniden başlatın.', { exact: true })).toBeVisible();
      await expect(main.getByRole('link', { name: 'Faturalara git' }).first()).toHaveAttribute('href', '/billing?show=open');
      await expect(history.getByRole('row').filter({ has: page.locator('[data-code="BILLING_HOLD"]') }).getByRole('link', { name: 'Faturalara git' })).toHaveAttribute('href', '/billing?show=open');
      await expect(main.getByRole('link', { name: 'Destek ekibine yaz', exact: true })).toHaveCount(0);
      await expect(main.getByRole('button', { name: 'Yeniden dene' })).toHaveCount(0);
      // Usually temporary (a timeout) on an action that loses nothing when repeated: "try again" is the page's own
      // button for that action. A reset asks first, as it always does, and then really resets the server; with the
      // newest operation a success, the notice is gone.
      shown = { kind: 'reset', errorCode: 'TIMEOUT' };
      await page.reload();
      await expect(main.getByText('Reset başarısız oldu', { exact: true })).toBeVisible();
      await expect(main.getByText('Bu çoğunlukla geçici bir durumdur. Şimdi yeniden deneyebilirsiniz.', { exact: true })).toBeVisible();
      await expect(main.getByRole('link', { name: 'Destek ekibine yaz', exact: true })).toHaveCount(0);
      await page.waitForTimeout(300);
      await tour(page, 'server-failed-retry', true);
      await main.getByRole('button', { name: 'Yeniden dene', exact: true }).click();
      const sure = page.getByRole('alertdialog', { name: 'Reset' });
      await expect(sure).toContainText('kaydedilmemiş veriler kaybolabilir');
      const [sent] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/servers/${id}/actions`),
        sure.getByRole('button', { name: 'Evet, Reset' }).click(),
      ]);
      expect(sent.status()).toBe(202);
      expect(sent.request().postDataJSON()).toEqual({ action: 'reset' });
      await expect.poll(async () => { const [last] = await operations(); return [last?.kind, last?.status]; }, { timeout: 45_000 }).toEqual(['reset', 'succeeded']);
      await expect(main.getByText('Reset başarısız oldu', { exact: true })).toHaveCount(0, { timeout: 20_000 });
      shown = null;
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.reload();
      await expect(page.getByText(/Hazır · açık/).first()).toBeVisible({ timeout: 30_000 });
      await expect(main.getByText(/başarısız oldu$/)).toHaveCount(0);
      // The failed operation stays in the history, with its way to support.
      await expect(history.getByRole('row').filter({ has: page.locator('[data-code="SNAPSHOT_NOT_FOUND"]') }).getByRole('link', { name: 'Bunu destekle paylaş' })).toBeVisible();
    }

    // Deleting a ready server first moves it to the grace period (24 hours by default).
    await expect(page.getByText('24 saat bekler', { exact: false })).toBeVisible();
    const del = page.getByRole('button', { name: 'Sunucuyu sil', exact: true });
    await expect(del).toBeDisabled();
    await page.getByLabel('Onaylamak için “web-1” yazın').fill('web-1');
    // Locked: deleting stays off until the lock is removed.
    await page.getByRole('button', { name: 'Kilitle' }).click();
    // The lock shows at the top and, with its unlock, right in the delete section.
    const deleteSection = page.locator('#section-sunucuyu-sil');
    await expect(page.getByText('Silme koruması açık')).toHaveCount(2);
    await expect(del).toBeDisabled();
    await tour(page, 'server-locked', true);
    await deleteSection.getByRole('button', { name: 'Kilidi aç' }).click();
    await expect(page.getByText('Silme koruması kapalı')).toBeVisible();
    await expect(del).toBeEnabled();
    await del.click();
    await expect(page.getByText('Bu sunucu silinmek üzere')).toBeVisible();
    await expect(page.getByText(/kalıcı olarak silinecek/)).toBeVisible();
    await tour(page, 'server-trash', true);
    await page.setViewportSize({ width: 390, height: 900 });
    await expectNoOverflow(page, 'server waiting for deletion at 390 px');
    await tour(page, 'server-trash-390', true);
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
    await tour(page, 'insights-hidden-390', true);
    await page.setViewportSize({ width: 1280, height: 720 });
    await showHidden.click();
    await expect(finding).toBeVisible();
    await page.waitForTimeout(800); // layout animation of the returning cards
    await tour(page, 'insights-pending-deletion', true);
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
    const serverList = page.getByRole('list', { name: 'Sunucularınız' });
    await expect(serverList.getByRole('link', { name: /^web-2/ })).toBeVisible();
    // The greeting says what most needs a look and offers the servers opened last.
    const welcome = page.getByRole('region', { name: 'Karşılama' });
    await expect(welcome.getByText(/^(Günaydın|İyi günler|İyi akşamlar|İyi geceler)/)).toBeVisible();
    await expect(welcome.getByText(/sunucunuz|sunucunuzda|Sunucunuz/)).toBeVisible();
    await expect(welcome.getByRole('navigation', { name: 'Son açtıklarınız' }).getByRole('link', { name: 'web-2' })).toBeVisible();
    // What the shown servers add up to.
    // Each card says what the server costs.
    await expect(serverList.getByText(/\/(ay|saat)$/).first()).toBeVisible();
    const totals = page.getByRole('status', { name: 'Gösterilen sunucuların toplamı' });
    await expect(totals).toContainText('2 sunucu');
    await expect(totals).toContainText('vCPU');
    // Compact rows for long lists, remembered after a reload; the card view comes back with one tap.
    await page.getByRole('button', { name: 'Liste', exact: true }).click();
    await expect(page.locator('[data-row]')).toHaveCount(2);
    await page.reload();
    await expect(page.locator('[data-row]')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Liste', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#boot-loader')).toHaveCSS('opacity', '0');
    await tour(page, 'servers-rows', true);
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoOverflow(page, `server rows at ${width} px`);
      await tour(page, `servers-rows-${width}`, true);
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole('button', { name: 'Kart', exact: true }).click();
    await expect(page.locator('[data-row]')).toHaveCount(0);
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
      // At the end of the page the bar stands under the list and its totals, not on them.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect.poll(async () => {
        const totals = (await page.getByRole('status', { name: 'Gösterilen sunucuların toplamı' }).boundingBox())!;
        const bar = (await page.getByRole('region', { name: 'Seçili sunucular için işlemler' }).boundingBox())!;
        return Math.round(totals.y + totals.height - bar.y);
      }, { message: `totals row clear of the selection bar at the end of the page at ${width} px`, timeout: 3_000 }).toBeLessThanOrEqual(0);
      await tour(page, `servers-select-${width}`);
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await tour(page, 'servers-select', true);
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
    await tour(page, 'servers-bulk-tags-390');
    await page.setViewportSize({ width: 1280, height: 720 });
    await tags.getByRole('button', { name: 'e2e etiketini hepsinden kaldır' }).click();
    await expect(tags.getByRole('button', { name: 'e2e etiketini hepsinden kaldır' })).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(tags).toBeHidden();
    await expect(bar).toContainText('2 sunucu seçili');
    await page.getByRole('region', { name: 'Seçili sunucular için işlemler' }).getByRole('button', { name: 'Aç', exact: true }).click();
    await expect(page.getByText(/sunucuda işlem başladı/)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Seçili sunucular için işlemler' })).toBeHidden();

    // A firewall on web-1: its card gets the shield pill (applying, then applied); web-2's card has none.
    await page.goto('/firewalls');
    await page.getByRole('button', { name: 'Firewall oluştur' }).first().click();
    const fwDialog = page.getByRole('dialog');
    await fwDialog.getByLabel('Ad').fill('e2e-web');
    await tick(fwDialog.getByRole('checkbox', { name: 'web-1' }));
    await fwDialog.getByRole('button', { name: 'Firewall oluştur' }).click();
    await expect(page).toHaveURL(/\/firewalls\/[0-9a-f-]{36}$/);
    await page.goto('/');
    const web1Card = page.getByRole('list', { name: 'Sunucularınız' }).getByRole('link', { name: /^web-1/ });
    await expect(web1Card.getByText(/^Firewall( uygulanıyor)?$/)).toBeVisible();
    await expect(web1Card.getByText('Firewall', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('link', { name: /^web-2/ }).getByText(/^Firewall/)).toHaveCount(0);
    await expect(page.locator('#boot-loader')).toHaveCSS('opacity', '0');
    await tour(page, 'servers-firewall-pill');
    await page.setViewportSize({ width: 390, height: 900 });
    await web1Card.scrollIntoViewIfNeeded();
    await expectNoOverflow(page, 'firewall pill at 390 px');
    await tour(page, 'servers-firewall-pill-390');
    await page.setViewportSize({ width: 1280, height: 720 });

    // Ctrl+K copies a server's SSH command without opening its page.
    await page.keyboard.press('Control+k');
    await page.keyboard.type('web-1: ssh');
    const sshOption = page.getByRole('option', { name: /web-1: SSH komutunu kopyala/ });
    await expect(sshOption).toContainText('ssh root@');
    await page.setViewportSize({ width: 390, height: 900 });
    // On a phone the palette is as wide as the screen and no wider: its search field and its rows are whole.
    const palette = page.getByRole('dialog', { name: 'Komut paleti' });
    await expectInside(page, palette, 'command palette at 390 px');
    await expectInside(page, palette.locator('input, [role="option"]'), 'the search field and rows of the command palette at 390 px');
    await expectNoOverflow(page, 'command palette at 390 px');
    await tour(page, 'palette-ssh-390');
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
    await expectInside(page, palette, 'command palette (a tag) at 390 px');
    await expectInside(page, palette.locator('input, [role="option"]'), 'the search field and rows of the command palette (a tag) at 390 px');
    await tour(page, 'palette-tag-390');
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
    await tour(page, 'servers-tag-rename-390');
    await page.setViewportSize({ width: 1280, height: 720 });
    await rename.getByRole('button', { name: 'Kaydet' }).click();
    await expect(page.getByText('2 sunucuda etiket yeniden adlandırıldı.')).toBeVisible();
    await expect(page).toHaveURL(/tag=prod/);
    await expect(page.getByRole('group', { name: 'Etiket' }).getByRole('button', { name: 'prod 2' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Etiketi kaldır' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Etiketi kaldır' }).click();
    await expect(page.getByText('Etiket 2 sunucudan kaldırıldı.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Etiketi kaldır' })).toBeHidden();

    // A ticket about web-1, opened by the customer: the panel keeps what it knew about the server at that moment,
    // for staff alone.
    const csrf = { 'x-lightning-csrf': '1' };
    const web1Id = serverUrl.split('/').pop()!;
    const departments = await (await page.request.get('/api/support/departments')).json() as { departments: { id: string }[] };
    const opened = await page.request.post('/api/support/tickets', { headers: csrf, data: { subject: 'web-1 yanıt vermiyor', departmentId: departments.departments[0].id, priority: 'normal',
      serverId: web1Id, body: 'Sabahtan beri ping yanıtı yok.', attachments: [] } });
    expect(opened.status()).toBe(201);
    const ticket = await opened.json() as { id: string; number: number | string };
    const diagTitle = 'Sunucunun talep açıldığındaki durumu';

    // The admin's bulk delete on the same two servers: asked first, with what happens to them (cancelled here).
    const staff = await (await page.context().browser()!.newContext({ locale: 'tr-TR' })).newPage();
    await signIn(staff, admin);
    await expect(staff).toHaveURL(/\/admin$/);
    // Staff open the ticket: the server's snapshot sits above the thread, closed; opened, it names the server, its
    // state at that moment, its address and its last operations, and leads to the server.
    await staff.goto(`/admin/support/${ticket.id}`);
    await expect(staff.locator('main').getByText('Sabahtan beri ping yanıtı yok.')).toBeVisible();
    const diag = staff.locator('details').filter({ hasText: diagTitle });
    await expect(diag).toHaveJSProperty('open', false);
    await expect(diag.locator('summary')).toContainText('web-1');
    await expect(diag.getByText('IP adresleri', { exact: true })).toBeHidden();
    await diag.locator('summary').click();
    await expect(diag).toHaveJSProperty('open', true);
    await expect(diag.getByText('Hazır · açık').first()).toBeVisible();
    await expect(diag.getByText('IP adresleri', { exact: true })).toBeVisible();
    await expect(diag.getByText('10.30.0.20', { exact: true })).toBeVisible();
    await expect(diag.getByText('Son işlemler', { exact: true })).toBeVisible();
    await expect(diag.getByRole('link', { name: /web-1 sunucusunu aç/ })).toHaveAttribute('href', `/servers/${web1Id}`);
    await tour(staff, 'support-diagnostics', true);
    await staff.setViewportSize({ width: 390, height: 900 });
    await expectNoOverflow(staff, 'ticket diagnostics at 390 px');
    await tour(staff, 'support-diagnostics-390', true);
    await staff.setViewportSize({ width: 1280, height: 720 });
    const staffTicket = await (await staff.request.get(`/api/support/tickets/${ticket.id}`)).json() as { staff: boolean; diagnostics?: { server?: { name?: string; addresses?: string[] } } | null };
    expect(staffTicket.staff).toBe(true);
    expect(staffTicket.diagnostics?.server?.name).toBe('web-1');
    expect(staffTicket.diagnostics?.server?.addresses).toContain('10.30.0.20');
    // Two answers in a row: two notifications about the same ticket for the customer (read from their inbox below).
    for (const body of ['Güvenlik duvarını denetliyoruz.', 'Kural düzeltildi, yeniden dener misiniz?'])
      expect((await staff.request.post(`/api/support/tickets/${ticket.id}/messages`, { headers: csrf, data: { body, attachments: [] } })).status()).toBe(201);
    await staff.goto('/admin/servers');
    // The menu's Servers entry counts what failed in the last 24 hours (the snapshot that was gone, above): the
    // figure for the eye, the sentence for a screen reader.
    {
      const failedCount = ((await (await staff.request.get('/api/admin/attention')).json()) as { failedOperations?: number }).failedOperations ?? 0;
      expect(failedCount).toBeGreaterThanOrEqual(1);
      const entry = staff.getByRole('navigation', { name: 'Ana menü' }).locator('a[href="/admin/servers"]');
      await expect(entry).toHaveAccessibleName(new RegExp(`^Sunucular\\s*,\\s*Son 24 saatte ${failedCount} işlem başarısız oldu$`));
      await expect(entry.locator('[aria-hidden=true]').filter({ hasText: /^\d+\+?$/ })).toHaveText(String(failedCount));
    }
    // The table copies an IP in one tap, and the owner's e-mail opens that customer in the user list.
    await staff.getByRole('button', { name: 'Kopyala: web-1 IP' }).click();
    await expect(staff.getByText('web-1 IP kopyalandı.')).toBeVisible();
    // Staff open the customer's server and see the infrastructure the customer does not: where it runs, datastores, switch.
    await staff.getByRole('link', { name: 'web-1', exact: true }).first().click();
    await expect(staff).toHaveURL(/\/servers\/[0-9a-f-]{36}$/);
    const staffVmd = staff.locator('[data-section="Sanal makine ayrıntıları"]');
    await expect(staffVmd.getByText('Çalıştığı yer')).toBeVisible({ timeout: 30_000 });
    await expect(staffVmd.getByText('Veri deposu', { exact: true }).first()).toBeVisible();
    await expect(staffVmd.getByText('Yapılandırma dosyası')).toBeVisible();
    await expect(staffVmd.getByText(/\.vmx/).first()).toBeVisible();
    await staff.goto('/admin/servers');
    // The owner's e-mail opens that customer in the user list, and their server count leads back, filtered to them.
    await staff.getByRole('link', { name: user.email }).first().click();
    await expect(staff).toHaveURL(/\/admin\/users\?q=/);
    await staff.setViewportSize({ width: 390, height: 900 });
    await expectNoOverflow(staff, 'user list filtered to the owner at 390 px');
    await staff.getByRole('link', { name: `${user.email} kişisinin 2 sunucusunu göster` }).scrollIntoViewIfNeeded();
    await tour(staff, 'admin-user-servers-390');
    await staff.setViewportSize({ width: 1280, height: 720 });
    // Their summary links to the same filtered server list.
    await staff.getByRole('button', { name: new RegExp(user.email) }).first().click();
    await expect(staff.getByRole('dialog').getByRole('link', { name: 'Sunucu listesinde aç' })).toHaveAttribute('href', `/admin/servers?owner=${encodeURIComponent(user.email)}`);
    await staff.keyboard.press('Escape');
    await expect(staff.getByRole('dialog')).toBeHidden();
    // The person just looked up is in the palette's "recent" list, under the address that finds them in the user list.
    await staff.keyboard.press('Control+k');
    await expect(staff.getByRole('listbox').getByText('Son açılanlar')).toBeVisible();
    const recentUser = staff.locator(`[role="option"][id$="r:/admin/users?q=${encodeURIComponent(user.email)}"]`);
    await expect(recentUser).toContainText(user.email);
    await expect(recentUser).toContainText('Kullanıcı');
    await tour(staff, 'palette-recent-user');
    await staff.keyboard.press('Escape');
    await expect(staff.getByRole('dialog', { name: 'Komut paleti' })).toBeHidden();
    await staff.getByRole('link', { name: `${user.email} kişisinin 2 sunucusunu göster` }).click();
    // Exactly that owner's servers (not every e-mail containing theirs), with a chip that clears it.
    await expect(staff).toHaveURL(/\/admin\/servers\?owner=/);
    await expect(staff.getByRole('button', { name: `Sahip süzgecini kaldır: ${user.email}` })).toBeVisible();
    await expect(staff.getByText('2 sunucudan 2 gösteriliyor')).toBeVisible();
    await staff.setViewportSize({ width: 390, height: 900 });
    await expectNoOverflow(staff, 'admin servers filtered to an owner at 390 px');
    await tour(staff, 'admin-servers-owner-390');
    await staff.setViewportSize({ width: 1280, height: 720 });
    await staff.getByRole('button', { name: `Sahip süzgecini kaldır: ${user.email}` }).click();
    await expect(staff).not.toHaveURL(/owner=/);
    // Ctrl+K: searching a customer's e-mail offers their servers, opening the same owner filter.
    await staff.keyboard.press('Control+k');
    await staff.keyboard.type(user.email.slice(0, 12));
    const ownerOption = staff.getByRole('option', { name: new RegExp(`Sunucuları: ${user.email}`) });
    await expect(ownerOption).toContainText('2 sunucu');
    await staff.setViewportSize({ width: 390, height: 900 });
    await expectInside(staff, staff.getByRole('dialog', { name: 'Komut paleti' }), 'command palette (an owner) at 390 px');
    await expectInside(staff, staff.getByRole('dialog', { name: 'Komut paleti' }).locator('input, [role="option"]'), 'the search field and rows of the command palette (an owner) at 390 px');
    await tour(staff, 'palette-owner-390');
    await staff.setViewportSize({ width: 1280, height: 720 });
    await ownerOption.click();
    await expect(staff).toHaveURL(/\/admin\/servers\?owner=/);
    // Bulk action: rows are ticked one at a time or all those shown at once, the bar says exactly how many, and the
    // action applies to the ticked rows ("everything shown" stays a choice of its own).
    const bulkBar = staff.getByRole('region', { name: 'Toplu işlem' });
    await expect(bulkBar).toContainText('0 sunucu seçili');
    await expect(bulkBar.getByRole('button', { name: '0 sunucuya uygula' })).toBeDisabled();
    await staff.getByRole('checkbox', { name: 'web-1 sunucusunu seç' }).click();
    await expect(bulkBar).toContainText('1 sunucu seçili');
    await expect(staff.getByRole('checkbox', { name: 'web-1 sunucusunu seç' })).toHaveAttribute('aria-checked', 'true');
    await bulkBar.getByRole('button', { name: 'Gösterilen 2 sunucuyu seç' }).click();
    await expect(bulkBar).toContainText('2 sunucu seçili');
    await expect(staff.getByRole('checkbox', { name: 'web-2 sunucusunu seç' })).toHaveAttribute('aria-checked', 'true');
    await expect(bulkBar.getByRole('button', { name: 'Seçilenler (2)' })).toHaveAttribute('aria-pressed', 'true');
    await expect(bulkBar.getByRole('button', { name: 'Gösterilenlerin tümü (2)' })).toHaveAttribute('aria-pressed', 'false');
    await choose(staff, bulkBar, /İşlem/, 'Sil (geri alma süresiyle)');
    await bulkBar.getByRole('button', { name: '2 sunucuya uygula' }).click();
    // The copy toast is an alertdialog too; the confirmation is the one that explains the delete. It states the count
    // in its title, its question and on the button that confirms.
    const ask = staff.getByRole('alertdialog').filter({ hasText: 'sahiplerine bildirim gider' });
    await expect(ask).toBeVisible();
    await expect(ask.getByRole('heading')).toHaveText('Sil (geri alma süresiyle): 2 sunucuya uygula');
    await expect(ask).toContainText('Seçtiğiniz 2 sunucuda “Sil (geri alma süresiyle)” yapılsın mı?');
    await expect(ask.getByRole('button', { name: 'Evet, 2 sunucuda: Sil (geri alma süresiyle)' })).toBeVisible();
    for (const width of [390, 1280]) {
      await staff.setViewportSize({ width, height: 900 });
      await staff.waitForTimeout(400);
      // Both buttons of the question are whole on the screen at every width (stacked on a phone, the long one wrapping).
      await expectInside(staff, ask.getByRole('button'), `buttons of the bulk delete question at ${width} px`);
      await expectInside(staff, ask, `the bulk delete question at ${width} px`);
      await tour(staff, `admin-bulk-delete-${width}`);
    }
    await ask.getByRole('button', { name: 'Vazgeç' }).click();
    await expect(ask).toBeHidden();
    // Saved views: the owner filter gets a name, is found again after the list is loaded afresh without filters,
    // brings its address parameters back when applied, and can be deleted.
    await staff.getByRole('button', { name: 'Kayıtlı görünümler', exact: true }).click();
    await staff.getByRole('dialog').getByLabel('Geçerli süzgeçleri kaydet').fill('Müşterinin sunucuları');
    await staff.getByRole('dialog').getByRole('button', { name: 'Kaydet', exact: true }).click();
    await expect(staff.getByText('“Müşterinin sunucuları” görünümü kaydedildi.').first()).toBeVisible();
    await expect(staff.getByRole('dialog').getByRole('status')).toHaveText('“Müşterinin sunucuları” görünümü etkin.');
    await staff.keyboard.press('Escape');
    await expect(staff.getByRole('button', { name: 'Kayıtlı görünümler. Etkin görünüm: Müşterinin sunucuları', exact: true })).toBeVisible();
    await staff.goto('/admin/servers');
    await expect(staff).not.toHaveURL(/owner=/);
    await staff.getByRole('button', { name: 'Kayıtlı görünümler', exact: true }).click();
    await staff.getByRole('button', { name: 'Müşterinin sunucuları görünümünü uygula', exact: true }).click();
    await expect(staff).toHaveURL(/\/admin\/servers\?owner=/);
    await expect(staff.getByRole('button', { name: `Sahip süzgecini kaldır: ${user.email}` })).toBeVisible();
    await expect(staff.getByText('2 sunucudan 2 gösteriliyor')).toBeVisible();
    await staff.getByRole('button', { name: 'Kayıtlı görünümler. Etkin görünüm: Müşterinin sunucuları', exact: true }).click();
    await staff.getByRole('button', { name: 'Müşterinin sunucuları görünümünü sil', exact: true }).click();
    await expect(staff.getByText('“Müşterinin sunucuları” görünümü silindi.').first()).toBeVisible();
    await expect(staff.getByRole('dialog').getByText(/Henüz kayıtlı görünüm yok/)).toBeVisible();
    await staff.keyboard.press('Escape');
    await staff.context().close();

    // The customer's inbox: the two replies are the same news about the same ticket, so they are one row with a
    // count. The row opens to show each; pressing it marks both read (the unread count drops) and opens the ticket.
    type Note = { event: string; link: string | null; readAt: string | null };
    const replyNotes = async () => ((await (await page.request.get('/api/notifications')).json()) as { notifications: Note[] }).notifications
      .filter((n) => n.event === 'support.reply' && n.link === `/support/${ticket.id}`);
    await expect.poll(async () => (await replyNotes()).length, { timeout: 30_000 }).toBe(2);
    expect((await replyNotes()).every((n) => !n.readAt)).toBe(true);
    await page.goto('/');
    const bell = page.getByRole('button', { name: /^(\d+ okunmamış bildirim|Bildirimler)$/ }).first();
    const unreadShown = async () => Number(/^\d+/.exec((await bell.getAttribute('aria-label')) ?? '')?.[0] ?? 0);
    await expect(bell).toHaveAccessibleName(/^\d+ okunmamış bildirim$/);
    const unreadBefore = await unreadShown();
    expect(unreadBefore).toBeGreaterThanOrEqual(2);
    await bell.click();
    const inbox = page.getByRole('dialog');
    const grouped = inbox.getByRole('listitem').filter({ hasText: 'Destek talebinize yanıt geldi' });
    const groupRow = grouped.getByRole('button', { name: /^2 bildirim: Destek talebinize yanıt geldi/ });
    await expect(groupRow).toHaveCount(1);
    await expect(groupRow).toContainText(`#${ticket.number} · web-1 yanıt vermiyor`);
    const showEach = grouped.getByRole('button', { name: '2 bildirimi tek tek göster', exact: true });
    await expect(showEach).toHaveAttribute('aria-expanded', 'false');
    await showEach.click();
    const each = grouped.getByRole('list', { name: 'Bu satırdaki 2 bildirim' });
    await expect(each.getByRole('listitem')).toHaveCount(2);
    await expect(each.getByRole('button').first()).toContainText('(Okunmamış)');
    await expect(grouped.getByRole('button', { name: 'Tek tek bildirimleri gizle', exact: true })).toHaveAttribute('aria-expanded', 'true');
    // Operations are named in words in the inbox, never by their code names.
    await expect(page.getByText(/: (power_on|power_off|shutdown|reset) tamamlandı/)).toHaveCount(0);
    await page.waitForTimeout(300);
    await tour(page, 'bell-group');
    await groupRow.click();
    await expect(page).toHaveURL(new RegExp(`/support/${ticket.id}$`));
    await expect.poll(async () => (await replyNotes()).every((n) => !!n.readAt)).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(unreadShown).toBeLessThan(unreadBefore);
    // The customer's page of the same ticket shows the thread and no snapshot of the server; their answer from the
    // API has no such key either.
    await expect(page.locator('main').getByText('Sabahtan beri ping yanıtı yok.')).toBeVisible();
    await expect(page.locator('main').getByText('Kural düzeltildi, yeniden dener misiniz?')).toBeVisible();
    await expect(page.locator('details').filter({ hasText: diagTitle })).toHaveCount(0);
    await expect(page.getByText(diagTitle)).toHaveCount(0);
    const ownTicket = await (await page.request.get(`/api/support/tickets/${ticket.id}`)).json() as Record<string, unknown>;
    expect(ownTicket.staff).toBe(false);
    expect('diagnostics' in ownTicket).toBe(false);
    await page.goto('/');

    // Both go: web-1 from the grace period (bulk delete while two are listed) with "delete for good now", then web-2 at once.
    for (const name of ['web-1', 'web-2']) {
      await page.getByRole('list', { name: 'Sunucularınız' }).getByRole('link', { name: new RegExp('^' + name) }).click();
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
        await tour(page, 'servers-trash-filter-390', true);
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
  // Kept for the spec files that run after this one (smart.spec.ts): by then this address has signed in too often to
  // do it again (sign-in is limited per address), and this session is still good. Outside the results folder, which
  // is copied and uploaded when a run fails.
  try { writeFileSync(join(tmpdir(), 'lightning-e2e-admin-session.json'), JSON.stringify(adminCookies)); } catch { /* the later files sign in themselves */ }
}

test.describe('people, settings and smart features (English browser)', () => {
  test.use({ locale: 'en-US' });

  test('users, roles and permissions are managed from the panel', async ({ page }) => {
    await signInAdmin(page);
    await expect(page).toHaveURL(/\/admin$/);
    await page.getByRole('link', { name: 'Users', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Users');
    await expect(page.getByRole('grid', { name: 'Users' })).toContainText(admin.email);
    // New user: a strong password is filled in, replaced with one press, and can be copied.
    await page.getByRole('button', { name: 'New user' }).first().click();
    const newUser = page.getByRole('dialog');
    const initial = await newUser.getByRole('textbox', { name: 'Password' }).inputValue();
    expect(initial).toMatch(/^.{20}$/);
    await newUser.getByRole('button', { name: 'Generate a new password' }).click();
    await expect(newUser.getByRole('textbox', { name: 'Password' })).not.toHaveValue(initial);
    await expect(newUser.getByRole('button', { name: 'Copy' })).toBeEnabled();
    await expect(page.locator('#boot-loader')).toHaveCSS('opacity', '0');
    await tour(page, 'user-new-password');
    await newUser.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('link', { name: 'Roles' }).click();
    for (const name of ['Administrator', 'Customer', 'Operator', 'Support', 'Auditor']) await expect(page.getByRole('heading', { name: new RegExp('^' + name) })).toBeVisible();
    // A custom role with one permission.
    await page.getByRole('button', { name: 'New role' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('E2E Viewer');
    // The permission search narrows the list; a miss says so.
    await dialog.getByRole('searchbox', { name: 'Search permissions' }).fill('zzzz');
    await expect(dialog.getByText('No permission matches.')).toBeVisible();
    await dialog.getByRole('searchbox', { name: 'Search permissions' }).fill('catalog');
    await tick(dialog.getByRole('checkbox', { name: /See the catalog/ }));
    await dialog.getByRole('searchbox', { name: 'Search permissions' }).fill('');
    await dialog.getByRole('button', { name: 'Save' }).click();
    // The saved role in the list is the proof; the toast may already be gone on a slow run.
    await expect(page.getByRole('heading', { name: 'E2E Viewer' })).toBeVisible();
    // Duplicating a role opens a new one with its name and permissions.
    await page.getByRole('button', { name: /^Duplicate the Support/ }).click();
    await expect(page.getByRole('dialog').getByLabel('Name')).toHaveValue(/copy$/);
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    // Account security score: what is missing, and "Fix" takes you to it (outlined for a moment).
    await page.goto('/account?tab=security');
    await expect(page.getByText('Account security', { exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: /Security score: \d+ out of 100/ })).toBeVisible();
    await expect(page.getByText('Two-factor is off')).toBeVisible();
    await expect(page.getByText('No forgotten sign-ins')).toBeVisible();
    await expect(page.locator('#boot-loader')).toHaveCSS('opacity', '0');
    await tour(page, 'security-score');
    await page.getByRole('button', { name: 'Fix: Two-factor is off' }).click();
    await expect(page.locator('#two-factor')).toHaveClass(/ring-2/);
    await expect(page.locator('#two-factor')).toBeInViewport();
    // Changing the password: a strength meter, and the same password again is refused before it is sent.
    await page.getByLabel('Current password', { exact: true }).fill('same-password-123');
    await page.getByLabel('New password', { exact: true }).fill('same-password-123');
    await expect(page.getByText(/^Password strength:/)).toBeVisible();
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('The new password cannot be the same as the current one.')).toBeVisible();
    await page.getByLabel('Current password', { exact: true }).fill('');
    await page.getByLabel('New password', { exact: true }).fill('same-password-123');
    await tour(page, 'change-password');
    await page.getByLabel('New password', { exact: true }).fill('');
    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectNoOverflow(page, 'security score at 390 px');
    await tour(page, 'security-score-390', true);
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  test('what waits for staff is counted in the menu; a restore hold shows on every page and is released from System', async ({ page }) => {
    await signInAdmin(page);
    // Two of the states behind GET /admin/attention cannot be produced on this stack from a browser: an abuse finding
    // needs a server whose address answers on a watched port, and the hold after a restore is written by
    // `install.sh restore` straight into the database (maintenance_state, key restore_hold); the API can only read and
    // release it. For these the page is handed the API's own answer with the two fields set; the hold's own route
    // answers "held" until the page releases it, and the release itself goes to the real route. Everything else in
    // the answers is the API's (the failed operations of the server lifecycle test, when the simulator is there).
    const since = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const backup = 'lightning-20261118T031500Z.tar.enc';
    let held = true;
    let real: { failedOperations?: number; abuse?: number; restoreHold?: unknown } = {};
    const releases: { status: number; body: unknown }[] = [];
    // (A read that was on its way when the page moved on has nobody left to answer: not an error of the test.)
    await page.route('**/api/admin/attention', async (route) => {
      try {
        const answer = await route.fetch();
        real = await answer.json() as typeof real;
        await route.fulfill({ response: answer, json: { ...real, abuse: 3, restoreHold: held ? { since, backup } : null } });
      } catch { /* the page moved on */ }
    });
    await page.route('**/api/admin/system/restore-hold', async (route) => {
      if (route.request().method() === 'DELETE') {
        const answer = await route.fetch();
        releases.push({ status: answer.status(), body: await answer.json() });
        held = false;
        return route.fulfill({ response: answer });
      }
      if (!held) return route.continue();
      await route.fulfill({ json: { held: true, backup, restoredAt: since, detail: { backup, restored_at: since } } }).catch(() => undefined);
    });
    await page.goto('/admin');
    const menu = page.getByRole('navigation', { name: 'Main navigation' });
    // Folded away, "More tools" still says what waits inside it; opened, the count sits on the Abuse entry itself.
    const more = menu.getByRole('button', { name: /^More tools \(\d+\)/ });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(more).toHaveAccessibleName(/^More tools \(\d+\)\s*,\s*3 open abuse findings$/);
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(more).toHaveAccessibleName(/^More tools \(\d+\)$/);
    const abuseEntry = menu.locator('a[href="/admin/abuse"]');
    await expect(abuseEntry).toHaveAccessibleName(/^Abuse\s*,\s*3 open abuse findings$/);
    await expect(abuseEntry.locator('[aria-hidden=true]').filter({ hasText: /^\d+\+?$/ })).toHaveText('3');
    // The real answer has no abuse finding and no hold: the two fields above are the only ones that were set.
    expect(real.abuse).toBe(0);
    expect(real.restoreHold).toBeNull();
    const serversEntry = menu.locator('a[href="/admin/servers"]');
    if (process.env.E2E_VCSIM_HOST) {
      expect(real.failedOperations).toBeGreaterThanOrEqual(1);
      await expect(serversEntry).toHaveAccessibleName(new RegExp(`^Servers\\s*,\\s*${real.failedOperations} operations? failed in the last 24 hours$`));
      await expect(serversEntry.locator('[aria-hidden=true]').filter({ hasText: /^\d+\+?$/ })).toHaveText(String(real.failedOperations));
    } else if (!real.failedOperations) await expect(serversEntry).toHaveAccessibleName(/^Servers$/);
    await page.waitForTimeout(300);
    await tour(page, 'nav-attention');

    // The hold: a bar above every page, in the page's flow, with since when and the way to the page that releases it.
    const bar = page.getByRole('complementary', { name: 'Restore hold' });
    await expect(bar).toContainText('The panel is on hold after a restore');
    await expect(bar).toContainText(/since [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s?[AP]M/);
    await expect(bar.getByText('It does nothing by itself until you release it.')).toBeVisible();
    await expect(bar.getByRole('link', { name: 'Open the System page' })).toHaveAttribute('href', '/admin/system');
    // It pushes the page down instead of covering it: the header starts where the bar ends.
    const edges = await page.evaluate(() => {
      const b = document.querySelector('aside[aria-label="Restore hold"]')!.getBoundingClientRect(), h = document.querySelector('header')!.getBoundingClientRect();
      return { barBottom: Math.round(b.bottom), headerTop: Math.round(h.top) };
    });
    expect(edges.headerTop).toBeGreaterThanOrEqual(edges.barBottom);
    await page.waitForTimeout(300);
    await tour(page, 'restore-hold-bar');
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoOverflow(page, 'restore-hold bar at 390 px');
    // On a phone: the fact, since when and the link; the sentence of help is left out.
    await expect(bar).toContainText('The panel is on hold after a restore');
    await expect(bar.getByText('It does nothing by itself until you release it.')).toBeHidden();
    await expect(bar.getByRole('link', { name: 'Open the System page' })).toBeVisible();
    await tour(page, 'restore-hold-bar-390');
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/admin/users');
    await expect(bar).toBeVisible();
    await bar.getByRole('link', { name: 'Open the System page' }).click();
    await expect(page).toHaveURL(/\/admin\/system$/);
    // On the System page the full notice stands instead of the bar: which backup, when, what to check first.
    const hold = page.locator('[data-section="Restore hold"]');
    await expect(hold).toBeVisible();
    await expect(bar).toHaveCount(0);
    const notice = hold.getByRole('status');
    await expect(notice).toContainText('The panel is on hold after a restore');
    await expect(notice).toContainText(new RegExp(`The backup ${backup.replaceAll('.', '\\.')} was restored on [A-Z][a-z]{2} \\d{1,2}, \\d{4}, \\d{1,2}:\\d{2}\\s?[AP]M\\. Until you release the hold, the panel does nothing by itself`));
    await expect(hold.getByText('Check before you release')).toBeVisible();
    await expect(hold.getByRole('listitem')).toHaveCount(3);
    await expect(hold).toContainText('docker compose exec api node dist/cli.js release-restore-hold');
    await expect(health(page)).toHaveText('API, PostgreSQL and Redis are reachable');
    await page.waitForTimeout(300);
    await tour(page, 'restore-hold-system', true);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoOverflow(page, 'restore hold on the System page at 390 px');
    await page.setViewportSize({ width: 1280, height: 720 });
    // Releasing asks first and says that it cannot be taken back; "Cancel" sends nothing.
    await hold.getByRole('button', { name: 'Release', exact: true }).click();
    const ask = page.getByRole('alertdialog', { name: 'Release the hold?' });
    await expect(ask).toContainText('The panel acts on the restored data at once');
    await expect(ask).toContainText('This cannot be taken back.');
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(ask).toBeHidden();
    expect(releases).toEqual([]);
    await expect(hold).toBeVisible();
    await hold.getByRole('button', { name: 'Release', exact: true }).click();
    await ask.getByRole('button', { name: 'Release', exact: true }).click();
    await expect(page.getByText('The hold was released')).toBeVisible();
    // One DELETE reached the API's own route, which answered as it does when nothing is held.
    expect(releases).toEqual([{ status: 200, body: { held: false, released: false } }]);
    await expect(hold).toHaveCount(0);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview');
    await expect(bar).toHaveCount(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('a reseller\'s customer sees who manages the account and leaves; staff take another one out; the browser keeps nothing of one account for the next', async ({ page, browser }) => {
    test.setTimeout(180_000);
    const csrf = { 'x-lightning-csrf': '1' };
    await signInAdmin(page);
    const me = await (await page.request.get('/api/auth/me')).json() as { id: string; email: string };
    // The admin's own account is the reseller here: the reseller's side needs a session, and one more sign-in of an
    // existing account would press on the sign-in limit. It stops being one at the end of the test.
    expect((await page.request.put(`/api/admin/resellers/${me.id}`, { headers: csrf, data: {} })).ok()).toBe(true);
    const stamp = Date.now();
    const leaver = { email: `leaver-${stamp}@example.test`, password: 'e2e leaver passphrase 2026' };
    const kept = { email: `kept-${stamp}@example.test` };
    const idOf: Record<string, string> = {};
    for (const [email, name] of [[leaver.email, 'Leaving Customer'], [kept.email, 'Kept Customer']]) {
      const made = await page.request.post('/api/reseller/customers', { headers: csrf, data: { email, name } });
      expect(made.status(), await made.text()).toBe(201);
      idOf[email] = (await made.json() as { id: string }).id;
    }
    // The reseller typed the address and knows no password; staff set one so that the customer can sign in here.
    const password = await page.request.post('/api/auth/admin/set-user-password', { headers: { ...csrf, origin: new URL(page.url()).origin }, data: { userId: idOf[leaver.email], newPassword: leaver.password } });
    expect(password.ok(), await password.text()).toBe(true);

    // ---- The customer: who manages the account, what that means, and the way out ----
    const customer = await (await browser.newContext({ locale: 'en-US' })).newPage();
    await signIn(customer, leaver);
    await expect(customer).toHaveURL(/\/$/);
    await customer.goto('/account');
    const managed = customer.locator('[data-section$="manages your account"]');
    await expect(managed).toBeVisible();
    await expect(managed).toContainText('A reseller opened this account for you and pays for your servers.');
    await expect(managed.getByRole('listitem')).toHaveCount(5);
    await expect(managed).toContainText('order new servers for you');
    await expect(managed).toContainText('read your support tickets');
    await expect(managed).toContainText('see or reset your password');
    await expect(managed.getByRole('link', { name: me.email })).toHaveAttribute('href', `mailto:${me.email}`);
    await expect(managed.getByRole('link', { name: 'Open activity' })).toHaveAttribute('href', '/account?tab=activity');
    await expect(managed.getByText('The reseller is switched off right now')).toHaveCount(0);
    await customer.waitForTimeout(300);
    await tour(customer, 'account-managed', true);
    await customer.setViewportSize({ width: 390, height: 844 });
    await expectNoOverflow(customer, 'account managed by a reseller at 390 px');
    await customer.setViewportSize({ width: 1280, height: 720 });
    // Leaving asks first, with what follows from it; "Cancel" leaves everything as it is.
    await managed.getByRole('button', { name: 'Leave the reseller' }).click();
    const leaving = customer.getByRole('alertdialog', { name: /^Leave .+\?$/ });
    await expect(leaving).toContainText('Your servers stay yours and keep running.');
    await expect(leaving).toContainText('can no longer see or manage your servers');
    await expect(leaving).toContainText('This cannot be undone from the panel.');
    await customer.waitForTimeout(300);
    await tour(customer, 'account-managed-leave');
    await leaving.getByRole('button', { name: 'Cancel' }).click();
    await expect(leaving).toBeHidden();
    expect(((await (await customer.request.get('/api/reseller/summary')).json()) as { managedBy: unknown }).managedBy).toBeTruthy();
    await managed.getByRole('button', { name: 'Leave the reseller' }).click();
    await leaving.getByRole('button', { name: 'Leave the reseller' }).click();
    await expect(customer.getByText('Your account is no longer managed by a reseller. Servers billed to you from now on: 0.')).toBeVisible();
    await expect(managed).toHaveCount(0);
    expect(((await (await customer.request.get('/api/reseller/summary')).json()) as { managedBy: unknown }).managedBy).toBeNull();
    await customer.reload();
    await expect(customer.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(managed).toHaveCount(0);

    // ---- Staff: the reseller's record lists its customers; one is taken out behind a question ----
    await page.goto(`/admin/users?q=${encodeURIComponent(me.email)}`);
    const users = page.getByRole('grid', { name: 'Users' });
    await users.getByRole('row').filter({ hasText: me.email }).locator('[data-row-open]').click();
    const summary = page.getByRole('dialog');
    const reseller = summary.locator('section').filter({ has: page.getByRole('heading', { name: 'Reseller', exact: true }) });
    await expect(reseller.getByText('Active', { exact: true })).toBeVisible();
    // The one who left is no longer listed.
    await expect(reseller.getByRole('heading', { name: 'Customers of this reseller (1)' })).toBeVisible();
    await expect(reseller.getByRole('listitem')).toHaveCount(1);
    await expect(reseller.getByRole('listitem')).toContainText(kept.email);
    await expect(reseller.getByRole('listitem')).toContainText('Kept Customer · 0 servers');
    await expect(reseller).not.toContainText(leaver.email);
    await page.waitForTimeout(300);
    await tour(page, 'reseller-customers');
    await reseller.getByRole('button', { name: `Remove from reseller ${kept.email}` }).click();
    const releasing = page.getByRole('alertdialog', { name: `Remove ${kept.email} from this reseller?` });
    await expect(releasing).toContainText('The reseller can no longer see or manage this customer’s servers.');
    await releasing.getByRole('button', { name: 'Cancel' }).click();
    await expect(releasing).toBeHidden();
    await expect(reseller.getByRole('listitem')).toHaveCount(1);
    await reseller.getByRole('button', { name: `Remove from reseller ${kept.email}` }).click();
    await releasing.getByRole('button', { name: 'Remove from reseller' }).click();
    await expect(page.getByText(`${kept.email} was removed from the reseller. Servers: 0 · subscriptions moved: 0 · invoices withdrawn: 0 · left with the reseller: 0.`)).toBeVisible();
    await expect(reseller.getByRole('heading', { name: 'Customers of this reseller (0)' })).toBeVisible();
    await expect(reseller.getByText('No customers yet.')).toBeVisible();
    const after = await (await page.request.get(`/api/admin/resellers/${me.id}`)).json() as { customers: unknown[] };
    expect(after.customers).toEqual([]);
    // The account stops being a reseller (asked first), as it was before this test.
    await reseller.getByRole('button', { name: 'No longer a reseller' }).click();
    const stopping = page.getByRole('alertdialog', { name: 'Stop this reseller?' });
    await stopping.getByRole('button', { name: 'No longer a reseller' }).click();
    await expect(page.getByText('No longer a reseller; their customers are ordinary accounts now')).toBeVisible();
    await expect(reseller.getByRole('button', { name: 'Make a reseller' })).toBeVisible();
    expect(((await (await page.request.get(`/api/admin/resellers/${me.id}`)).json()) as { reseller: unknown }).reseller).toBeNull();
    // The button that had the focus is gone with what it did (and its question with it): the keyboard is still with the
    // window, so Escape closes it (components/window-chrome.tsx).
    await page.keyboard.press('Escape');
    await expect(summary).toBeHidden();

    // ---- What the browser keeps for one account is gone before the next one sees the panel (lib/session-end.ts) ----
    // Content keys of both storages are written as the panel writes them (a half-written ticket, a draft, the recent
    // list, an order being composed, a table's sort), next to a preference that names nobody and must stay.
    const plant = (who: Page, mark: string) => who.evaluate((m) => {
      localStorage.setItem('lvm:support-new-draft', JSON.stringify({ subject: `ticket of ${m}`, body: 'half written' }));
      localStorage.setItem('lvm:draft:dispute:e2e', `dispute of ${m}`);
      localStorage.setItem('lvm-recent', JSON.stringify([{ href: '/servers/e2e', label: `server of ${m}`, kind: 'server' }]));
      sessionStorage.setItem('lvm-order', JSON.stringify({ state: { name: `order-of-${m}` }, version: 0 }));
      sessionStorage.setItem('lvm:table:/admin/users/e2e:Sessions', JSON.stringify({ sort: m }));
      localStorage.setItem('lvm-first-steps-hidden', '1');
    }, mark);
    const kept4 = (who: Page) => who.evaluate(() => ({
      content: [localStorage.getItem('lvm:support-new-draft'), localStorage.getItem('lvm:draft:dispute:e2e'), localStorage.getItem('lvm-recent'),
        sessionStorage.getItem('lvm-order'), sessionStorage.getItem('lvm:table:/admin/users/e2e:Sessions')].filter((v) => v !== null),
      owner: [localStorage.getItem('lvm-owner'), sessionStorage.getItem('lvm-owner')], preference: localStorage.getItem('lvm-first-steps-hidden') }));
    // "Sign in as": the staff member's content does not follow into the customer's panel...
    await expect(page).toHaveURL(/\/admin\/users/);
    await plant(page, 'the staff member');
    expect((await kept4(page)).content).toHaveLength(5);
    expect((await kept4(page)).owner).toEqual([`${me.id}|`, `${me.id}|`]);
    await page.goto(`/admin/users?q=${encodeURIComponent(kept.email)}`);
    expect((await kept4(page)).content).toHaveLength(5); // the same account on another page: nothing is removed
    await users.getByRole('row').filter({ hasText: kept.email }).getByRole('button', { name: `Actions for ${kept.email}` }).click();
    await page.getByRole('menuitem', { name: 'Sign in as user' }).click();
    const asking = page.getByRole('alertdialog', { name: `Sign in as ${kept.email}?` });
    await expect(asking).toContainText('it is recorded in the audit log');
    await asking.getByRole('button', { name: 'Sign in as user' }).click();
    await expect(page.getByRole('status').filter({ hasText: `You are viewing as ${kept.email}.` })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your servers');
    expect(await kept4(page)).toEqual({ content: [], owner: [`${idOf[kept.email]}|${me.id}`, `${idOf[kept.email]}|${me.id}`], preference: '1' });
    // ...nor what they wrote there back out of it.
    await plant(page, 'the customer, written by staff');
    await page.getByRole('button', { name: 'Back to my account' }).click();
    await expect(page).toHaveURL(/\/admin\/users$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Users');
    expect(await kept4(page)).toEqual({ content: [], owner: [`${me.id}|`, `${me.id}|`], preference: '1' });

    // Another account opens the panel in a browser whose last one never signed out (here: the customer's tab gets the
    // staff member's session): the customer's content is removed before anything reads it.
    await customer.goto('/account');
    await plant(customer, 'the customer');
    expect(await kept4(customer)).toEqual({ content: expect.arrayContaining([expect.stringContaining('the customer')]), owner: [`${idOf[leaver.email]}|`, `${idOf[leaver.email]}|`], preference: '1' });
    const customerCookies = await customer.context().cookies();
    await customer.context().addCookies(await page.context().cookies());
    await customer.goto('/admin');
    await expect(customer.getByRole('heading', { level: 1 })).toHaveText('Overview');
    expect(await kept4(customer)).toEqual({ content: [], owner: [`${me.id}|`, `${me.id}|`], preference: '1' });
    // And the other way round, back to the customer's own session.
    await plant(customer, 'the staff member');
    // The cookies are changed with no page of the panel open: one that is open keeps asking the API, and an answer
    // refused in the moment between the two calls sends it to sign-in, which cuts off the visit that follows.
    await customer.goto('about:blank');
    await customer.context().clearCookies();
    await customer.context().addCookies(customerCookies);
    await customer.goto('/');
    await expect(customer.getByRole('heading', { level: 1 })).toHaveText('Your servers');
    expect(await kept4(customer)).toEqual({ content: [], owner: [`${idOf[leaver.email]}|`, `${idOf[leaver.email]}|`], preference: '1' });
    // Signing out: the content goes with the session, the marker of whose it was too; the preference stays.
    // Saved views an earlier version kept in the browser go as well, but the ones of the account that signs out are
    // sent to that account first, while there still is a session; those of anybody else are removed unsent. (Planted
    // on a page without a list of its own, which would otherwise move its views by itself.)
    await customer.goto('/account');
    await expect(customer.getByRole('heading', { level: 1 })).toBeVisible();
    await plant(customer, 'the customer');
    const viewKeys = [`lvm:views:${idOf[leaver.email]}:servers`, `lvm:views:${me.id}:admin-users`];
    await customer.evaluate(([own, other]) => {
      localStorage.setItem(own, JSON.stringify([{ id: 'old-1', name: 'Stopped ones', query: 'state=stopped&page=3', isDefault: true }]));
      localStorage.setItem(other, JSON.stringify([{ id: 'old-2', name: 'Of somebody else', query: 'status=banned' }]));
    }, viewKeys);
    const viewWrites: Promise<{ status: number; sent: unknown; answer: unknown }>[] = [];
    customer.on('response', (r) => {
      if (r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/saved-views')
        viewWrites.push(r.json().catch(() => null).then((answer) => ({ status: r.status(), sent: r.request().postDataJSON(), answer })));
    });
    await customer.getByRole('button', { name: 'Account menu' }).click();
    await customer.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(customer).toHaveURL(/\/login$/);
    expect(await kept4(customer)).toEqual({ content: [], owner: [null, null], preference: '1' });
    expect(await customer.evaluate((keys) => keys.map((k) => localStorage.getItem(k)), viewKeys)).toEqual([null, null]);
    const written = await Promise.all(viewWrites);
    expect(written.map((w) => [w.status, w.sent])).toEqual([[201, { list: 'servers', name: 'Stopped ones', params: { state: 'stopped' }, isDefault: true }]]);
    expect(written[0]!.answer).toMatchObject({ name: 'Stopped ones', params: { state: 'stopped' }, isDefault: true });
    expect((await customer.request.get('/api/auth/me')).status()).toBe(401);
    await customer.context().close();
    // The staff member's own session is as it was.
    expect((await page.request.get('/api/auth/me')).status()).toBe(200);
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
    // Events are grouped by day, can be downloaded, and the abuse findings are searchable.
    await expect(page.getByText(/^Today · \d+ events?$/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download CSV' })).toBeVisible();
    await page.goto('/admin/abuse');
    await expect(page.getByRole('searchbox', { name: 'Search findings' })).toBeVisible();
    // A number tile filters to its findings and can be cleared.
    await page.getByRole('button', { name: /Risky ports open/ }).click();
    await page.getByRole('button', { name: 'Clear filter: Risky ports open' }).click();
    await expect(page.getByRole('button', { name: /Clear filter/ })).toHaveCount(0);
    // Operations filter by state and search.
    await page.goto('/admin/servers?tab=operations');
    await expect(page.getByRole('searchbox', { name: /Search server, owner/ })).toBeVisible();
    await page.getByRole('group', { name: 'State' }).getByRole('button', { name: /^Failed/ }).click();
    await expect(page.getByRole('group', { name: 'State' }).getByRole('button', { name: /^Failed/ })).toHaveAttribute('aria-pressed', 'true');
    await page.goto('/admin/settings?tab=announcement');
    await page.getByText('Show the announcement').click();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Announcement saved.').first()).toBeVisible();
  });

  test('dialogs are windows: snapped by keys and edges, pulled out, laid out from the menu, resized', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await signInAdmin(page);
    await interactive(page);
    await page.getByRole('heading', { level: 1 }).click();
    await page.keyboard.press('Shift+?');
    const win = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(win).toBeVisible();
    const header = win.locator('.modal__header');
    const box = () => win.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
    const near = (a: number, b: number) => Math.abs(a - b) <= 2;
    // The layouts: 8 px from the screen's edges and from the other half (lib/windows.ts).
    const half = { left: { x: 8, y: 8, w: 628, h: 704 }, right: { x: 644, y: 8, w: 628, h: 704 } };
    const at = async (want: { x: number; y: number; w: number; h: number }) => {
      await expect.poll(async () => { const b = await box(); return near(b.x, want.x) && near(b.y, want.y) && near(b.w, want.w) && near(b.h, want.h); }, { timeout: 3_000 }).toBe(true);
    };
    await page.waitForTimeout(400); // the entrance animation scales the window
    const natural = await box();

    // Keys on the focused window: left half (twice stays left), back to its own size and place.
    await win.locator('.modal__heading').click();
    await page.keyboard.press('Control+Alt+ArrowLeft');
    await at(half.left);
    await expect(win).toHaveAttribute('data-win-layout', 'left');
    await page.keyboard.press('Control+Alt+ArrowLeft');
    await expect(win).toHaveAttribute('data-win-layout', 'left');
    await page.keyboard.press('Control+Alt+ArrowDown');
    await at(natural);

    // Dragged against the right edge: a preview of the right half, then the right half.
    let bar = (await header.boundingBox())!;
    await page.mouse.move(bar.x + 40, bar.y + bar.height / 2);
    await page.mouse.down();
    await page.mouse.move(800, 300, { steps: 5 });
    await page.mouse.move(1279, 300, { steps: 10 });
    await expect(page.locator('.win-preview[data-win-layout="right"]')).toBeVisible();
    await page.mouse.up();
    await expect(page.locator('.win-preview')).toHaveCount(0);
    await at(half.right);

    // Dragged by its title bar out of the layout: its own size again, under the pointer.
    bar = (await header.boundingBox())!;
    await page.mouse.move(bar.x + 60, bar.y + 20);
    await page.mouse.down();
    await page.mouse.move(500, 300, { steps: 10 });
    await page.mouse.up();
    await expect(win).not.toHaveAttribute('data-win-layout');
    await expect.poll(async () => { const b = await box(); return near(b.w, natural.w) && near(b.h, natural.h) && b.x < 500 && 500 < b.x + b.w; }, { timeout: 3_000 }).toBe(true);

    // The layout menu, by keyboard: from the first picture down the grid to "Centre", Enter; focus goes back.
    const menuButton = win.getByRole('button', { name: 'Window layout' });
    await menuButton.click();
    const menu = win.getByRole('menu', { name: 'Window layout' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Left half' })).toHaveAttribute('title', 'Left half (Ctrl+Alt+←)');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Centre' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    await expect(menuButton).toBeFocused();
    await at(natural);

    // A right click on the title bar opens it too; Escape closes the menu, not the window.
    await header.click({ button: 'right', position: { x: 40, y: 20 } });
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(win).toBeVisible();

    // The corner grip makes it smaller with its top-left corner in place; a double click on it resets the size.
    const grip = (await win.locator('[data-win-grip="se"]').boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 - 80, grip.y + grip.height / 2 - 60, { steps: 6 });
    await page.mouse.up();
    await at({ x: natural.x, y: natural.y, w: natural.w - 80, h: natural.h - 60 });
    await win.locator('[data-win-grip="se"]').dblclick();
    await at(natural);

    await win.locator('.modal__heading').click();
    await page.keyboard.press('Escape');
    await expect(win).toBeHidden();
  });

  test('firewalls: created from a template, rules edited and checked, deleted', async ({ page }) => {
    await signInAdmin(page);
    await expect(page).toHaveURL(/\/admin$/);
    // Staff see their own workspace folded away under its heading.
    await page.getByRole('button', { name: 'My workspace' }).first().click();
    await page.getByRole('link', { name: 'Firewalls' }).first().click();
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
    await expect(page.getByText('Ctrl+S saves')).toBeVisible();
    await page.keyboard.press('Control+s'); // the editor's shortcut, not the browser's "save page"
    await expect(page.getByText('Saved.').first()).toBeVisible();
    await expect(page.getByText('5 of 50 rules')).toBeVisible();
    // Hints: a database port open to everyone, fixed with "My IP"; a duplicate rule; discarded afterwards.
    await page.getByRole('button', { name: 'Rule', exact: true }).first().click();
    await page.getByRole('textbox', { name: 'Port or range' }).last().fill('3306');
    await expect(page.getByText('Port 3306 (MySQL) is open to the whole internet.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: /My IP/ }).last().click();
    await expect(page.getByRole('textbox', { name: 'Source addresses' }).last()).toHaveValue(/\/(32|128)$/);
    await expect(page.getByText('Port 3306 (MySQL)', { exact: false })).toHaveCount(0);
    // The SSH shortcut is ticked (already there); typing the same rule by hand is flagged as a duplicate.
    await expect(page.getByRole('button', { name: 'The SSH rule is already there' }).first()).toBeDisabled();
    await expect(page.getByText('Open to everyone').first()).toBeVisible();
    await page.getByRole('button', { name: 'Rule', exact: true }).first().click();
    await page.getByRole('textbox', { name: 'Port or range' }).last().fill('22');
    // A rule added by hand is described by its port's service until a description is typed.
    await expect(page.getByRole('textbox', { name: 'Description' }).last()).toHaveValue('SSH');
    await expect(page.getByText('The "SSH" rule appears twice')).toBeVisible();
    await tour(page, 'firewall-hints', true);
    await page.setViewportSize({ width: 390, height: 900 });
    await expectNoOverflow(page, 'firewall rules at 390 px');
    await tour(page, 'firewall-hints-390', true);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(page.getByText('You may want to check')).toHaveCount(0);
    // Duplicate: same rules under "(copy)", no servers; the copy is deleted again.
    await page.getByRole('button', { name: 'Duplicate' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${name} (copy)`);
    await expect(page.getByText('5 of 50 rules')).toBeVisible();
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page).toHaveURL(/\/firewalls$/);
    await page.goto('/firewalls');
    const card = page.getByRole('link', { name: new RegExp(name) });
    await expect(card).toContainText('5 inbound · 0 outbound rules');
    await expect(card).toContainText('8000-8100'); // rule pills
    await expect(page.getByText('Protected servers', { exact: true })).toBeVisible(); // summary tiles
    const riskyTile = page.getByRole('button', { name: /Risky firewalls/ });
    await riskyTile.click(); // tiles filter the cards
    await expect(riskyTile).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('No firewall matches this filter.')).toBeVisible();
    await page.getByRole('button', { name: 'Show all' }).click();
    await expect(card).toBeVisible();
    await expect(page.locator('#boot-loader')).toHaveCSS('opacity', '0');
    await tour(page, 'firewalls-list', true);
    await page.setViewportSize({ width: 390, height: 900 });
    await expectNoOverflow(page, 'firewall cards at 390 px');
    await tour(page, 'firewalls-list-390', true);
    await page.setViewportSize({ width: 1280, height: 720 });
    await card.click();
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page).toHaveURL(/\/firewalls$/);
    await expect(page.getByRole('link', { name: new RegExp(name) })).toHaveCount(0);
  });

  test('API: rules in Settings, the reference with its PDF and OpenAPI, a narrowed token, rate headers, the request log and a revoke', async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const csrf = { 'x-lightning-csrf': '1' };
    await signInAdmin(page);
    // Settings → API: a rate limit and the log kept 30 days.
    await page.goto('/admin/settings?tab=api');
    await page.getByRole('textbox', { name: 'Requests per minute' }).fill('120');
    await page.getByRole('textbox', { name: 'Keep for (days)' }).fill('30');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('API settings saved.')).toBeVisible();
    await expect(page.getByText('120 requests per token and minute (2 a second on average).')).toBeVisible();

    // The reference: built from the running API, searchable, with example code.
    await page.getByRole('link', { name: 'Open the reference' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'API reference' })).toBeVisible();
    await expect(page.getByText('120 requests/min')).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search endpoints' }).fill('vmware/scans');
    await expect(page.getByRole('status').filter({ hasText: /^Showing [1-9]\d* of \d+ endpoints$/ })).toBeVisible();
    const scan = page.locator('details#post-admin-vmware-scans');
    await scan.locator('summary').click();
    await expect(scan.getByText('Addresses to scan', { exact: false }).or(scan.getByText('targets', { exact: true })).first()).toBeVisible();
    await expect(scan.getByText(/curl -X POST "\$LVM_URL\/admin\/vmware\/scans"/)).toBeVisible();
    await scan.getByRole('tab', { name: 'Python' }).click();
    await expect(scan.getByText('requests.post(', { exact: false })).toBeVisible();
    // The guide states the rule in force.
    await page.getByRole('link', { name: 'Rate limit' }).click();
    await expect(page.getByText('Each token may make 120 requests per minute', { exact: false })).toBeVisible();
    // PDF and OpenAPI downloads.
    await page.getByRole('searchbox', { name: 'Search endpoints' }).fill('');
    const [pdf] = await Promise.all([page.waitForEvent('download', { timeout: 90_000 }), page.getByRole('button', { name: 'Download PDF' }).click()]);
    expect(pdf.suggestedFilename()).toMatch(/-api-en\.pdf$/);
    const pdfBytes = await (await import('node:fs/promises')).readFile((await pdf.path())!);
    expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdfBytes.length).toBeGreaterThan(100_000);
    const [spec] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'OpenAPI (JSON)' }).click()]);
    const doc = JSON.parse(await (await import('node:fs/promises')).readFile((await spec.path())!, 'utf8'));
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths['/servers/{id}/actions'].post.parameters.some((x: { name: string }) => x.name === 'Idempotency-Key')).toBe(true);
    await page.setViewportSize({ width: 390, height: 900 });
    await tour(page, 'api-docs-390', true);
    await expectNoOverflow(page, 'api reference at 390 px');
    await page.setViewportSize({ width: 1280, height: 900 });
    await tour(page, 'api-docs');

    // A token narrowed to viewing VMware: it may read connections, not users; every answer carries the rate headers.
    const made = await page.request.post('/api/account/api-tokens', { headers: csrf, data: { name: 'e2e narrowed', scope: 'read', expiresInDays: 30, permissions: ['vmware.view'] } });
    expect(made.status()).toBe(201);
    const { token, id } = await made.json();
    const ctx = await (await import('@playwright/test')).request.newContext({ baseURL, ignoreHTTPSErrors: true }); // the address the suite runs against (playwright.config.ts)
    const bearer = { authorization: `Bearer ${token}` };
    const ok = await ctx.get('/api/admin/vmware/connections', { headers: bearer });
    expect(ok.status()).toBe(200);
    expect(ok.headers()['x-ratelimit-limit']).toBe('120');
    expect(Number(ok.headers()['x-ratelimit-remaining'])).toBeLessThan(120);
    const denied = await ctx.get('/api/admin/users', { headers: bearer });
    expect(denied.status()).toBe(403);
    expect((await ctx.post('/api/admin/vmware/scans', { headers: bearer, data: { targets: '10.0.0.1' } })).status()).toBe(403); // read-only
    await ctx.dispose();
    // The administrator sees it in the log and revokes the token.
    await page.goto('/admin/settings?tab=api');
    const log = page.locator('#api-log');
    await log.getByRole('searchbox', { name: 'Search path or route' }).fill('admin/users');
    await expect(log.getByRole('row').filter({ hasText: '403' }).first()).toBeVisible();
    const row = page.locator('#api-tokens').getByRole('row').filter({ hasText: 'e2e narrowed' });
    await expect(row).toContainText('narrowed to 1 permissions');
    await row.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByText('Token revoked.')).toBeVisible();
    const after = await page.request.get('/api/account/api-tokens');
    expect((await after.json()).tokens.some((x: { id: string }) => x.id === id)).toBe(false);
    await page.setViewportSize({ width: 390, height: 900 });
    await expectNoOverflow(page, 'api settings at 390 px');
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  test('monitoring: System shows what the components answer and a switch that asks first; nothing is switched without the confirmation or without the agent', async ({ page }) => {
    await signInAdmin(page);
    const csrf = { 'x-lightning-csrf': '1' };
    const read = async () => (await (await page.request.get('/api/admin/maintenance/monitoring')).json()) as { state: 'on' | 'off' | 'partial'; checks: { id: string; ok: boolean }[]; agent: { installed: boolean; pending: number; busy: boolean } };
    const before = await read();
    expect(before.checks.map((c) => c.id)).toEqual(['prometheus', 'grafana', 'loki']);
    await page.goto('/admin/system');
    const card = page.getByTestId('monitoring-switch');
    await expect(card).toBeVisible();
    for (const name of ['Prometheus', 'Grafana', 'Loki']) await expect(card.getByRole('listitem').filter({ hasText: name })).toBeVisible();
    // The card says what the API says: every component with its answer, and the state in words.
    await expect(card).toContainText({ on: 'All components answer.', off: 'No component answers', partial: 'Some components answer' }[before.state]);
    await expect(card.getByRole('listitem')).toHaveCount(3);
    if (before.state === 'on') await expect(card.getByRole('listitem').filter({ hasText: 'no answer' })).toHaveCount(0);
    if (before.state === 'off') await expect(card.getByRole('listitem').filter({ hasText: 'no answer' })).toHaveCount(3);
    // On or off must be said, whoever asks.
    const vague = await page.request.post('/api/admin/maintenance/requests', { headers: csrf, data: { action: 'monitoring' } });
    expect([vague.status(), (await vague.json()).fields]).toEqual([400, { enabled: 'INVALID_VALUE' }]);
    const off = card.getByRole('button', { name: 'Turn monitoring off' });
    const on = card.getByRole('button', { name: 'Turn monitoring on' });
    const button = before.state === 'off' ? on : off;
    if (!before.agent.installed) {
      // No agent on this server: the card says how to switch instead, the button does nothing, and the API refuses.
      await expect(card.getByText('The server\'s agent is not installed')).toBeVisible();
      await expect(button).toBeDisabled();
      const refused = await page.request.post('/api/admin/maintenance/requests', { headers: csrf, data: { action: 'monitoring', enabled: before.state === 'off' } });
      expect([refused.status(), (await refused.json()).code]).toEqual([409, 'MAINTENANCE_AGENT_MISSING']);
    } else if (await button.isEnabled()) {
      // The switch asks first and says what stops; leaving the dialog sends nothing to the server's agent.
      await button.click();
      const ask = page.getByRole('alertdialog');
      await expect(ask).toContainText(before.state === 'off' ? 'Turn monitoring on?' : 'Turn monitoring off?');
      await expect(ask).toContainText(before.state === 'off' ? 'Nothing else is restarted.' : 'no alert is sent');
      await ask.getByRole('button', { name: 'Cancel' }).click();
      await expect(ask).toBeHidden();
    } else {
      // The agent is busy with another task (this page asks it for the server's updates): the card says so.
      await expect(card.getByText('Another maintenance task')).toBeVisible();
    }
    // Nothing was asked of the agent about monitoring, and monitoring is as it was.
    await expect(page.getByText('Asked the server to turn monitoring')).toHaveCount(0);
    expect((await read()).state).toBe(before.state);
    await page.setViewportSize({ width: 390, height: 844 });
    await card.scrollIntoViewIfNeeded();
    await expectNoOverflow(page, 'System with the monitoring card at 390 px');
    await tour(card, 'system-monitoring-phone');
    await page.emulateMedia({ colorScheme: 'dark' });
    await tour(card, 'system-monitoring-phone-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  test('System: every published version newest first with the running one marked; a finished one-shot job is not a fault; a service opens its detail with what to do, restart that asks first, version and log', async ({ page }) => {
    await signInAdmin(page);
    const csrf = { 'x-lightning-csrf': '1' };
    const answer = (route: import('@playwright/test').Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    // The test stack has no host agent: what the agent would have recorded (its snapshot of the services, the version
    // list it fetched) is a prepared answer of the routes that read it; the rest of each answer is the real one.
    const now = Date.now(), iso = (ago: number) => new Date(now - ago).toISOString();
    const tags = ['v0.5.1', 'v0.5.0', 'v0.4.0', 'v0.3.0', 'v0.2.3', 'v0.2.2', 'v0.2.1', 'v0.2.0', 'v0.1.1', 'v0.1.0'];
    await page.route('**/api/admin/maintenance', async (route) => {
      const real = await (await route.fetch()).json();
      await answer(route, { ...real, releases: { checkedAt: iso(60_000), channel: 'stable', branch: '', current: real.version, commit: 'abc1234', base: 'v0.5.1', latest: 'v0.5.1', updateAvailable: false, error: '', stale: false,
        releases: tags.map((version, i) => ({ version, date: iso((i + 1) * 86_400_000), notes: i === 0 ? '### Fixed\n- **Admin → System** shows every version.' : `${version}: notes`, newer: false, running: false })) } });
    });
    const svc = (over: Record<string, unknown> & { service: string }) => ({ health: '', status: '', cpu: 0.4, memory: '40MiB', memoryPercent: 1, restarts: 0, startedAt: iso(3_600_000), finishedAt: '0001-01-01T00:00:00Z', exitCode: 0,
      restartPolicy: 'unless-stopped', image: '', imageVersion: '', ports: '', managed: 1, oneShot: false, fault: false,
      rule: { restart: true, run: false, refused: '', interrupts: 'none' }, version: { panel: true, version: 'v0.5.1-3-gabc1234', commit: 'abc1234' }, ...over });
    const services = [
      svc({ service: 'api', state: 'running', health: 'healthy', kind: 'healthy', image: 'lightning-vm-api', ports: '4000/tcp', rule: { restart: true, run: false, refused: '', interrupts: 'panel' } }),
      svc({ service: 'migrate', state: 'exited', kind: 'completed', oneShot: true, status: 'Exited (0) 28 minutes ago', finishedAt: iso(28 * 60_000), restartPolicy: 'no', image: 'lightning-vm-migrate', cpu: 0, memory: '',
        rule: { restart: false, run: true, refused: '', interrupts: 'none' } }),
      svc({ service: 'worker', state: 'running', health: 'unhealthy', kind: 'unhealthy', fault: true, restarts: 3, image: 'lightning-vm-worker', rule: { restart: true, run: false, refused: '', interrupts: 'operations' } }),
      svc({ service: 'postgres', state: 'running', health: 'healthy', kind: 'healthy', image: 'postgres:17-alpine', ports: '5432/tcp', version: { panel: false, tag: '17-alpine', label: '', reported: '17.2' },
        rule: { restart: false, run: false, refused: 'SERVICE_PROTECTED', interrupts: 'panel' } }),
      svc({ service: 'grafana', state: 'exited', kind: 'failed', fault: true, exitCode: 1, status: 'Exited (1) 3 minutes ago', finishedAt: iso(180_000), image: 'grafana/grafana:11.6.0', cpu: 0, memory: '',
        version: { panel: false, tag: '11.6.0', label: '', reported: '' } }),
    ];
    await page.route('**/api/admin/host/live', async (route) => {
      const real = await (await route.fetch()).json();
      await answer(route, { ...real, state: { checkedAt: iso(5_000), commit: 'abc1234', services, disks: [], inodesPercent: 3, processes: [], failedUnits: [], addresses: [], network: [], dockerDisk: [], docker: '29.0.0', users: 0 },
        logs: [], agent: { installed: true, busy: false } });
    });
    const lines = ['2026-11-22T19:47:56Z worker ready', '2026-11-22T19:48:01Z {"level":"error","msg":"heartbeat failed","headers":{"authorization":"Bearer [masked]"}}'];
    let detailCalls = 0;
    await page.route('**/api/admin/host/services/*', async (route) => {
      detailCalls++;
      const name = new URL(route.request().url()).pathname.split('/').pop()!;
      const s = services.find((x) => x.service === name)!;
      await answer(route, { checkedAt: iso(5_000), service: s, logs: name === 'worker' ? lines : [], agent: { installed: true, busy: false, status: null, log: [] } });
    });

    await page.goto('/admin/system');
    // ---- the version list: all ten, newest first, the running build's release marked, five shown at first ----
    const list = page.getByTestId('release-list');
    await list.locator('summary').first().click();
    await expect(list.locator('li[data-version]')).toHaveCount(5);
    await expect(list.locator('li[data-version]').first()).toHaveAttribute('data-version', 'v0.5.1');
    await expect(list.locator('li[data-version="v0.5.1"]')).toContainText('Running build is based on this');
    await expect(list.locator('li[data-version="v0.5.1"]')).toContainText('Admin → System shows every version.');
    await list.getByRole('button', { name: 'Show all 10 versions' }).click();
    expect(await list.locator('li[data-version]').evaluateAll((items) => items.map((x) => x.getAttribute('data-version')))).toEqual(tags);
    await list.getByRole('button', { name: 'Show only the newest 5' }).click();
    await expect(list.locator('li[data-version]')).toHaveCount(5);

    // ---- the services: a one-shot job that finished is "Completed", not a warning; faults are named ----
    const box = page.getByTestId('services');
    await expect(box.getByRole('button', { name: /^migrate: Completed/ })).toBeVisible();
    await expect(box.getByRole('button', { name: /^migrate/ })).toContainText('Completed');
    await expect(page.getByText('The service migrate is not running.')).toHaveCount(0);
    await expect(page.getByText('The service grafana is not running.')).toBeVisible();
    await expect(page.getByText('The service worker fails its health check.')).toBeVisible();
    // Versions: the panel's own for what is built with it, the reported one or the image tag for the others.
    await expect(box.getByRole('button', { name: /^api/ })).toContainText('v0.5.1-3-gabc1234');
    await expect(box.getByRole('button', { name: /^postgres/ })).toContainText('17.2');
    await expect(box.getByRole('button', { name: /^grafana/ })).toContainText('11.6.0');

    // ---- the detail of the unhealthy worker: what it means, what to do, the log, and a restart that asks first ----
    await box.getByRole('button', { name: /^worker/ }).click();
    const detail = page.getByTestId('service-detail');
    // Closed with its own button: what Escape reaches depends on where focus came back to after the confirmation.
    const closeDetail = async () => { await detail.getByRole('button', { name: 'Close' }).click(); await expect(detail).toBeHidden(); };
    await expect(detail).toContainText('Unhealthy');
    await expect(detail).toContainText('its health check fails');
    await expect(detail).toContainText('health.mjs');
    await expect(detail).toContainText('worker ready');
    await expect(detail).toContainText('Bearer [masked]');
    await expect(detail).toContainText('lightning-vm-worker');
    await detail.getByRole('button', { name: 'Restart' }).click();
    const ask = page.getByRole('alertdialog');
    await expect(ask).toContainText('Restart worker?');
    await expect(ask).toContainText('Operations that run right now pause');
    await expect(ask).toContainText('audit log');
    // Leaving the dialog sends nothing.
    let asked = 0;
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/admin/maintenance/requests')) asked++; });
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(ask).toBeHidden();
    expect(asked).toBe(0);
    // Focus is back on the Restart button that opened the confirmation, so Escape closes the drawer at once.
    await expect(detail.getByRole('button', { name: 'Restart' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(detail).toBeHidden();

    // A finished one-shot job: completed, with when; run again only because migrate is harmless to run twice.
    await box.getByRole('button', { name: /^migrate/ }).click();
    await expect(detail).toContainText('A one-shot job');
    await expect(detail).toContainText('This is not a fault.');
    await expect(detail.getByRole('button', { name: 'Run again' })).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Restart' })).toHaveCount(0);
    await closeDetail();
    // The database: no restart from the panel, and the sentence why.
    await box.getByRole('button', { name: /^postgres/ }).click();
    await expect(detail.getByTestId('service-refused')).toContainText('docker compose restart postgres');
    await expect(detail.getByRole('button', { name: 'Restart' })).toHaveCount(0);
    await expect(detail).toContainText('17.2');
    await closeDetail();
    expect(detailCalls).toBeGreaterThan(0);

    // The API refuses what the page does not offer, whatever is sent: a name that is not a service, a made-up act.
    for (const [data, code] of [[{ action: 'service', service: 'worker; reboot', act: 'restart' }, 'VALIDATION_FAILED'], [{ action: 'service', service: 'worker', act: 'stop' }, 'VALIDATION_FAILED']] as const) {
      const r = await page.request.post('/api/admin/maintenance/requests', { headers: csrf, data });
      expect([r.status(), (await r.json()).code]).toEqual([400, code]);
    }

    // ---- the charts: pointing shows the value and the time; with reduced motion nothing animates ----
    const chart = page.getByRole('img', { name: 'Processor: last ten minutes' });
    if (await chart.count()) {
      // Measured where it stands still: in the middle of the window, its entrance over.
      await chart.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await settled(page);
      await chart.hover({ position: { x: 20, y: 20 } });
      await expect(chart.locator('xpath=..').getByRole('status')).toContainText('%');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.reload();
      await expect(page.getByRole('img', { name: 'Processor: last ten minutes' })).toBeVisible();
      expect(await page.evaluate(() => document.getAnimations().filter((a) => (a.effect as KeyframeEffect | null)?.target?.closest?.('svg[role="img"]')).length)).toBe(0);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    }

    // ---- a phone's width, both themes: the drawer fits and its text can be read ----
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId('services').getByRole('button', { name: /^worker/ }).click();
    await expect(detail).toContainText('worker ready');
    await expectInside(page, detail.getByRole('button', { name: 'Restart' }), 'the restart button in the drawer at 390 px');
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await settled(page);
      expect(await unreadable(page, '[data-testid="service-detail"]'), `${scheme}: text in the drawer`).toEqual([]);
      await tour(page, `system-service-detail-phone-${scheme}`);
    }
    await closeDetail();
    await page.emulateMedia({ colorScheme: 'light' });
    await expectNoOverflow(page, 'System with services and versions at 390 px');
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  test('API reference: a request is run from the page, shown before it is sent; a change waits for a confirmation; secrets are not shown; permissions hold', async ({ page, browser }) => {
    await signInAdmin(page);
    await page.goto('/api-docs');
    // Opens one route of the reference and returns its "Run this request" part.
    const runner = async (p: Page, find: string, anchorId: string) => {
      await p.getByRole('searchbox', { name: 'Search endpoints' }).fill(find);
      const route = p.locator(`#${anchorId}`);
      await route.locator('summary').click();
      const part = route.getByTestId('try-request');
      await expect(part).toBeVisible();
      return part;
    };
    const projects = async () => ((await (await page.request.get('/api/projects')).json()) as { projects: { id: string; name: string }[] }).projects;

    // A read: the request is on the page before anything is sent, then the answer; the session cookie is never shown.
    let part = await runner(page, '/auth/me', 'get-auth-me');
    await expect(part.getByTestId('try-preview')).toHaveCount(0);
    await part.getByRole('button', { name: 'Try it' }).click();
    await expect(part.getByText('it reads live data')).toBeVisible();
    await expect(part.getByTestId('try-preview')).toHaveText(/^GET \/api\/auth\/me\s+X-Lightning-Try: 1\s+Cookie: your session \(added by the browser, not shown\)$/);
    await expect(part.getByTestId('try-response')).toHaveCount(0);
    await part.getByRole('button', { name: 'Send request' }).click();
    const answer = part.getByTestId('try-response');
    await expect(answer).toContainText('200');
    await expect(answer).toContainText(admin.email);
    await expect(answer).toContainText('content-type');
    // Counted like a token's request: the answer carries the limit of Settings → API.
    await expect(answer).toContainText('x-ratelimit-remaining');
    const cookie = (await page.context().cookies()).find((c) => c.name.endsWith('lvm.session_token'))!.value;
    expect(await page.locator('body').innerText()).not.toContain(cookie.slice(0, 16));

    // A change: broken input is named and cannot be sent; a good request waits for the confirmation that repeats it.
    part = await runner(page, '/projects', 'post-projects');
    await part.getByRole('button', { name: 'Try it' }).click();
    await expect(part.getByText('It is sent only after you confirm it.')).toBeVisible();
    const body = part.getByLabel('Body (JSON)');
    await expect(body).toHaveValue(/"name"/);
    await body.fill('{oops');
    await expect(part.getByTestId('try-problems')).toContainText('The body is not valid JSON.');
    await expect(part.getByRole('button', { name: 'Send request' })).toBeDisabled();
    // The name is shaped like an API token: the API echoes it, the page must not.
    const secretLike = `lvm_e2e${'x'.repeat(24)}`;
    await body.fill(JSON.stringify({ name: secretLike }));
    await expect(part.getByTestId('try-preview')).toContainText('POST /api/projects');
    await expect(part.getByTestId('try-preview')).toContainText('X-Lightning-CSRF: 1');
    await part.getByRole('button', { name: 'Send request' }).click();
    const ask = page.getByRole('alertdialog');
    await expect(ask).toContainText('Send this POST request?');
    await expect(ask).toContainText('POST /api/projects');
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(ask).toBeHidden();
    await expect(part.getByTestId('try-response')).toHaveCount(0);
    expect((await projects()).some((p) => p.name === secretLike), 'nothing was sent without the confirmation').toBe(false);
    await part.getByRole('button', { name: 'Send request' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Send POST' }).click();
    await expect(part.getByTestId('try-response')).toContainText('201');
    await expect(part.getByTestId('try-response')).toContainText('•••••• (hidden)');
    await expect(part.getByTestId('try-response')).toContainText('1 value that looks like a secret is hidden.');
    await expect(part.getByTestId('try-response')).not.toContainText(secretLike);
    const made = (await projects()).find((p) => p.name === secretLike);
    expect(made, 'the confirmed request was really sent').toBeTruthy();
    // A phone: the open runner with its answer fits, in the dark theme too.
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoOverflow(page, 'API reference with an answer at 390 px');
    await tour(part, 'api-docs-try-phone');
    await page.emulateMedia({ colorScheme: 'dark' });
    await tour(part, 'api-docs-try-phone-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 1280, height: 900 });

    // A path value stays inside its route: what is typed is one encoded segment, never another address.
    part = await runner(page, '/projects', 'delete-projects-id');
    await part.getByRole('button', { name: 'Try it' }).click();
    await expect(part.getByTestId('try-problems')).toContainText('Fill in “id”.');
    await expect(part.getByRole('button', { name: 'Send request' })).toBeDisabled();
    await part.getByLabel('id', { exact: true }).fill('../../admin/users');
    await expect(part.getByTestId('try-preview')).toContainText('DELETE /api/projects/..%2F..%2Fadmin%2Fusers');
    await part.getByLabel('id', { exact: true }).fill(made!.id);
    await expect(part.getByTestId('try-preview')).toContainText(`DELETE /api/projects/${made!.id}`);
    await part.getByRole('button', { name: 'Send request' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Send DELETE' }).click();
    await expect(part.getByTestId('try-response')).toContainText('204');
    await expect(part.getByTestId('try-response')).toContainText('No body.');
    expect((await projects()).some((p) => p.id === made!.id)).toBe(false);

    // A route that hands out a secret is not run from here at all.
    part = await runner(page, '/account/api-tokens', 'post-account-api-tokens');
    await expect(part).toContainText('this route hands out or changes secrets');
    await expect(part.getByRole('button', { name: 'Try it' })).toHaveCount(0);

    // A customer: what the account may not call is not offered, and what it may call answers as it does everywhere.
    const customer = await (await browser.newContext({ locale: 'en-US' })).newPage();
    try {
      await customer.goto('/register');
      await customer.getByLabel('Email').fill(`runner-${Date.now()}@example.test`);
      await customer.getByLabel('Password').fill('e2e runner passphrase 2026');
      await customer.getByRole('button', { name: 'Create account' }).click();
      await expect(customer).toHaveURL(/\/$/);
      await customer.goto('/api-docs');
      // The page lists only what the account can use; with that filter off the staff routes show, locked.
      await customer.getByRole('searchbox', { name: 'Search endpoints' }).fill('/admin/users');
      await expect(customer.locator('#get-admin-users')).toHaveCount(0);
      const onlyMine = customer.getByRole('switch', { name: 'Only those I can use' });
      await tick(onlyMine);
      await expect(onlyMine).not.toBeChecked();
      let own = await runner(customer, '/admin/users', 'get-admin-users');
      await expect(own).toContainText('your account does not have the permission this route needs');
      await expect(own.getByRole('button', { name: 'Try it' })).toHaveCount(0);
      own = await runner(customer, '/servers', 'get-servers');
      await own.getByRole('button', { name: 'Try it' }).click();
      await own.getByRole('button', { name: 'Send request' }).click();
      await expect(own.getByTestId('try-response')).toContainText('200');
      await expect(own.getByTestId('try-response')).toContainText('"servers": []');
    } finally { await customer.context().close(); }
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
    // Stripe: the dialog shows the webhook address to enter at Stripe, the events to send, and where its secret goes.
    await page.getByLabel('Search providers').fill('stripe');
    await page.getByRole('button', { name: /Stripe/ }).last().click();
    const hook = page.getByRole('dialog').getByTestId('provider-webhook');
    await expect(hook).toContainText(`${new URL(page.url()).origin}/api/billing/callback/stripe`);
    await expect(hook).toContainText('payment_intent.succeeded');
    await expect(hook).toContainText('checkout.session.expired');
    await expect(hook).toContainText('Webhook signing secret');
    await expect(hook.getByRole('button', { name: 'Copy address' })).toBeVisible();
    await expect(page.getByRole('dialog').getByLabel('Webhook signing secret (whsec_...)')).toHaveValue('');
    await page.setViewportSize({ width: 390, height: 844 });
    await expectInside(page, hook, 'the webhook address at 390 px');
    await tour(hook, 'payments-stripe-webhook-phone');
    await page.setViewportSize({ width: 1280, height: 720 });
    // The address answers, and refuses what Stripe did not sign: no secret is saved here, so it is not there at all.
    const unsigned = await page.request.post('/api/billing/callback/stripe', { data: { id: 'evt_e2e', type: 'payment_intent.succeeded' } });
    expect([unsigned.status(), (await unsigned.json()).code]).toEqual([404, 'WEBHOOK_NOT_CONFIGURED']);
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();
  });

  test('billing: an invoice awaits payment, a declined card keeps it awaiting, a good one pays it; staff see it all', async ({ page }) => {
    test.setTimeout(240_000);
    const shot = async (name: string) => tour(page, name, true);
    const csrf = { 'x-lightning-csrf': '1' };
    await signInAdmin(page);
    // Settings → Billing: turned on with the seller and the sandbox provider.
    await page.goto('/admin/settings?tab=billing');
    await expect(page.getByText('Billing on', { exact: true }).first()).toBeVisible();
    // How long a payment under review holds its invoice: seven days unless the admin says otherwise.
    await expect(page.getByRole('textbox', { name: 'Days a payment awaiting review holds its invoice' })).toHaveValue('7');
    await expect(page.getByText('While a payment is awaiting review, suspension, deletion and reminders wait for at most this long, and a second payment is refused for that time. 0 turns it off.')).toBeVisible();
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
    const made = await page.request.post('/api/admin/billing/invoices', { headers: csrf, data: { userId: me.id, currency: 'TRY', lines: [{ description: 'Kurulum hizmeti', unitPrice: '250', quantity: 1 }], dueDays: 3 } });
    expect(made.ok()).toBe(true);
    const { invoiceId } = await made.json();
    // My servers greets with the unpaid invoice, which links to billing.
    await page.goto('/');
    await expect(page.getByRole('region', { name: 'Welcome' }).getByRole('link', { name: /1 unpaid invoice/ })).toBeVisible();
    // "Upcoming charges" on the same page: the invoice falls due this week (the end of the third day from now), so
    // it is listed with what is owed and its own way to pay.
    const upcoming = page.getByRole('region', { name: 'Upcoming charges' });
    const invoiceRef = `#${invoiceId.slice(0, 8).toUpperCase()}`;
    await expect(upcoming.getByText(new RegExp(`^${invoiceRef} · due in \\d+ days$`))).toBeVisible();
    await expect(upcoming).toContainText('300');
    await expect(upcoming.getByRole('link', { name: `Pay invoice ${invoiceRef}`, exact: true })).toHaveAttribute('href', `/billing/invoices/${invoiceId}`);
    await page.waitForTimeout(400);
    await shot('upcoming-charges');
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoOverflow(page, 'upcoming charges at 390 px');
    // The monthly budget keeps its action on a phone.
    await expectInside(page, page.getByRole('button', { name: 'Set a budget', exact: true }), '"Set a budget" at 390 px');
    await shot('upcoming-charges-390');
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/billing');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Billing');
    await expect(page.getByText('Your invoice details are missing')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Billing', exact: true }).first()).toBeVisible();
    await page.waitForTimeout(600);
    await shot('billing-customer');
    // The command palette finds the invoice (staff: through the admin list's search, here by the buyer's e-mail) and opens it.
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: 'Command palette' }).fill(me.email);
    const foundInvoice = page.getByRole('option', { name: new RegExp(`#${invoiceId.slice(0, 8).toUpperCase()}`) });
    await expect(foundInvoice).toBeVisible();
    await foundInvoice.click();
    await expect(page).toHaveURL(new RegExp(`/admin/billing/invoices/${invoiceId}$`));
    // The palette also starts things: its quick actions offer a balance top-up and a new ticket, and open them.
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: 'Command palette' }).fill('top up');
    await expect(page.getByRole('option', { name: 'Top up balance' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Command palette' }).fill('new support ticket');
    const newTicket = page.getByRole('option', { name: 'Open a new support ticket' });
    await expect(newTicket).toBeVisible();
    await newTicket.click();
    await expect(page).toHaveURL(/\/support\?new=1$/);
    await expect(page.getByLabel('Subject')).toBeVisible();
    await page.goto('/billing');
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
    // On a phone every figure of a line is whole on the screen, under the line's name (no table cut off at the edge);
    // the tax rate is written the English way.
    const lineCells = page.getByRole('article').locator('tbody td');
    await expectInside(page, lineCells, 'invoice line figures at 390 px');
    await expect(lineCells.filter({ hasText: /^20%$/ }).first()).toBeVisible();
    await expect(page.getByRole('article').getByText('%20')).toHaveCount(0);
    await shot('billing-invoice-390');
    await page.goto('/billing');
    await expectNoOverflow(page, 'billing at 390 px');
    await expect(page.getByText('Balance', { exact: true }).first()).toBeVisible();
    await page.waitForTimeout(900);
    await shot('billing-customer-390');
    await page.setViewportSize({ width: 1280, height: 720 });
    // Paid, nothing else is coming up: with billing still on, the first page has no "Upcoming charges" block at all.
    const summaryRead = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/billing/summary' && r.ok());
    await page.goto('/');
    expect((await (await summaryRead).json() as { enabled: boolean; open: { n: number } }).open.n).toBe(0);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your servers');
    await expect(page.getByRole('region', { name: 'Upcoming charges' })).toHaveCount(0);
    await expect(page.getByText('Upcoming charges')).toHaveCount(0);
    await page.goto('/billing');
    // The paid invoice shows in this month's bar; the list counts per filter and downloads as CSV.
    await page.reload();
    const spend = page.getByRole('list', { name: 'Paid in the last 12 months' });
    await expect(spend).toContainText('300');
    await expect(page.getByRole('group', { name: 'Show', exact: true }).getByRole('button', { name: /^Settled\s*\d+$/ })).toBeVisible();
    const [csvFile] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download CSV' }).click()]);
    expect(csvFile.suggestedFilename()).toMatch(/^invoices-\d{4}-\d{2}-\d{2}\.csv$/);
    await page.waitForTimeout(400);
    await shot('billing-spend');
    // Staff: revenue, the invoice with its two payments, and the actions on it.
    await page.goto('/admin/billing');
    await expect(page.getByText('Monthly recurring revenue')).toBeVisible();
    await expect(page.getByRole('grid', { name: 'Invoices' })).toContainText('Admin Example');
    await page.waitForTimeout(900);
    await shot('billing-admin');
    // Each number tile opens the list behind it; running collection by hand asks first.
    await page.getByRole('link', { name: /Overdue/ }).click();
    await expect(page).toHaveURL(/status=overdue/);
    await expect(page.getByRole('button', { name: 'Clear filters' }).first()).toBeVisible();
    await page.goto('/admin/billing');
    await page.getByRole('button', { name: 'Run collection now' }).click();
    await expect(page.getByRole('alertdialog').filter({ hasText: 'Run collection now?' })).toBeVisible();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
    const [invCsv] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download CSV' }).click()]);
    expect(invCsv.suggestedFilename()).toMatch(/^invoices-/);
    await page.getByRole('tab', { name: 'Payments' }).click();
    await expect(page.getByRole('grid', { name: 'Payments' }).getByText('Failed', { exact: true }).first()).toBeVisible();
    await page.waitForTimeout(400);
    await shot('billing-admin-payments');
    // Payments awaiting review: the filter is offered, and with nothing waiting the list says what would appear
    // here. The filter and the search land in the address and are still there after a reload.
    await choose(page, page, /Status/, 'Awaiting review');
    await expect(page).toHaveURL(/status=review/);
    await expect(page.getByRole('grid', { name: 'Payments' }).getByText('No payments are awaiting review')).toBeVisible();
    const paymentSearch = page.getByRole('searchbox', { name: 'Invoice number, e-mail or provider reference' });
    await paymentSearch.fill('no-such-reference');
    await expect(page).toHaveURL(/q=no-such-reference/);
    await expect(page.getByRole('grid', { name: 'Payments' }).getByText('No payments match the search')).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(/tab=payments/);
    await expect(page).toHaveURL(/status=review/);
    await expect(page).toHaveURL(/q=no-such-reference/);
    await expect(paymentSearch).toHaveValue('no-such-reference');
    await expect(page.getByRole('button', { name: /Status/ })).toContainText('Awaiting review');
    await expect(page.getByRole('grid', { name: 'Payments' }).getByText('No payments match the search')).toBeVisible();
    await paymentSearch.fill('');
    await expect(page).not.toHaveURL(/q=/);
    await expect(page.getByRole('grid', { name: 'Payments' }).getByText('No payments are awaiting review')).toBeVisible();
    // A payment the provider holds, for real: a second invoice (the first one stays as it is for the refund below),
    // paid on the sandbox page with the test card that is held for review. The customer's invoice keeps awaiting
    // payment and says the payment is under review, without "checking" for an answer that will not come by itself.
    const heldMade = await page.request.post('/api/admin/billing/invoices', { headers: csrf, data: { userId: me.id, currency: 'TRY', lines: [{ description: 'Yedekleme hizmeti', unitPrice: '100', quantity: 1 }], dueDays: 7 } });
    expect(heldMade.ok()).toBe(true);
    const heldId = (await heldMade.json() as { invoiceId: string }).invoiceId;
    const heldRef = `#${heldId.slice(0, 8).toUpperCase()}`;
    await page.goto(`/billing/invoices/${heldId}`);
    await expect(page.getByText('Pro forma · awaiting payment')).toBeVisible();
    await page.getByRole('button', { name: /Sandbox/ }).click();
    await expect(page).toHaveURL(/\/billing\/checkout\//);
    await expect(page.getByText('held for review (waits for staff)')).toBeVisible();
    await page.getByLabel('Card number').fill('4000 0000 0000 4954');
    await page.getByRole('button', { name: 'Pay', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/billing/invoices/${heldId}`));
    await expect(page.getByText('Your payment is awaiting review')).toBeVisible();
    await expect(page.getByText('The payment provider is reviewing the payment.')).toBeVisible();
    await expect(page.getByText('Pro forma · awaiting payment')).toBeVisible();
    await expect(page.getByText('Awaiting payment', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Checking the payment…')).toHaveCount(0);
    // No second payment while this one waits for staff (it could take the money twice): the pay buttons are off and
    // say why, and the API refuses one that is sent anyway.
    await expect(page.getByText('A payment for this invoice is awaiting review, so it cannot be paid again for now.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Sandbox/ })).toBeDisabled();
    const second = await page.request.post(`/api/billing/invoices/${heldId}/pay`, { headers: csrf, data: { method: 'card', provider: 'sandbox' } });
    expect([second.status(), (await second.json() as { code: string }).code]).toEqual([409, 'PAYMENT_IN_REVIEW']);
    await page.waitForTimeout(400);
    await shot('billing-invoice-review');
    // Staff: the menu's Billing entry says that one payment awaits review, and the overview's notice leads to the
    // list filtered to those.
    await page.goto('/admin/billing');
    const billingEntry = page.getByRole('navigation', { name: 'Main navigation' }).locator('a[href="/admin/billing"]');
    await expect(billingEntry).toHaveAccessibleName(/^Billing\s*,\s*1 payment awaiting review$/);
    const reviewNotice = page.getByRole('link', { name: /1 payment is awaiting review/ });
    await expect(reviewNotice).toHaveAttribute('href', '/admin/billing?tab=payments&status=review');
    await reviewNotice.click();
    await expect(page).toHaveURL(/tab=payments/);
    await expect(page).toHaveURL(/status=review/);
    // The row (in the table: the list for narrow screens carries the same text) has the review label, why it is
    // held, the way to the invoice and the way to close the review without settling anything.
    const paymentGrid = page.getByRole('grid', { name: 'Payments' });
    const heldRow = paymentGrid.getByRole('row').filter({ hasText: heldRef });
    await expect(heldRow).toHaveCount(1);
    await expect(heldRow.getByText('Awaiting review', { exact: true })).toBeVisible();
    await expect(heldRow.getByText('The provider is holding the payment for a fraud review.')).toBeVisible();
    await expect(heldRow.getByRole('link', { name: /Open invoice/ })).toHaveAttribute('href', `/admin/billing/invoices/${heldId}`);
    const closeReview = heldRow.getByRole('button', { name: /Close review/ });
    await expect(closeReview).toBeVisible();
    await page.waitForTimeout(400);
    await shot('billing-admin-review');
    // Closing asks first and says what it does not do; the reason typed is kept with the payment.
    await closeReview.click();
    const closing = page.getByRole('alertdialog');
    await expect(closing).toContainText('Close the review of this payment?');
    await expect(closing).toContainText('is closed without marking the invoice paid');
    await closing.getByLabel('Why it is closed (optional)').fill('No collection at the provider');
    await page.waitForTimeout(300);
    await shot('billing-admin-close-review');
    await closing.getByRole('button', { name: 'Close review', exact: true }).click();
    await expect(page.getByText('Review closed; the invoice was not marked paid.')).toBeVisible();
    // The row leaves the review list, and the menu's badge goes with it.
    await expect(paymentGrid.getByText('No payments are awaiting review')).toBeVisible();
    await expect(paymentGrid.getByRole('row').filter({ hasText: heldRef })).toHaveCount(0);
    await expect(billingEntry).toHaveAccessibleName(/^Billing$/);
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByText(/awaiting review/)).toHaveCount(0);
    await expect(page.getByRole('link', { name: /awaiting review/ })).toHaveCount(0);
    // It is found again under "Cancelled", with the reason it was held and how staff decided.
    await choose(page, page, /Status/, 'Cancelled');
    await expect(page).toHaveURL(/status=cancelled/);
    const closedRow = paymentGrid.getByRole('row').filter({ hasText: heldRef });
    await expect(closedRow).toContainText('Cancelled');
    await expect(closedRow).toContainText('Closed by staff without settling: No collection at the provider');
    await expect(closedRow.getByRole('button', { name: /Close review/ })).toHaveCount(0);
    // Nothing was settled: the invoice still awaits payment.
    type HeldInvoice = { invoice: { status: string; total: string; paidTotal: string }; payments: { status: string; method: string; errorCode: string | null }[] };
    const heldInvoice = await (await page.request.get(`/api/admin/billing/invoices/${heldId}`)).json() as HeldInvoice;
    expect(heldInvoice.invoice.status).toBe('unpaid');
    expect(Number(heldInvoice.invoice.paidTotal)).toBe(0);
    expect(heldInvoice.payments.map((p) => [p.status, p.errorCode])).toEqual([['cancelled', 'FRAUD_REVIEW']]);
    // The other way a held payment ends: the money did arrive (a bank transfer, say) and staff record it on the
    // invoice. The customer pays with the held card once more, so a payment is under review again...
    // (The first review is closed, so the invoice can be paid again: no note, and the button is on.)
    await page.goto(`/billing/invoices/${heldId}`);
    await expect(page.getByRole('button', { name: /Sandbox/ })).toBeEnabled();
    await expect(page.getByText('A payment for this invoice is awaiting review, so it cannot be paid again for now.')).toHaveCount(0);
    await page.getByRole('button', { name: /Sandbox/ }).click();
    await expect(page).toHaveURL(/\/billing\/checkout\//);
    await page.getByLabel('Card number').fill('4000 0000 0000 4954');
    await page.getByRole('button', { name: 'Pay', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/billing/invoices/${heldId}`));
    await expect(page.getByText('Your payment is awaiting review')).toBeVisible();
    // ...and staff open the invoice from the review list and record the payment. The dialog says what is recorded;
    // the answer says that the payment which waited for review was closed with it.
    await page.goto('/admin/billing?tab=payments&status=review');
    await expect(billingEntry).toHaveAccessibleName(/^Billing\s*,\s*1 payment awaiting review$/);
    const heldAgain = paymentGrid.getByRole('row').filter({ hasText: heldRef });
    await expect(heldAgain).toHaveCount(1);
    await heldAgain.getByRole('link', { name: /Open invoice/ }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/billing/invoices/${heldId}$`));
    await page.getByRole('button', { name: 'Record a payment', exact: true }).click();
    const recording = page.getByRole('dialog', { name: 'Record a payment' });
    await expect(recording).toContainText('For money that arrived outside the panel');
    await expect(recording).toContainText('120');
    await expect(recording.getByRole('button', { name: /Method/ })).toContainText('Bank transfer');
    await recording.getByLabel('Reference').fill('EFT 2026-11-19 / 000123');
    await page.waitForTimeout(300);
    await shot('billing-admin-record-payment');
    await recording.getByRole('button', { name: 'Record', exact: true }).click();
    await expect(page.getByText('Payment recorded; the invoice is issued. 1 payment awaiting review was closed.')).toBeVisible();
    await expect(recording).toBeHidden();
    await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record a payment', exact: true })).toHaveCount(0);
    // Nothing waits for review any more: the menu's badge is gone and the review list is empty.
    await expect(billingEntry).toHaveAccessibleName(/^Billing$/);
    expect(((await (await page.request.get('/api/admin/attention')).json()) as { paymentsInReview?: number }).paymentsInReview).toBe(0);
    await page.goto('/admin/billing?tab=payments&status=review');
    await expect(paymentGrid.getByText('No payments are awaiting review')).toBeVisible();
    // The invoice is paid in full by the recorded payment alone; neither card payment collected anything.
    const settled = await (await page.request.get(`/api/admin/billing/invoices/${heldId}`)).json() as HeldInvoice;
    expect(settled.invoice.status).toBe('paid');
    expect(Number(settled.invoice.paidTotal)).toBe(Number(settled.invoice.total));
    expect(settled.payments.filter((p) => p.status === 'succeeded').map((p) => p.method)).toEqual(['bank_transfer']);
    expect(settled.payments.filter((p) => p.errorCode === 'FRAUD_REVIEW').map((p) => p.status)).toEqual(['cancelled', 'cancelled']);
    expect(settled.payments.some((p) => p.status === 'pending')).toBe(false);
    // The customer's page of the invoice no longer says "under review".
    await page.goto(`/billing/invoices/${heldId}`);
    await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Your payment is awaiting review')).toHaveCount(0);
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
    // "Upcoming charges", the two lines no invoice stands behind. Both from real state on the simulator's capacity
    // (the catalog test set it up; without the simulator there is nothing to order from): a server paid by the hour
    // from a small balance, then something that renews monthly.
    if (process.env.E2E_VCSIM_HOST) {
      const upcomingNow = page.getByRole('region', { name: 'Upcoming charges' });
      const money = (v: number | string, currency: string, digits = 2) => new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: digits }).format(Number(v));
      type Summary = { hourly: { servers: { id: string }[]; available: { currency: string; amount: string; perHour: string }[] };
        nextRenewal: { at: string; amount: string | number; currency: string; gross: boolean; servers: number; invoiced: boolean } | null; subscriptions: { description: string }[] };
      const summary = async () => (await (await page.request.get('/api/billing/summary')).json()) as Summary;
      const key = (name: string) => ({ ...csrf, 'idempotency-key': `e2e-${name}-${Date.now()}` });
      // Pay as you go is switched on, the account gets 0.20 EUR, and the smallest package is ordered by the hour.
      expect((await page.request.put('/api/admin/settings/billing', { headers: csrf, data: { hourly: true, balance: true, hourlyMinHours: 1 } })).ok()).toBe(true);
      expect((await page.request.post('/api/admin/billing/balance', { headers: csrf, data: { userId: me.id, currency: 'EUR', amount: '0.20', note: 'E2E: pay as you go' } })).status()).toBe(201);
      const offered = await (await page.request.get('/api/catalog')).json() as { packages: { id: string; name: string; currency: string; poolIds: string[]; imageIds: string[] }[] };
      const tiny = offered.packages.find((x) => x.name.includes('E2E Tiny'))!;
      expect(tiny.currency.trim()).toBe('EUR');
      const keys = (await (await page.request.get('/api/ssh-keys')).json() as { keys: { id: string }[] }).keys;
      const sshKey = keys[0]?.id ?? (await (await page.request.post('/api/ssh-keys', { headers: csrf,
        data: { name: 'e2e-hourly', publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMa0iBTtZu9kbSNXzg5M6pZ1rn8F1143iWq3JIcGimfn e2e' } })).json() as { id: string }).id;
      expect(sshKey).toBeTruthy();
      const ordered = await page.request.post('/api/servers', { headers: key('hourly'),
        data: { type: 'package', poolId: tiny.poolIds[0], packageId: tiny.id, imageId: tiny.imageIds[0], name: 'e2e-hourly', sshKeyIds: [sshKey], billingCycle: 'hourly' } });
      expect(ordered.status(), await ordered.text()).toBe(202);
      const hourlyId = (await ordered.json() as { serverId: string }).serverId;
      const paygo = (await summary()).hourly;
      expect(paygo.servers.map((x) => x.id)).toEqual([hourlyId]);
      const [left] = paygo.available;
      expect(left.currency).toBe('EUR');
      expect(Number(left.perHour)).toBeGreaterThan(0);
      // Under three days of running left: the line warns, says the rate and when the balance ends, and offers a
      // top-up of about a week's worth (at least 1).
      expect(Number(left.amount) / Number(left.perHour)).toBeLessThan(72);
      await page.goto('/');
      await expect(upcomingNow.getByText(/^Hourly usage: at this rate the balance runs out (in \d+ (hours|days)|tomorrow)$/)).toBeVisible();
      const hourlyLine = upcomingNow.getByRole('listitem').filter({ hasText: 'Hourly usage' });
      await expect(hourlyLine).toContainText(`${money(left.perHour, 'EUR', 4)} per hour`);
      await expect(hourlyLine).toContainText(money(left.amount, 'EUR'));
      await expect(hourlyLine.getByRole('link', { name: 'Top up' })).toHaveAttribute('href', `/billing?tab=balance&topup=${Math.max(1, Math.ceil(Number(left.perHour) * 168))}`);
      await expect(upcomingNow.getByText(/^Renews on /)).toHaveCount(0);
      await page.waitForTimeout(400);
      await shot('upcoming-charges-hourly');
      await page.setViewportSize({ width: 390, height: 844 });
      await expectNoOverflow(page, 'upcoming charges with hourly usage at 390 px');
      await page.setViewportSize({ width: 1280, height: 720 });
      // The server goes again as soon as it is built (the pool is small and later tests size themselves by what is left).
      const stateOf = async () => { const r = await page.request.get(`/api/servers/${hourlyId}`); return r.ok() ? ((await r.json()) as { server: { state: string } }).server.state : 'gone'; };
      await expect.poll(stateOf, { timeout: 120_000, intervals: [2_000] }).toBe('ready');
      const removed = await page.request.delete(`/api/servers/${hourlyId}`, { headers: key('hourly-delete'), data: { confirm: 'e2e-hourly', now: true } });
      expect(removed.status(), await removed.text()).toBe(202);
      await expect.poll(stateOf, { timeout: 120_000, intervals: [2_000] }).toMatch(/^(deleted|gone)$/);
      expect((await summary()).hourly.servers).toEqual([]);

      // A renewal: a virtual data center with a monthly price, which the collection run takes under a subscription.
      const room = ((await (await page.request.get('/api/admin/pools')).json()).pools as { id: string; capacity: { available: { memoryMb: number } } }[])
        .toSorted((x, y) => y.capacity.available.memoryMb - x.capacity.available.memoryMb)[0];
      const vdcMade = await page.request.post('/api/admin/vdcs', { headers: csrf, data: { name: 'E2E Renewal', ownerId: me.id, poolId: room.id, vcpu: 1, memoryMb: 512, diskGb: 10, maxServers: 1, priceMonthly: '50', currency: 'TRY' } });
      expect(vdcMade.status(), await vdcMade.text()).toBe(201);
      const ran = await page.request.post('/api/admin/billing/run', { headers: csrf, data: {} });
      expect(ran.status(), await ran.text()).toBe(200);
      expect((await ran.json() as { adopted: number }).adopted).toBeGreaterThanOrEqual(1);
      const renewal = (await summary()).nextRenewal!;
      expect(renewal).toBeTruthy();
      expect([renewal.currency, renewal.invoiced]).toEqual(['TRY', false]);
      // About a month away, nothing invoiced yet: the line gives the day, what will be charged as the API works it
      // out (with tax when the buyer's tax is known) and what renews.
      expect(Date.parse(renewal.at) - Date.now()).toBeGreaterThan(26 * 86_400_000);
      await page.goto('/');
      await expect(upcomingNow.getByText(/^Renews on [A-Z][a-z]{2} \d{1,2}, \d{4} \((in \d+ (days|weeks)|next month|in 1 month)\)$/)).toBeVisible();
      const renewalLine = upcomingNow.getByRole('listitem').filter({ hasText: 'Renews on' });
      await expect(renewalLine).toContainText(money(renewal.amount, 'TRY'));
      expect(Number(renewal.amount)).toBe(renewal.gross ? 60 : 50);
      if (renewal.gross) await expect(renewalLine).toContainText('incl. tax');
      await expect(renewalLine).toContainText('E2E Renewal');
      await expect(upcomingNow.getByText(/Hourly usage/)).toHaveCount(0);
      await page.waitForTimeout(400);
      await shot('upcoming-charges-renewal');
      await page.setViewportSize({ width: 390, height: 844 });
      await expectNoOverflow(page, 'upcoming charges with a renewal at 390 px');
      await page.setViewportSize({ width: 1280, height: 720 });
      const vdcId = ((await (await page.request.get('/api/admin/vdcs')).json()).vdcs as { id: string; name: string }[]).find((x) => x.name === 'E2E Renewal')!.id;
      expect((await page.request.delete(`/api/admin/vdcs/${vdcId}`, { headers: csrf })).status()).toBe(204);
    }
    // Off again for the rest of the suite.
    expect((await page.request.put('/api/admin/settings/billing', { headers: csrf, data: { enabled: false, sandbox: false, hourly: false } })).ok()).toBe(true);
  });

  test('Quotas: a user is found by typing, the form starts from the default, the row is edited and removed', async ({ page }) => {
    await signInAdmin(page);
    await page.goto('/admin/catalog?tab=quotas');
    await page.getByRole('button', { name: 'Set quota' }).click();
    const dialog = page.getByRole('dialog');
    await pick(page, dialog.getByRole('combobox', { name: 'Scope' }), 'admin@', 'admin@example.test', true);
    await expect(dialog.getByText('no quota of their own yet')).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Maximum servers' }).fill('7');
    await dialog.getByRole('button', { name: 'Save quota' }).click();
    await expect(dialog).toBeHidden();
    const row = page.getByRole('row', { name: /admin@example\.test/ });
    await expect(row).toContainText('7');
    // Editing opens on that user, with their own values.
    await row.getByRole('button', { name: 'Edit the quota of admin@example.test' }).click();
    await expect(dialog.getByText('already has a quota of their own')).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Maximum servers' })).toHaveValue('7');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    // Removing asks first and puts them back on the default.
    await row.getByRole('button', { name: 'Remove the quota of admin@example.test' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove quota' }).click();
    await expect(page.getByRole('row', { name: /admin@example\.test/ })).toHaveCount(0);
  });

  test('project quotas: staff give a project its own quota; its owner sees the use of it on the project and on the order page, and an order over it is refused', async ({ page, browser }) => {
    await signInAdmin(page);
    const csrf = { 'x-lightning-csrf': '1' };
    const owner = { email: `quota-${Date.now()}@example.test`, password: 'e2e quota passphrase 2026' };
    const customer = await (await browser.newContext({ locale: 'en-US' })).newPage();
    try {
      // A customer with a project.
      await customer.goto('/register');
      await customer.getByLabel('Email').fill(owner.email);
      await customer.getByLabel('Password').fill(owner.password);
      await customer.getByRole('button', { name: 'Create account' }).click();
      await expect(customer).toHaveURL(/\/$/);
      await customer.goto('/account?tab=projects');
      await customer.getByLabel('Project name').fill('Quota lab');
      await customer.getByRole('button', { name: 'Create project' }).click();
      await expect(customer.getByText('Project created.').first()).toBeVisible();
      await expect(customer.getByText('Project quota:')).toHaveCount(0);

      // Staff: Catalog → Quotas → the project is found by its name, and its form says where the numbers start from.
      await page.goto('/admin/catalog?tab=quotas');
      await page.getByRole('button', { name: 'Set quota' }).click();
      const dialog = page.getByRole('dialog');
      await pick(page, dialog.getByRole('combobox', { name: 'Scope' }), 'Quota lab', `Quota lab (project of ${owner.email})`);
      await expect(dialog.getByText('This project has no quota of its own yet')).toBeVisible();
      await expect(dialog.getByText('A project quota replaces its owner\'s quota')).toBeVisible();
      await dialog.getByRole('textbox', { name: 'Maximum servers' }).fill('1');
      await dialog.getByRole('textbox', { name: 'Maximum vCPU' }).fill('0');
      await dialog.getByRole('button', { name: 'Save quota' }).click();
      await expect(dialog).toBeHidden();
      const row = page.getByRole('row', { name: /Quota lab/ });
      await expect(row).toContainText(owner.email);
      await expect(row).toContainText('Project');
      await expect(row).toContainText('0 / 1');
      // Editing opens on that project, with its own values.
      await row.getByRole('button', { name: `Edit the quota of Quota lab (project of ${owner.email})` }).click();
      await expect(dialog.getByText('This project already has a quota of its own')).toBeVisible();
      await expect(dialog.getByRole('textbox', { name: 'Maximum servers' })).toHaveValue('1');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      await page.setViewportSize({ width: 390, height: 844 });
      await expectNoOverflow(page, 'quotas with a project row at 390 px');
      await page.setViewportSize({ width: 1280, height: 720 });

      // The owner: the project carries its quota and what is used of it.
      await customer.goto('/account?tab=projects');
      await expect(customer.getByText('Project quota:')).toBeVisible();
      await expect(customer.getByText('0 of 1 servers · 0 of 0 vCPU')).toBeVisible();
      // The order page, with a package of the catalog: without the project the account's quota is shown and fits.
      const catalog = await (await customer.request.get('/api/catalog')).json() as { packages: { id: string; poolIds: string[]; imageIds: string[] }[]; images: { id: string; poolIds?: string[] }[] };
      const pkg = catalog.packages.find((p) => p.poolIds.length)!;
      const image = catalog.images.find((i) => (!pkg.imageIds.length || pkg.imageIds.includes(i.id)) && (!i.poolIds || i.poolIds.includes(pkg.poolIds[0])))!;
      expect(pkg && image, 'the catalog offers a package with an image').toBeTruthy();
      await customer.goto(`/order?loc=${pkg.poolIds[0]}&pkg=${pkg.id}&image=${image.id}`);
      const quota = customer.getByTestId('order-quota');
      await expect(quota).toContainText('Your quota');
      await expect(customer.getByText('This exceeds the quota of the chosen project')).toHaveCount(0);
      // With the project chosen its own quota decides: it is named, shown as it would stand, and says what does not fit.
      await choose(customer, customer, 'Project', 'Quota lab');
      await expect(quota).toContainText('Quota of the project “Quota lab”');
      await expect(quota).toContainText('1 of 1');
      await expect(customer.getByText('This exceeds the quota of the chosen project: vCPU.')).toBeVisible();
      await expect(customer.getByRole('button', { name: 'Create server' })).toBeDisabled();
      await customer.setViewportSize({ width: 390, height: 844 });
      await expectNoOverflow(customer, 'order page with a project quota at 390 px');
      await tour(quota, 'order-project-quota-phone');
      await customer.emulateMedia({ colorScheme: 'dark' });
      await tour(quota, 'order-project-quota-phone-dark');
      await customer.emulateMedia({ colorScheme: 'light' });
      await customer.setViewportSize({ width: 1280, height: 720 });
      // The API refuses the order itself, with the project's own code; nothing is created.
      const projectId = (await (await customer.request.get('/api/projects')).json()).projects[0].id;
      const sshKey = (await (await customer.request.post('/api/ssh-keys', { headers: csrf,
        data: { name: 'e2e-quota', publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMa0iBTtZu9kbSNXzg5M6pZ1rn8F1143iWq3JIcGimfn e2e' } })).json() as { id: string }).id;
      expect(sshKey).toBeTruthy();
      const refused = await customer.request.post('/api/servers', { headers: { ...csrf, 'idempotency-key': `e2e-quota-${Date.now()}` },
        data: { type: 'package', poolId: pkg.poolIds[0], packageId: pkg.id, imageId: image.id, name: 'quota-lab-1', sshKeyIds: [sshKey], projectId } });
      const answer = await refused.json();
      expect([refused.status(), answer.code, answer.fields]).toEqual([409, 'PROJECT_QUOTA_EXCEEDED', { vcpu: 'QUOTA_EXCEEDED' }]);
      expect((await (await customer.request.get('/api/servers')).json()).servers).toHaveLength(0);

      // Staff remove the quota: the project is back under its owner's.
      await page.goto('/admin/catalog?tab=quotas');
      await row.getByRole('button', { name: `Remove the quota of Quota lab (project of ${owner.email})` }).click();
      await expect(page.getByRole('alertdialog')).toContainText('The project goes back to its owner\'s quota.');
      await page.getByRole('alertdialog').getByRole('button', { name: 'Remove quota' }).click();
      await expect(page.getByRole('row', { name: /Quota lab/ })).toHaveCount(0);
      await customer.goto('/account?tab=projects');
      await expect(customer.getByText('Quota lab')).toBeVisible();
      await expect(customer.getByText('Project quota:')).toHaveCount(0);
    } finally {
      await customer.context().close();
    }
  });

  test('e-mail verification: hidden without mail; an unverified account sees it, cannot order while the rule is on, a wrong code is refused; verified, it is gone', async ({ page, browser }) => {
    await signInAdmin(page);
    const csrf = { 'x-lightning-csrf': '1' };
    const fresh = { email: `verify-${Date.now()}@example.test`, password: 'e2e verify passphrase 2026' };
    const customer = await (await browser.newContext({ locale: 'en-US' })).newPage();
    const order = () => customer.request.post('/api/servers', { headers: { ...csrf, 'idempotency-key': `e2e-verify-${Date.now()}` }, data: {} });
    // The sign-in rules as the suite has them now: put back exactly at the end.
    const rulesBefore = await (await page.request.get('/api/admin/settings/security')).json();
    try {
      // No mail on this panel yet: the account page says nothing about verification, and nothing is asked.
      await customer.goto('/register');
      await customer.getByLabel('Email').fill(fresh.email);
      await customer.getByLabel('Password').fill(fresh.password);
      await customer.getByRole('button', { name: 'Create account' }).click();
      await expect(customer).toHaveURL(/\/$/);
      await customer.goto('/account');
      await expect(customer.getByText('The name shown in the panel.')).toBeVisible();
      await expect(customer.locator('#email-verification')).toHaveCount(0);
      // Mail set up towards a port where nothing listens (inside the API's own machine): the panel can now verify
      // addresses, and every mail it tries fails there. Nothing leaves the machine.
      expect((await page.request.put('/api/admin/settings/mail', { headers: csrf, data: { enabled: true, provider: 'smtp', host: '127.0.0.1', port: 9, security: 'none',
        fromAddress: 'panel@example.test', use: { passwordReset: false, twoFactor: false, verification: true } } })).status()).toBe(200);
      await page.goto('/admin/settings?tab=mail');
      await expect(page.getByRole('checkbox', { name: /^Address verification/ })).toBeChecked();
      // Settings → Sign-in security: only verified addresses order.
      await page.goto('/admin/settings?tab=security');
      const rule = page.getByRole('switch', { name: 'Only accounts with a verified e-mail address may order' });
      await expect(rule).not.toBeChecked();
      await tick(rule);
      await expect(rule).toBeChecked();
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText('Sign-in security saved.').first()).toBeVisible();

      // The account now shows the state, why it matters here, and a way to get a code.
      await customer.goto('/account');
      const section = customer.locator('#email-verification');
      await expect(section.getByText('This address is not verified yet')).toBeVisible();
      await expect(section.getByText('You cannot order a server until this address is verified.')).toBeVisible();
      await expect(customer.getByText('E-mail address not verified').first()).toBeAttached();
      await section.getByRole('button', { name: 'Send verification code' }).click();
      await expect(customer.getByText('The e-mail could not be sent.').first()).toBeVisible();
      // The attempt counts: another one has to wait, and the button says for how long.
      await expect(section.getByRole('button', { name: /New code in \d+ s/ })).toBeDisabled();
      // The link of a verification mail with a code that is not the account's: refused, and taken out of the address.
      await customer.goto('/account?tab=profile&verify=123456');
      await expect(customer.getByText('This code is wrong or no longer valid.').first()).toBeVisible();
      await expect(customer).not.toHaveURL(/verify=/);
      await expect(section.getByText('This address is not verified yet')).toBeVisible();
      // The order page says what stands in the way, and the API refuses the order itself.
      await customer.goto('/order');
      await expect(customer.getByText('Verify your e-mail address first')).toBeVisible();
      await expect(customer.getByRole('link', { name: 'Verify in Account → Profile' })).toHaveAttribute('href', '/account?tab=profile');
      const refused = await order();
      expect([refused.status(), (await refused.json()).code]).toEqual([403, 'EMAIL_NOT_VERIFIED']);
      // A phone: the section fits, in the dark theme too.
      await customer.setViewportSize({ width: 390, height: 844 });
      await customer.goto('/account');
      await expect(section.getByText('This address is not verified yet')).toBeVisible();
      await expectNoOverflow(customer, 'account with the unverified address at 390 px');
      await tour(customer, 'account-email-unverified-phone', true);
      await customer.emulateMedia({ colorScheme: 'dark' });
      await expectNoOverflow(customer, 'account with the unverified address at 390 px, dark');
      await tour(customer, 'account-email-unverified-phone-dark', true);
      await customer.emulateMedia({ colorScheme: 'light' });
      await customer.setViewportSize({ width: 1280, height: 720 });

      // Staff confirm the address another way (Admin → Users has the button; here by its API): the section and the
      // notice are gone and the order reaches its own checks.
      const id = (await (await customer.request.get('/api/auth/me')).json()).id;
      expect((await page.request.put(`/api/admin/users/${id}/email-verified`, { headers: csrf, data: { verified: true } })).status()).toBe(200);
      await customer.goto('/account');
      await expect(customer.getByText('The name shown in the panel.')).toBeVisible();
      await expect(customer.locator('#email-verification')).toHaveCount(0);
      await customer.goto('/order');
      await expect(customer.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(customer.getByText('Verify your e-mail address first')).toHaveCount(0);
      expect((await (await order()).json()).code).toBe('VALIDATION_FAILED');
    } finally {
      // As the rest of the suite expects it: no mail, no rule.
      await page.request.put('/api/admin/settings/security', { headers: csrf, data: { ...rulesBefore, verifiedEmailToOrder: false } });
      await page.request.put('/api/admin/settings/mail', { headers: csrf, data: { enabled: false, provider: 'smtp', host: '', port: 587, security: 'starttls', fromAddress: '' } });
      await customer.context().close();
    }
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
    // The state filter counts each state; what is shown downloads as CSV; releasing from quarantine asks first.
    await expect(page.getByRole('button', { name: /All \(\d+\)/ })).toBeVisible();
    if (await page.getByRole('button', { name: 'Download CSV' }).isVisible()) {
      const csv = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download CSV' }).click();
      expect((await csv).suggestedFilename()).toMatch(/^ip-addresses.*\.csv$/);
    }
    const release = page.getByRole('button', { name: 'Release' }).filter({ visible: true }).first();
    if (await release.isVisible()) {
      await release.click();
      const ask = page.getByRole('alertdialog', { name: /from quarantine\?/ });
      await expect(ask).toContainText('DNS records');
      await ask.getByRole('button', { name: 'Cancel' }).click();
    }

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
    // 57 pages, each measured once its content is there: that wait is about a second a page (66 s became 118 s on a
    // development machine), on top of the 200 s the walk had when it measured the pages as they arrived.
    test.setTimeout(300_000);
    const page = await (await browser.newContext({ locale: 'en-US', viewport })).newPage();
    await watchApi(page); // each page is measured with its content, not with its placeholders
    await signInAdmin(page);
    await expect(page).toHaveURL(/\/admin$/);
    for (const path of ['/admin', '/admin/servers', '/admin/vmware', '/admin/catalog', '/admin/users', '/admin/roles', '/admin/settings?tab=mail', '/admin/system', '/', '/order', '/firewalls', '/admin/settings?tab=rdns', '/admin/catalog?tab=ip', '/account?tab=security',
      '/admin/topology', '/admin/energy', '/admin/abuse', '/admin/catalog?tab=locations', '/admin/catalog?tab=isos', '/admin/catalog?tab=vdcs', '/admin/settings?tab=domain', '/admin/settings?tab=servers', '/topology', '/vdc', '/account?tab=accessibility',
      '/admin/catalog?tab=packages', '/admin/catalog?tab=apps', '/admin/settings?tab=security', '/admin/settings?tab=notifications', '/account?tab=keys', '/account?tab=notifications', '/admin/audit', '/account?tab=activity', '/admin/settings?tab=announcement', '/admin/terminal', '/admin/settings?tab=chat', '/admin/settings?tab=directory', '/admin/roles', '/admin/settings?tab=status', '/status', '/support', '/admin/support', '/admin/settings?tab=support', '/admin/stats', '/account?tab=api', '/reseller', '/networks', '/api-docs', '/admin/settings?tab=api',
      // Added after 0.4.0: quotas with project quotas and their use, projects, the Stripe address, unusual use, accounts at risk, the profile with its address check.
      '/admin/catalog?tab=quotas', '/account?tab=projects', '/admin/settings?tab=payments', '/admin/abuse?tab=usage', '/admin/billing?tab=risk', '/account?tab=profile', '/billing']) {
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
  test('a session that ends while something is typed keeps the page; links ask before throwing typed text away', async ({ browser }) => {
    test.setTimeout(90_000); // session loss, limits, links and Back in one sign-in
    const context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    await signIn(page, admin);
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto('/account?tab=projects');
    await page.getByLabel('Project name').fill('kept after expiry');
    // The session cookie disappears (as if it expired). Saving is refused, or live updates notice first: either
    // way the text stays and a dialog explains.
    const cookies = await context.cookies();
    // Only the sign-in cookies go, as when a session expires; language and time-zone cookies stay.
    const session = cookies.filter((c) => /session|auth/i.test(c.name));
    expect(session.length).toBeGreaterThan(0);
    for (const c of session) await context.clearCookies({ name: c.name });
    await page.getByLabel('Project name').press('Enter');
    const dialog = page.getByRole('alertdialog', { name: 'Your session has ended' });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\/account/);
    // Behind the open dialog the page is hidden from assistive tech, so look for the field including hidden ones.
    await expect(page.getByRole('textbox', { name: 'Project name', includeHidden: true })).toHaveValue('kept after expiry');
    // Signed in again (here: the cookie comes back): the page notices and says so.
    await context.addCookies(session);
    await expect(page.getByText('You are signed in again. You can save now.')).toBeVisible({ timeout: 15_000 });
    await expect(dialog).toBeHidden();

    // Same page, still signed in (another sign-in here would hit the sign-in rate limit):
    // a link asks before throwing away typed text, and long text shows the room left.
    const name = page.getByLabel('Project name');
    // The field takes no more than the API keeps (100) and says so at the limit.
    await name.fill('x'.repeat(120));
    await expect(name).toHaveValue('x'.repeat(100));
    await expect(page.getByText('Limit reached: at most 100 characters')).toBeVisible();
    await name.fill('unsaved project');
    await expect(page).toHaveTitle(/^(\(\d+\+?\) )?\u270E /);
    // (By its address: the entry's name also carries a count while operations have failed in the last 24 hours.)
    const away = page.getByRole('navigation', { name: 'Main navigation' }).locator('a[href="/admin/servers"]');
    await away.click();
    const leave = page.getByRole('alertdialog', { name: 'Leave without saving?' });
    await expect(leave).toBeVisible();
    await expect(leave.getByText('Not saved: Project name')).toBeVisible();
    // Stay: back on the field, text intact.
    await leave.getByRole('button', { name: 'Stay and save' }).click();
    await expect(leave).toBeHidden();
    await expect(page).toHaveURL(/\/account/);
    await expect(name).toHaveValue('unsaved project');
    await expect(name).toBeFocused();
    // Leave: goes, and the next page does not ask again.
    await away.click();
    await leave.getByRole('button', { name: 'Leave without saving' }).click();
    await expect(page).toHaveURL(/\/servers/);
    await expect(leave).toBeHidden();
    // Nothing typed: links just go (a staff member's own workspace is folded under its heading).
    await page.getByRole('button', { name: 'My workspace' }).first().click();
    await page.getByRole('link', { name: 'My account', exact: true }).first().click();
    await expect(page).toHaveURL(/\/account/);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    // The browser's Back and Forward buttons ask too; staying keeps page, address and text.
    // Back within the app (a page loaded afresh is the browser's own business): Servers, then back to the projects tab.
    await page.goto('/account?tab=projects');
    await away.click();
    await expect(page).toHaveURL(/\/servers/);
    await page.goBack();
    await expect(page).toHaveURL(/tab=projects/);
    // The step before it is the page loaded afresh, so Forward (the same guard) is the step within the app here.
    await name.fill('typed again');
    await page.goForward();
    await expect(leave).toBeVisible();
    await leave.getByRole('button', { name: 'Stay and save' }).click();
    await expect(page).toHaveURL(/tab=projects/);
    await expect(name).toHaveValue('typed again');
    // Staying put the page back as the newest step, so the page asked for is now one step back.
    await page.goBack();
    await expect(leave).toBeVisible();
    await leave.getByRole('button', { name: 'Leave without saving' }).click();
    await expect(page).toHaveURL(/\/servers/);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    // Ctrl+S saves the form being typed in (here: creates the project), then it is removed again.
    await page.goto('/account?tab=projects');
    await name.fill('Saved with keys');
    await name.press('Control+s');
    await expect(page.getByText('Project created.')).toBeVisible();
    const row = page.getByRole('listitem').filter({ hasText: 'Saved with keys' });
    const removed = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes('/api/projects/'));
    await row.getByRole('button', { name: 'Delete Saved with keys' }).click();
    await expect(row).toHaveCount(0);
    expect((await removed).ok()).toBe(true);
    await context.close();
  });

  test('dark mode on the newer screens', async ({ browser }) => {
    test.setTimeout(300_000);
    const page = await (await browser.newContext({ locale: 'en-US', colorScheme: 'dark', viewport: { width: 1280, height: 900 } })).newPage();
    await signInAdmin(page);
    for (const [path, name, heading] of [['/admin/stats', 'dark-stats', 'Statistics'], ['/admin/system', 'dark-system', 'System'], ['/admin/support', 'dark-support', 'Support queue'],
      ['/account', 'dark-account', 'My account'], ['/', 'dark-home', 'Your servers'], ['/billing', 'dark-billing', 'Billing'], ['/support', 'dark-tickets', 'Support'], ['/admin', 'dark-dashboard', 'Overview']] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.classList.contains('dark') || document.documentElement.dataset.theme === 'dark')).toBe(true);
      await page.waitForTimeout(2000);
      // The capacity chart draws its bars in the dark theme too (a bar as wide as its share, not only axes and a legend).
      if (name === 'dark-dashboard') {
        const bars = page.getByRole('img', { name: 'vCPU capacity per pool' }).locator('.recharts-bar-rectangle path');
        await expect.poll(async () => Math.max(0, ...(await bars.evaluateAll((list) => list.map((e) => e.getBoundingClientRect().width)))), { message: 'capacity bars drawn in dark mode', timeout: 10_000 }).toBeGreaterThan(20);
      }
      await tour(page, name, true);
    }
    // With billing off, staff get a way to turn it on.
    await page.goto('/billing');
    if (await page.getByText('Billing is not turned on in this panel.').isVisible()) await expect(page.getByRole('link', { name: 'Open billing settings' })).toHaveAttribute('href', '/admin/settings?tab=billing');

    // The screens added after 0.4.0 (the rule-based helpers, quotas per project, running a request, the monitoring
    // switch, the quietest hours, the digest), each with something in it: a fresh deployment has no history, so the
    // answer of the one route in question is a prepared one. Looked at in both themes: every piece of text in the new
    // blocks must stand out from what is behind it, and the dark pictures go to test-results/tour for review.
    const answer = (route: import('@playwright/test').Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    const finding = { id: '5b1f6f0e-6a53-4c0e-9d57-0d6f3a1f7c11', metric: 'cpu', direction: 'high', openedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), lastSeen: new Date().toISOString(),
      detail: { recent: 96, usual: 10, scale: 5, z: 17.2, baseline: 46, days: 10, hint: 'cpu_pinned' } };
    const quiet = { state: 'suggested', days: 28, minDays: 21, weeks: 4, servers: 12, usual: 6.4, peak: 14.25, weekly: { day: 7, time: '04:00', end: '06:00', hours: 2, load: 0.6 }, daily: { day: 0, time: '03:00', end: '05:00', hours: 2, load: 1.2, worst: 2.5 } };
    const servers = ((await (await page.request.get('/api/servers')).json()) as { servers: { id: string; state: string }[] }).servers;
    const serverId = servers.find((s) => s.state === 'ready')?.id;
    const connectionId = ((await (await page.request.get('/api/admin/vmware/connections')).json()) as { connections: { id: string }[] }).connections[0]?.id;
    await page.route('**/api/insights', (route) => answer(route, { hidden: 0, insights: [
      { code: 'USAGE_ANOMALY_CPU_HIGH', severity: 'warning', params: { name: 'web-1', recent: 96, usual: 10, baseline: 46 }, link: '/servers', key: 'anomaly:1' },
      { code: 'SCHEDULE_SUGGESTED', severity: 'info', params: { name: 'web-1', hours: 108 }, link: '/servers', key: 'schedule:1' },
      { code: 'CARD_EXPIRES_BEFORE_RENEWAL', severity: 'warning', params: { last4: '1881', expiry: '10/26', date: '2026-12-11', price: '96.00', currency: 'EUR' }, link: '/billing?tab=cards', key: 'card-expiry:2026-12-11' },
      { code: 'BUDGET_FORECAST_OVER', severity: 'warning', params: { forecast: '120.00', amount: '100.00', currency: 'EUR', pct: 120 }, link: '/', key: 'budget-forecast:2026-11' }] }));
    await page.route('**/api/admin/maintenance/quiet-hours', (route) => answer(route, { ...quiet, timezone: 'Europe/Istanbul', zoneKnown: true, window: '03:00-05:00', current: '01:00-03:00' }));
    await page.route('**/api/admin/vmware/connections/*/quiet-hours**', (route) => answer(route, { timezone: 'Europe/Istanbul', connection: quiet, hosts: [{ moref: 'host-1', name: 'esx-a.example', ...quiet, servers: 9 }, { moref: 'host-2', name: 'esx-b.example', state: 'not_enough_data', days: 9, minDays: 21, weeks: 4 }] }));
    await page.route('**/api/admin/anomalies', (route) => answer(route, { anomalies: [{ ...finding, resolvedAt: null, serverId: serverId ?? finding.id, serverName: 'web-1', owner: 'a@example.test', location: 'Istanbul', abuseOpen: 1 }] }));
    await page.route('**/api/admin/billing/risk', (route) => answer(route, { rule: { lookaheadDays: 30, failedDays: 30, minFailures: 2, growthDays: 7 }, accounts: [
      { userId: 'u1', email: 'a@example.test', currency: 'EUR', atRisk: 1200, overdue: 1200, overdueCount: 2, oldestDays: 40, newOverdue: 300, failedCharges: 0, failedAmount: 0, reasons: ['OVERDUE_GROWING'] },
      { userId: 'u2', email: 'b@example.test', currency: 'EUR', atRisk: 120, overdue: 0, overdueCount: 0, oldestDays: 0, newOverdue: 0, failedCharges: 3, failedAmount: 120, reasons: ['REPEATED_FAILURES'] }] }));
    if (serverId) {
      await page.route(`**/api/servers/${serverId}/anomalies`, (route) => answer(route, { measured: true, days: 10, minDays: 5, enough: true, anomalies: [finding], hidden: 0 }));
      await page.route(`**/api/servers/${serverId}/schedule-suggestion**`, (route) => answer(route, { state: 'suggested', timezone: 'UTC', days: 27, minDays: 21, weeks: 4, kind: 'nightly', offHours: 108, idleHours: 118, savesMoney: false, energyKwhPerWeek: 5.4, hidden: false,
        schedules: [{ action: 'shutdown', days: [1, 2, 3, 4, 5], time: '19:00' }, { action: 'power_on', days: [1, 2, 3, 4, 5], time: '07:00' }] }));
    }
    // [the page, the picture's name, the blocks that must be there and readable, what to press first]
    const added: [string, string, string[], (() => Promise<void>)?][] = [
      ['/', 'new-insights', ['section[aria-labelledby^="insights-"]']],
      ['/admin/system', 'new-system', ['[data-quiet-hours="suggested"]', '[data-testid="monitoring-switch"]']],
      ['/account?tab=notifications', 'new-digest', ['[data-testid="periodic-digest"]']],
      ['/admin/abuse?tab=usage', 'new-unusual-use', ['[role="grid"][aria-label="Unusual use"]']],
      ['/admin/billing?tab=risk', 'new-at-risk', ['[role="grid"][aria-label="Accounts at risk"]']],
      ['/admin/catalog?tab=quotas', 'new-quotas', ['main']],
      ['/account?tab=projects', 'new-projects', ['main']],
      ['/admin/settings?tab=payments', 'new-payments', ['main']],
      ['/api-docs', 'new-api-try', ['[data-testid="try-request"]'], async () => { await page.getByRole('searchbox', { name: 'Search endpoints' }).fill('/auth/me'); await page.locator('#get-auth-me').locator('summary').click(); }],
      ...(serverId ? [[`/servers/${serverId}`, 'new-server', ['[data-section="Usage watch"]', '[data-schedule-suggestion="suggested"]']] as [string, string, string[]]] : []),
      ...(connectionId ? [[`/admin/vmware/${connectionId}`, 'new-connection-hosts', ['[data-quiet-hours="suggested"]'], () => page.getByRole('tab', { name: /Hosts/ }).click()] as [string, string, string[], () => Promise<void>]] : []),
    ];
    // The measuring is checked on known cases first: a dark word on a dark card and a pale one on a nearly white layer
    // are found, a clear one is not. (A check that finds nothing because it measures nothing would pass for ever.)
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div id="contrast-probe"><p style="color:#333;background:#111">dim</p><p style="color:#eee;background:#111">clear</p>'
      + '<div style="background:rgba(255,255,255,0.92)"><p style="color:#f2f2f2">pale</p></div><p style="color:#333;background:#111" aria-hidden="true">not shown</p></div>'));
    expect((await unreadable(page, '#contrast-probe')).map((x) => x.split('"')[1])).toEqual(['dim', 'pale']);
    await page.evaluate(() => document.getElementById('contrast-probe')?.remove());
    const problems: string[] = [];
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const [path, name, blocks, open] of added) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
        await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')), { message: `${path} follows the ${scheme} theme` }).toBe(scheme === 'dark');
        await open?.();
        for (const block of blocks) {
          await expect(page.locator(block).first(), `${path}: ${block}`).toBeVisible();
          await settled(page);
          problems.push(...(await unreadable(page, block)).map((x) => `${scheme} ${path} ${block}: ${x}`));
        }
        if (scheme === 'dark') await tour(page, `dark-${name}`, true);
      }
    }
    expect(problems, 'text that does not stand out from what is behind it').toEqual([]);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('tour of the newer screens', async ({ browser, baseURL }) => {
    test.setTimeout(360_000);
    const shot = async (page: Page, name: string) => tour(page, name, true);
    const guest = await (await browser.newContext({ locale: 'tr-TR' })).newPage();
    // The public status page needs no sign-in.
    await guest.goto('/status');
    await expect(guest.getByRole('heading', { level: 1 })).toHaveText('Sistem durumu');
    await expect(guest.getByRole('status').first()).toBeVisible();
    await expect(guest.getByRole('list', { name: 'Renklerin anlamı' })).toContainText('Kesinti');
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
    await expect(page.getByText('Month-end forecast')).toBeVisible();
    await page.getByRole('button', { name: 'Measure now' }).click();
    await page.waitForTimeout(6000);
    // An empty topology map says what to do next.
    await page.goto('/topology');
    await expect(page.locator('main').getByRole('link', { name: 'New server' })).toHaveAttribute('href', '/order');
    // The admin list view stays in the address, finds servers and sorts the busiest first.
    await page.goto('/admin/topology?view=table');
    await expect(page.getByRole('tab', { name: 'Table' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('searchbox', { name: 'Search name, IP, owner or firewall' }).fill('no-such-server-zz');
    await expect(page.getByText('No server matches.').filter({ visible: true })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search name, IP, owner or firewall' }).fill('');
    await page.setViewportSize({ width: 390, height: 900 });
    await expectNoOverflow(page, 'topology table at 390 px');
    await page.setViewportSize({ width: 1280, height: 720 });
    // "g" then a letter goes to a page; "g b" (billing) does nothing while billing is switched off, as in the menu.
    await page.locator('main h1').click();
    await page.keyboard.press('g'); await page.keyboard.press('b');
    await page.waitForTimeout(400);
    await expect(page).toHaveURL(/\/admin\/topology/);
    await page.keyboard.press('g'); await page.keyboard.press('u');
    await expect(page).toHaveURL(/\/support$/);
    // Notification preferences: grouped by area, and a search narrows the long list.
    await page.goto('/account?tab=notifications');
    await page.getByRole('searchbox', { name: /Find a notification/ }).fill('invoice');
    await expect(page.getByText('Payment reminder', { exact: true })).toBeVisible();
    await expect(page.getByText('Server ready', { exact: true })).toBeHidden();
    await page.getByRole('searchbox', { name: /Find a notification/ }).fill('');
    await expect(page.getByText('Server ready', { exact: true })).toBeVisible();
    // A channel's header box sets it for every notification shown, then back.
    const column = page.getByRole('checkbox', { name: /for every notification shown$/ }).first();
    await expect(column).toBeAttached();
    const was = await column.isChecked();
    await tick(column);
    await expect(page.getByText(/turned (on|off) for \d+ notifications?/).first()).toBeVisible();
    await expect(column).toBeChecked({ checked: !was });
    await tick(column);
    await expect(column).toBeChecked({ checked: was });
    // An empty virtual datacenter page shows staff where to create one.
    await page.goto('/vdc');
    await expect(page.getByRole('link', { name: 'Create a virtual datacenter' })).toHaveAttribute('href', '/admin/catalog?tab=vdcs');
    // With one: ready-made sizes fill the new-server form from what is left.
    {
      const me = await (await page.request.get('/api/auth/me')).json();
      // Sized to what the simulator pool still has (earlier tests use some of it).
      const pools = (await (await page.request.get('/api/admin/pools')).json()).pools as { id: string; capacity: { available: { vcpu: number; memoryMb: number; storageGb: number } } }[];
      const p = pools.toSorted((x, y) => y.capacity.available.memoryMb - x.capacity.available.memoryMb)[0];
      const size = { vcpu: Math.min(2, p.capacity.available.vcpu), memoryMb: Math.min(2048, Math.floor(p.capacity.available.memoryMb / 1024) * 1024), diskGb: Math.min(40, Math.floor(p.capacity.available.storageGb / 10) * 10) };
      const made = await page.request.post('/api/admin/vdcs', { headers: { 'x-lightning-csrf': '1' }, data: { name: 'E2E VDC', ownerId: me.id, poolId: p.id, ...size, maxServers: 5, priceMonthly: '0', currency: 'EUR' } });
      expect(made.status(), await made.text()).toBe(201);
      await page.goto('/vdc');
      await page.getByRole('button', { name: 'Create server' }).click();
      const dialog = page.getByRole('dialog');
      // A free name from the data centre's own comes filled in.
      await expect(dialog.getByRole('textbox', { name: 'Server name' })).toHaveValue('e2e-vdc-1');
      await dialog.getByRole('radio', { name: /^All that is left/ }).click();
      await expect(dialog.getByRole('radio', { name: /^All that is left/ })).toHaveAttribute('aria-checked', 'true');
      await expect(dialog.getByText(`${size.vcpu} vCPU · ${size.memoryMb / 1024} GB · ${size.diskGb} GB`).first()).toBeVisible();
      await dialog.getByRole('radio', { name: /^Small/ }).click();
      await expect(dialog.getByRole('radio', { name: /^All that is left/ })).toHaveAttribute('aria-checked', 'false');
      await page.waitForTimeout(400);
      await shot(page, 'vdc-new-server');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await page.setViewportSize({ width: 390, height: 900 });
      await expectNoOverflow(page, 'vdc at 390 px');
      await page.setViewportSize({ width: 1280, height: 720 });
    }
    // Projects show how many servers they hold, and deleting one says what happens to them.
    await page.goto('/account?tab=projects');
    await page.getByLabel('Project name').fill('E2E Project');
    await page.getByRole('button', { name: 'Create project' }).click();
    const project = page.getByRole('listitem').filter({ hasText: 'E2E Project' });
    await expect(project).toContainText('No servers');
    // Deleting a project asks nothing: it leaves the list, the message says what happens to its servers and offers
    // Undo, and the request is sent only when the message goes. An undone removal never reaches the API.
    const deletes: string[] = [];
    const onRequest = (r: import('@playwright/test').Request) => { if (r.method() === 'DELETE' && r.url().includes('/api/projects/')) deletes.push(r.url()); };
    page.on('request', onRequest);
    await project.getByRole('button', { name: 'Delete E2E Project' }).click();
    await expect(project).toHaveCount(0);
    await expect(page.getByText('Project E2E Project removed. The project has no servers.')).toBeVisible();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(project).toBeVisible();
    await expect(page.getByText('Brought back. Nothing was removed.')).toBeVisible();
    expect(deletes).toEqual([]);
    const gone = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes('/api/projects/'));
    await project.getByRole('button', { name: 'Delete E2E Project' }).click();
    await expect(project).toHaveCount(0);
    expect((await gone).status()).toBe(204);
    page.off('request', onRequest);
    expect(deletes).toHaveLength(1);
    await page.reload();
    await expect(page.getByRole('listitem').filter({ hasText: 'E2E Project' })).toHaveCount(0);
    // The panel address follows the domain the proxy serves, not a loopback address from the wizard.
    await page.goto('/admin/settings');
    await expect(page.getByRole('link', { name: new URL(baseURL!).host })).toBeVisible();
    // The getting-started list folds its done steps away and marks the next one.
    await page.goto('/admin');
    const setup = page.getByRole('button', { name: /^Show the \d+ done steps$/ });
    if (await setup.isVisible()) {
      await expect(page.getByText('Next step', { exact: true })).toBeVisible();
      await setup.click();
      await expect(page.getByRole('button', { name: 'Hide the done steps' })).toHaveAttribute('aria-expanded', 'true');
      await page.getByRole('button', { name: 'Hide the done steps' }).click();
    }
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
    await expect(page.getByLabel(/^\d+ of \d+ tokens in use$/)).toBeVisible();
    await page.waitForTimeout(600);
    await shot(page, 'account-api');
    await page.getByRole('button', { name: 'Saved it, hide' }).click();
    await expect(page.getByText('Copy it now: it is shown only once')).toBeHidden();
    // Coupons: one made in the billing admin, then listed with its discount. Transfers: the account's tab.
    const code = `E2E${Date.now().toString(36).toUpperCase()}`;
    await page.goto('/admin/billing?tab=coupons');
    await expect(page.getByText('New coupon', { exact: true })).toBeVisible();
    await expect(async () => {
      await page.getByRole('textbox', { name: 'Code', exact: true }).fill(code);
      await page.getByRole('textbox', { name: 'Percent off' }).fill('10');
      await expect(page.getByRole('textbox', { name: 'Code', exact: true })).toHaveValue(code, { timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    // While it is written, a worked example shows what the customer pays.
    await expect(page.getByRole('status').filter({ hasText: /the customer pays .*90/ })).toBeVisible();
    await page.getByRole('button', { name: 'Create coupon' }).click();
    await expect(page.getByText(`Coupon ${code} created.`)).toBeVisible();
    await expect(page.getByRole('grid', { name: 'Coupons' }).getByText(code, { exact: true })).toBeVisible();
    // The list finds a code, narrows to working coupons and copies a code.
    await page.getByRole('searchbox', { name: 'Search code or note' }).fill(code.toLowerCase());
    await page.getByRole('button', { name: /^Working \d+$/ }).click();
    await expect(page.getByRole('grid', { name: 'Coupons' }).getByText(code, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: `Copy ${code}` }).filter({ visible: true }).click();
    await expect(page.getByText(`${code} copied.`)).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search code or note' }).fill('');
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
    // Every workload has its icon (they come from a lookup table the icon bundle must include).
    const workloads = page.getByRole('radiogroup', { name: 'What will you run?' }).getByRole('radio');
    for (let i = 0; i < await workloads.count(); i++) await expect(workloads.nth(i).locator('svg'), `icon of workload ${i}`).toHaveCount(1);
    await page.getByRole('radio', { name: 'Website' }).click();
    await page.getByRole('radio', { name: 'Medium' }).click();
    await expect(page.getByText(/Suggested to start/)).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, 'order-advisor');
    // An incident: opened in settings, shown in the panel bar and on the status page, then deleted.
    await page.goto('/admin/settings?tab=status');
    await page.getByLabel('Title').fill('Planned network work');
    await page.getByLabel('First update').fill('We are moving the uplinks; short interruptions are possible.');
    // Kept in the browser until sent: a reload brings the text back.
    await page.reload();
    await expect(page.getByLabel('First update')).toHaveValue('We are moving the uplinks; short interruptions are possible.');
    await expect(page.getByLabel('Title')).toHaveValue('Planned network work');
    await expect(page.getByText('Your unsent draft is back').first()).toBeVisible();
    await page.getByRole('button', { name: 'Open the incident' }).click();
    await expect(page.getByText('Incident opened.')).toBeVisible();
    // The card says how long it has been open; the ready wording fills the update for its status.
    await expect(page.getByText(/Open for \d+m/)).toBeVisible();
    // The newest incident is the first card (the form's own button comes before it); 'First update' must not match.
    await page.getByRole('button', { name: 'Use ready wording' }).nth(1).click();
    await expect(page.getByRole('textbox', { name: 'Update', exact: true }).first()).toHaveValue(/^A problem has been reported/);
    await shot(page, 'incidents-admin');
    await page.goto('/');
    await expect(page.getByText('Planned network work').first()).toBeVisible();
    await shot(page, 'incident-banner');
    await page.goto('/status');
    await expect(page.getByRole('heading', { name: 'Planned network work' })).toBeVisible();
    await page.waitForTimeout(600);
    await shot(page, 'status-incident');
    // Relative times carry the exact date and time (hover, and the time element).
    await expect(page.locator('time[title][datetime]').first()).toBeVisible();
    await page.goto('/admin/settings?tab=status');
    await page.getByRole('button', { name: 'Delete' }).first().click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('No incidents yet.')).toBeVisible();
    // Support: a ticket opened from the customer side, then the staff queue and an internal note.
    await page.goto('/support');
    await page.getByRole('button', { name: 'New ticket' }).first().click();
    // Quick start fills the subject and a message that asks for what support needs, and raises the priority.
    await page.getByRole('button', { name: 'Cannot connect over SSH' }).click();
    await expect(page.getByLabel('Subject')).toHaveValue('I cannot connect to my server over SSH');
    await expect(page.getByLabel('Message')).toHaveValue(/^Since when:/);
    await expect(page.getByRole('radio', { name: /High/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('button', { name: 'Cannot connect over SSH' })).toBeHidden();
    await page.getByLabel('Subject').fill('Cannot reach my server over SSH');
    await page.getByRole('radio', { name: /High/ }).click();
    await page.getByLabel('Message').fill('SSH times out since this morning. I already restarted the server.');
    // Closing keeps the draft; a pasted screenshot becomes an attachment (and can be taken off again).
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'New ticket' }).first().click();
    await expect(page.getByLabel('Subject')).toHaveValue('Cannot reach my server over SSH');
    await page.getByRole('radio', { name: /High/ }).click();
    await page.getByLabel('Message').evaluate((el) => {
      const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'pasted-shot.png', { type: 'image/png' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect(page.getByRole('dialog').getByText('pasted-shot.png')).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, 'support-new');
    await page.getByRole('button', { name: /pasted-shot\.png/ }).click();
    await expect(page.getByRole('dialog').getByText('pasted-shot.png')).toHaveCount(0);
    await page.getByRole('button', { name: 'Send the ticket' }).click();
    await expect(page).toHaveURL(/\/support\/[0-9a-f-]{36}$/);
    await expect(page.getByText('SSH times out since this morning.')).toBeVisible();
    // A file dropped on the reply box is attached (and comes off again).
    await page.getByLabel('Your reply').evaluate((el) => {
      const dt = new DataTransfer(); dt.items.add(new File(['ssh -vvv output'], 'ssh-debug.log', { type: 'text/plain' }));
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect(page.getByText('ssh-debug.log')).toBeVisible();
    await shot(page, 'support-ticket');
    await page.getByRole('button', { name: /ssh-debug\.log/ }).click();
    await expect(page.getByText('ssh-debug.log')).toHaveCount(0);
    await page.goto('/admin/support');
    await expect(page.getByText('Cannot reach my server over SSH')).toBeVisible();
    // A number tile filters the queue to its tickets; the count, CSV and clear-filters follow.
    await page.getByRole('button', { name: /Awaiting answer/ }).click();
    await expect(page).toHaveURL(/status=waiting/);
    await expect(page.getByText('Cannot reach my server over SSH')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /tickets? shown/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download CSV' })).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).not.toHaveURL(/status=/);
    await page.waitForTimeout(400);
    await shot(page, 'support-queue');
    // Canned replies are kept from the queue, with placeholders filled in when picked.
    await page.getByRole('button', { name: 'Canned replies' }).click();
    await page.getByLabel('Title').fill('Firewall check');
    await page.getByLabel('Reply', { exact: true }).fill('Hi {name}, about {ticket}: please check the firewall of');
    // Placeholders go in with a click and are previewed with sample values.
    await page.getByRole('group', { name: 'Insert' }).getByRole('button', { name: '{server}' }).click();
    await expect(page.getByLabel('Reply', { exact: true })).toHaveValue('Hi {name}, about {ticket}: please check the firewall of {server}');
    await expect(page.getByRole('dialog').getByText('Hi Jane Doe, about #1042: please check the firewall of web-1')).toBeVisible();
    await page.getByRole('button', { name: 'Add canned reply' }).click();
    await expect(page.getByRole('dialog').getByText('Firewall check', { exact: true })).toBeVisible();
    await page.waitForTimeout(500);
    await shot(page, 'support-canned');
    // A saved reply is edited in place; deleting one asks first.
    await page.getByRole('button', { name: 'Edit “Firewall check”' }).click();
    await expect(page.getByText('Editing: Firewall check')).toBeVisible();
    await page.getByLabel('Title').fill('Firewall check-up');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('dialog').getByText('Firewall check-up', { exact: true })).toBeVisible();
    // Removing one asks nothing: it leaves the list with Undo for a few seconds (the message outlives the dialog),
    // and Undo brings it back before anything is sent.
    await page.getByRole('dialog').getByRole('button', { name: 'Remove “Firewall check-up”' }).click();
    await expect(page.getByRole('dialog').getByText('Firewall check-up', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Saved reply Firewall check-up removed.')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByText('Brought back. Nothing was removed.')).toBeVisible();
    await page.getByRole('button', { name: 'Canned replies' }).click();
    await expect(page.getByRole('dialog').getByText('Firewall check-up', { exact: true })).toBeVisible();
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
    await pick(page, page.getByRole('combobox', { name: 'Time zone' }), 'Istanbul', /Europe\/Istanbul/);
    await expect(page.getByText('Time zone saved').first()).toBeVisible();
    await page.waitForTimeout(600);
    await shot(page, 'account-region');
    await pick(page, page.getByRole('combobox', { name: 'Time zone' }), 'Automatic', /^Automatic/);
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
    await tour(visitor, 'login-methods', true);
    await visitor.close();
    expect((await page.request.put('/api/admin/settings/sign-in', { headers: { 'x-lightning-csrf': '1' }, data: { username: false, providers: { github: { enabled: false } } } })).ok()).toBe(true);
    // The command palette finds a ticket by its number (read from the API: the server lifecycle test opens a ticket
    // of its own before this one when the simulator is there).
    const sshTicket = ((await (await page.request.get('/api/support/tickets')).json()) as { tickets: { number: number | string; subject: string }[] }).tickets
      .find((x) => x.subject === 'Cannot reach my server over SSH');
    expect(sshTicket).toBeTruthy();
    await page.goto('/admin');
    await interactive(page);
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox').fill(String(sshTicket!.number));
    await expect(page.getByRole('option', { name: new RegExp(`#${sshTicket!.number} Cannot reach my server over SSH`) })).toBeVisible();
    await page.waitForTimeout(300);
    await tour(page, 'palette-ticket');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/admin\/support\/[0-9a-f-]{36}$/);
    const ticketId = page.url().split('/').pop()!;
    // The inbox: grouped by day, an icon per kind.
    await page.getByRole('button', { name: /notifications/i }).first().click();
    await expect(page.getByRole('dialog').getByText('Today')).toBeVisible();
    await page.waitForTimeout(500);
    await tour(page, 'bell');
    // Only the unread ones, then one kind; "All" brings the rest back.
    const inbox = page.getByRole('dialog');
    await inbox.getByRole('group', { name: 'Show' }).getByRole('button', { name: /^Unread/ }).click();
    await expect(inbox.getByRole('group', { name: 'Show' }).getByRole('button', { name: /^Unread/ })).toHaveAttribute('aria-pressed', 'true');
    const kinds = inbox.getByRole('group', { name: 'By kind' });
    if (await kinds.isVisible()) {
      await kinds.getByRole('button').first().click();
      await expect(kinds.getByRole('button').first()).toHaveAttribute('aria-pressed', 'true');
      const bg = (n: number) => kinds.getByRole('button').nth(n).evaluate((e) => getComputedStyle(e).backgroundColor);
      expect(await bg(0), 'the chosen kind stands out').not.toBe(await bg(1));
    }
    await page.waitForTimeout(300);
    await tour(page, 'bell-filters');
    await inbox.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'All', exact: true }).click();
    await page.keyboard.press('Escape');
    // Unread notifications lead the tab title; losing the connection says so, and coming back refreshes.
    await expect(page).toHaveTitle(/^\(\d+\+?\) /);
    await page.context().setOffline(true);
    await expect(page.getByRole('status').filter({ hasText: 'Connection lost' })).toBeVisible();
    await tour(page, 'offline');
    await page.context().setOffline(false);
    await expect(page.getByText('Back online; the page is up to date.')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Connection lost' })).toBeHidden();
    // Internet up but the panel's server gives gateway errors: its own banner, gone once it answers again.
    await page.route('**/api/**', (r) => r.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Bad Gateway</h1>' }));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.keyboard.press('Control+k'); await page.keyboard.press('Escape');
    await expect(page.getByRole('status').filter({ hasText: 'The panel server is not answering' })).toBeVisible({ timeout: 30_000 });
    await page.unroute('**/api/**');
    await expect(page.getByRole('status').filter({ hasText: 'The panel server is not answering' })).toBeHidden({ timeout: 30_000 });
    // The menu counts tickets waiting for support; the list and the queue on a phone.
    await expect(page.locator('nav a[href="/admin/support"]')).toContainText(/\d/);
    // A second ticket, so the list offers search and status filters; a reply left unsent shows as a draft.
    const deps = await (await page.request.get('/api/support/departments')).json() as { departments: { id: string }[] };
    expect((await page.request.post('/api/support/tickets', { headers: { 'x-lightning-csrf': '1' }, data: { subject: 'Invoice address question', departmentId: deps.departments[0].id, priority: 'low', serverId: null, body: 'Where do I change it?', attachments: [] } })).ok()).toBe(true);
    await page.evaluate((id) => localStorage.setItem(`lvm:support-draft:${id}`, 'half written'), ticketId);
    await page.goto('/support');
    const ssh = page.getByRole('link', { name: /Cannot reach my server over SSH/ });
    await expect(ssh.getByText('Draft', { exact: true })).toBeVisible();
    await expect(ssh.getByText(/\d+ messages?/)).toBeAttached();
    await page.getByRole('searchbox', { name: 'Number, subject or server' }).fill('invoice');
    await expect(ssh).toBeHidden();
    await expect(page.getByRole('link', { name: /Invoice address question/ })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Number, subject or server' }).fill('');
    await page.getByRole('searchbox', { name: 'Number, subject or server' }).fill('nothing like this');
    await page.getByRole('status').getByRole('button', { name: 'Clear filters' }).click();
    await expect(ssh).toBeVisible();
    await expect(page.getByRole('group', { name: 'By status' }).getByRole('button', { name: /^All 2/ })).toHaveAttribute('aria-pressed', 'true');
    await tour(page, 'support-list');
    await page.goto('/admin/support');
    await expect(page.getByRole('link', { name: /Cannot reach my server over SSH/ }).getByText('Draft', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/support');
    await expectNoOverflow(page, 'support list at 390 px');
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
    // Placeholders go in with one press and become each person's own name.
    await page.getByRole('dialog').getByRole('textbox', { name: 'Message' }).fill('Hello');
    await page.getByRole('dialog').getByRole('button', { name: 'Insert {name}' }).click();
    await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Message' })).toHaveValue('Hello {name}');
    // The first person's filled copy shows up front; a typo'd placeholder is flagged.
    await expect(page.getByRole('dialog').getByRole('figure', { name: /^Preview: / })).not.toContainText('{name}');
    await page.getByRole('dialog').getByRole('textbox', { name: 'Message' }).fill('Hello {name} {nmae}');
    await expect(page.getByRole('dialog').getByText(/Unknown placeholder: \{nmae\}/)).toBeVisible();
    // Insert follows the caret: into the subject when that was the last field.
    await page.getByRole('dialog').getByRole('textbox', { name: 'Subject' }).click();
    await page.keyboard.press('End');
    await page.getByRole('dialog').getByRole('button', { name: 'Insert {email}' }).click();
    await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Subject' })).toHaveValue('Maintenance tonight {email}');
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
    // Columns sort from their header: first click ascending, second descending.
    const serversHeader = page.getByRole('columnheader', { name: 'Servers' });
    await serversHeader.click();
    await expect(serversHeader).toHaveAttribute('aria-sort', 'ascending');
    await serversHeader.click();
    await expect(serversHeader).toHaveAttribute('aria-sort', 'descending');
    // The order is kept for this tab: a reload (or coming back from a user) keeps it.
    await page.reload();
    await expect(serversHeader).toHaveAttribute('aria-sort', 'descending');
    // The whole row opens the person: a click outside its controls, or Enter on a row reached with the keys.
    const adminRow = page.getByRole('row', { name: /admin@example\.test/ }).first();
    await adminRow.getByText('Active', { exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Recent activity');
    await page.getByRole('dialog').locator('[data-slot="modal-close-trigger"]').click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await adminRow.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toContainText('Recent activity');
    await page.getByRole('dialog').locator('[data-slot="modal-close-trigger"]').click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    await shot(page, 'users-390');
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.waitForTimeout(400);
    // On a tablet the header search stays on one line.
    expect((await page.locator('header').getByRole('button', { name: /^Search or jump to/ }).first().boundingBox())!.height, 'header search height at 820 px').toBeLessThanOrEqual(40);
    await shot(page, 'users-820');
    await page.setViewportSize({ width: 1280, height: 720 });
    // Who is here: the overview's "Online now" shows this admin; the users' "Online or active" card filters to them.
    await page.goto('/admin');
    await expect(page.getByRole('list', { name: 'Online now' }).getByRole('listitem').first()).toBeVisible();
    // Status shortcuts: just joined lists the test's new user; dormant leaves out the admin who is here now.
    await page.goto('/admin/users?status=new');
    await expect(page.getByRole('main').getByText(/user-\d+@example\.test/).filter({ visible: true }).first()).toBeVisible();
    await page.goto('/admin/users?status=inactive');
    await expect(page.getByRole('main').getByText('admin@example.test')).toHaveCount(0);
    await page.goto('/admin/users');
    await page.getByRole('button', { name: /banned/ }).click();
    await expect(page).toHaveURL(/status=banned/);
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

// RFC 6238 code for a base32 secret, as an authenticator app computes it.
async function totp(secret: string) {
  const { createHmac } = await import('node:crypto');
  const bits = secret.replace(/=+$/, '').toUpperCase().split('').map((c) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

// What authenticator apps and passkey managers show for this panel: its own name, as Settings → Branding has it.
const issuerOf = (brand: string) => brand.replace(/[\u0000-\u001f\u007f:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64).trim() || 'Lightning VM';
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('names are proposed: a passkey by browser and authenticator, an API token by its access, an SSH key by its comment, a ticket subject offered from the message', async ({ browser }) => {
  const page = await (await browser.newContext({ locale: 'en-US' })).newPage();
  page.on('dialog', (d) => void d.accept()); // fields are left half-typed on purpose: leaving the page is fine
  await signIn(page, user);
  await expect(page).toHaveURL(/\/$/);
  const brand = (await (await page.request.get('/api/public/config')).json()).branding.name as string;
  // Passkey: browser, system and device from this browser, ready to be sent; the hint says it is a proposal.
  await page.goto('/account?tab=security');
  const passkeyName = page.getByRole('textbox', { name: 'Name (optional)' });
  await expect(passkeyName).toHaveValue(/^(Chrome|Chromium) · (Linux|Windows|macOS|ChromeOS) · Desktop$/);
  await expect(page.locator('#passkeys').getByText('Proposed by the panel; what you type replaces it.')).toBeVisible();
  const proposed = await passkeyName.inputValue();
  // No authenticator in a test browser: navigator.credentials answers as a USB security key would, and the panel's
  // verify and rename calls are caught here (nothing is stored). The server's own options are real.
  let renamed: { id?: string; name?: string } | undefined;
  await page.route('**/api/auth/passkey/verify-registration', (route) => route.fulfill({ json: { id: 'e2e-passkey', name: route.request().postDataJSON().name, createdAt: new Date().toISOString() } }));
  await page.route('**/api/auth/passkey/update-passkey', (route) => { renamed = route.request().postDataJSON(); return route.fulfill({ json: { passkey: { id: 'e2e-passkey', name: renamed?.name } } }); });
  await page.evaluate(() => {
    const buf = (n: number) => new Uint8Array([n, n, n]).buffer;
    Object.defineProperty(navigator.credentials, 'create', { configurable: true, value: async () => ({ id: 'AQID', rawId: buf(1), type: 'public-key', authenticatorAttachment: 'cross-platform',
      response: { clientDataJSON: buf(2), attestationObject: buf(3), getTransports: () => ['usb'] }, getClientExtensionResults: () => ({}) }) });
  });
  const options = page.waitForResponse((r) => r.url().includes('/api/auth/passkey/generate-register-options'));
  await page.getByRole('button', { name: 'Add passkey' }).click();
  const sent = await options;
  // The passkey manager files it under the panel's name and the account's address, not under the passkey's name.
  expect(new URL(sent.url()).searchParams.get('name')).toBe(proposed);
  const opts = await sent.json() as { rp: { name: string }; user: { name: string } };
  expect([opts.rp.name, opts.user.name]).toEqual([issuerOf(brand), user.email]);
  await expect(page.getByText('Passkey added.')).toBeVisible();
  // The browser said it was a security key: that goes in front, the device kind (this computer's) goes.
  expect(renamed).toEqual({ id: 'e2e-passkey', name: `Security key · ${proposed.replace(/ · Desktop$/, '')}` });
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  // API token: what it may do and the day, following the access chosen until a name is typed.
  await page.goto('/account?tab=api');
  const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  const tokenName = page.getByRole('textbox', { name: 'Name', exact: true });
  await expect(tokenName).toHaveValue(`Read-only token ${today}`);
  await choose(page, page, / Access$/, 'Full access');
  await expect(tokenName).toHaveValue(`Full-access token ${today}`);
  await tokenName.fill('deploy script');
  await choose(page, page, / Access$/, 'Read-only');
  await expect(tokenName).toHaveValue('deploy script');
  await tokenName.fill('');
  await expect(page.getByRole('button', { name: 'Create token' })).toBeDisabled();

  // SSH key: the key's own comment, as soon as it is pasted.
  await page.goto('/account?tab=keys');
  await page.getByLabel('Public key').fill('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl laptop@e2e');
  await expect(page.getByLabel('Key name')).toHaveValue('laptop@e2e');
  await page.getByLabel('Public key').fill('');
  await expect(page.getByLabel('Key name')).toHaveValue('');

  // Ticket: the subject is never filled in for the customer; the message's first line is offered with one click.
  await page.goto('/support?new=1');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Message').fill('SSH refuses the connection since this morning.\nPort 22 answers with connection refused.');
  const idea = dialog.getByRole('group', { name: 'Suggestion' }).getByRole('button');
  await expect(idea).toHaveText('SSH refuses the connection since this morning.');
  await expect(dialog.getByLabel('Subject')).toHaveValue('');
  await idea.click();
  await expect(dialog.getByLabel('Subject')).toHaveValue('SSH refuses the connection since this morning.');
  await expect(idea).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoOverflow(page, 'new ticket with a proposed subject at 390 px');
  // Nothing is sent; the draft goes.
  await dialog.getByLabel('Subject').fill('');
  await dialog.getByLabel('Message').fill('');
  await page.context().close();
});

test('second step at sign-in offers only the methods the account has', async ({ browser }) => {
  test.setTimeout(120_000); // waits for the next 30-second code window
  const page = await (await browser.newContext({ locale: 'tr-TR' })).newPage();
  await signIn(page, user);
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/account?tab=security');
  await page.getByRole('button', { name: 'İki adımlı doğrulamayı aç' }).click();
  const dialog = page.getByRole('dialog');
  // E2E has no mail or SMS, so the app is the only way to set it up.
  await dialog.getByLabel('Mevcut parola').fill(user.password);
  const enabled = page.waitForResponse((r) => r.url().endsWith('/api/auth/two-factor/enable'));
  await dialog.getByRole('button', { name: 'Devam' }).click();
  // The authenticator app lists the panel by its own name and the account by its address: label and issuer both,
  // percent-encoded (a space is %20, never "+").
  const issuer = issuerOf((await (await page.request.get('/api/public/config')).json()).branding.name as string);
  const uri = (await (await enabled).json()).totpURI as string;
  expect(uri).toMatch(new RegExp(`^otpauth://totp/${escape(encodeURIComponent(issuer))}:${escape(encodeURIComponent(user.email))}\\?secret=[A-Z2-7]+&issuer=${escape(encodeURIComponent(issuer))}&digits=6`));
  expect(uri).not.toContain('+');
  await expect(dialog.getByTestId('totp-label')).toHaveText(`Uygulamada görünecek ad: ${issuer} (${user.email})`);
  const secret = (await dialog.locator('code').innerText()).trim();
  await dialog.getByRole('textbox', { name: 'Doğrulama kodu' }).fill(await totp(secret));
  // The backup codes' file says whose they are, in the panel's language.
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'İndir' }).click();
  expect((await download).suggestedFilename()).toMatch(/^([a-z0-9-]+-)?yedek-kodlar\.txt$/);
  await dialog.getByRole('button', { name: 'Kodları kaydettim' }).click();
  await expect(page.getByText('İki adımlı doğrulama açıldı.')).toBeVisible();

  const again = await (await browser.newContext({ locale: 'tr-TR' })).newPage();
  await again.setViewportSize({ width: 390, height: 844 });
  await signIn(again, user);
  const tabs = again.getByRole('tablist', { name: 'İki adımlı doğrulama' });
  await expect(tabs.getByRole('tab')).toHaveText(['Uygulama', 'Yedek kod']);
  await expect(tabs.getByRole('tab', { name: 'Uygulama' })).toHaveAttribute('aria-selected', 'true');
  await expectNoOverflow(again, 'second step at 390 px');
  await tour(again, 'login-second-step-390');
  await again.setViewportSize({ width: 1280, height: 800 });
  await tour(again, 'login-second-step');
  // A fresh code (the one used for setup may not be taken twice).
  await expect.poll(async () => totp(secret), { timeout: 35_000, intervals: [1000] }).not.toBe(await totp(secret));
  await again.getByRole('textbox', { name: 'Doğrulama kodu' }).fill(await totp(secret));
  await expect(again).toHaveURL(/\/$/, { timeout: 15_000 });
});
