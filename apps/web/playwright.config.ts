import { defineConfig } from '@playwright/test';

// Runs against a full Compose deployment (web + API + PostgreSQL + Redis behind Caddy).
// A fresh install needs E2E_BOOTSTRAP_TOKEN from `docker compose exec api node dist/cli.js bootstrap-token`.
// The README's screenshots (e2e/showcase.spec.ts) set up a deployment of their own and are no test of anything: they run
// only when asked for, by E2E_SHOWCASE=1 or by a title filter that names them (E2E_GREP, as the demo server's script passes it).
//
// Browsers: the whole suite in Chromium; then the tests named "@smoke" in Firefox and WebKit (Safari's engine), once
// Chromium has set the deployment up (they need its administrator). The whole suite three times would take over an
// hour in CI; the smoke set covers signing in, the dashboard at phone width, the command palette and the Undo message.
// E2E_BROWSERS=chromium leaves the other two out (a machine without them installed).
const showcase = process.env.E2E_SHOWCASE === '1' || /showcase/i.test(process.env.E2E_GREP ?? '');
const only = (process.env.E2E_BROWSERS ?? 'chromium,firefox,webkit').split(',').map((b) => b.trim());
const use = { baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080', actionTimeout: 20_000, navigationTimeout: 30_000 };
export default defineConfig({
  testDir: 'e2e',
  testIgnore: showcase ? [] : ['**/showcase.spec.ts'],
  workers: 1,
  // A step that cannot happen fails after 20 s with its locator, instead of waiting out the whole test.
  use,
  projects: [
    { name: 'chromium', use: { ...use, browserName: 'chromium' } },
    ...(['firefox', 'webkit'] as const).filter((b) => only.includes(b)).map((b) => ({
      name: b, grep: /@smoke/, testMatch: ['ux2.spec.ts'], dependencies: ['chromium'],
      use: { ...use, browserName: b },
    })),
  ],
});
