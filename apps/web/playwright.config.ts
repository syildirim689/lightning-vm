import { defineConfig } from '@playwright/test';

// Runs against a full Compose deployment (web + API + PostgreSQL + Redis behind Caddy).
// A fresh install needs E2E_BOOTSTRAP_TOKEN from `docker compose exec api node dist/cli.js bootstrap-token`.
// The README's screenshots (e2e/showcase.spec.ts) set up a deployment of their own and are no test of anything: they run
// only when asked for, by E2E_SHOWCASE=1 or by a title filter that names them (E2E_GREP, as the demo server's script passes it).
const showcase = process.env.E2E_SHOWCASE === '1' || /showcase/i.test(process.env.E2E_GREP ?? '');
export default defineConfig({
  testDir: 'e2e',
  testIgnore: showcase ? [] : ['**/showcase.spec.ts'],
  workers: 1,
  // A step that cannot happen fails after 20 s with its locator, instead of waiting out the whole test.
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080', actionTimeout: 20_000, navigationTimeout: 30_000 },
});
