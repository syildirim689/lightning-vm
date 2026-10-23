import { expect, test, type Page } from '@playwright/test';

// The API is not running here; its responses are stubbed per test, the UI is real.
const lastSeen = '2026-10-23T19:25:05.000Z';
async function stubApi(page: Page, ready: { status: number; body: object } | 'offline') {
  await page.route('**/api/ready', (route) => ready === 'offline' ? route.abort() : route.fulfill({ status: ready.status, json: ready.body }));
  await page.route('**/api/system', (route) => route.fulfill({ json: { worker: [{ name: 'default', last_seen: lastSeen, healthy: true }] } }));
}
function failOnConsoleErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}

test.describe('Turkish browser', () => {
  test.use({ locale: 'tr-TR' });
  test('first visit uses Turkish', async ({ page }) => {
    const errors = failOnConsoleErrors(page);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sunucularınız');
    expect(errors).toEqual([]);
  });

  test('API error code is translated, not shown raw', async ({ page }) => {
    await stubApi(page, { status: 503, body: { code: 'DEPENDENCY_UNAVAILABLE', message: 'Dependencies unavailable' } });
    await page.goto('/admin');
    await expect(page.getByRole('status')).toHaveText('PostgreSQL veya Redis şu anda erişilemiyor.');
  });

  test('unknown API error code falls back to a translated message', async ({ page }) => {
    await stubApi(page, { status: 500, body: { code: 'SOMETHING_NEW' } });
    await page.goto('/admin');
    await expect(page.getByRole('status')).toHaveText('Bilinmeyen bir hata oluştu.');
  });

  test('network failure is distinguished from API errors', async ({ page }) => {
    await stubApi(page, 'offline');
    await page.goto('/admin');
    await expect(page.getByRole('status')).toContainText('Sunucuya ulaşılamadı');
  });

  test('dates use Turkish formatting', async ({ page }) => {
    await stubApi(page, { status: 200, body: { status: 'ready' } });
    await page.goto('/admin');
    await expect(page.getByText('Arka plan çalışanı: Çalışıyor')).toContainText('23 Eki 2026 19:25:05');
  });

  test('choosing English overrides the browser language and persists', async ({ page, context }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your servers');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
    expect((await context.cookies()).find((c) => c.name === 'NEXT_LOCALE')?.value).toBe('en');
  });
});

test.describe('English browser', () => {
  test.use({ locale: 'en-US' });
  test('first visit uses English and English dates', async ({ page }) => {
    await stubApi(page, { status: 200, body: { status: 'ready' } });
    await page.goto('/admin');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByText('Background worker: Running')).toContainText('Oct 23, 2026, 7:25:05 PM');
  });
});

test.describe('Unsupported browser language', () => {
  test.use({ locale: 'de-DE' });
  test('falls back to English', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });
});
