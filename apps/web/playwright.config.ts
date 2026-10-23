import { defineConfig } from '@playwright/test';

// E2E_BASE_URL runs the suite against an existing deployment (e.g. Compose behind Caddy).
const external = process.env.E2E_BASE_URL;
export default defineConfig({
  testDir: 'e2e',
  use: { baseURL: external ?? 'http://127.0.0.1:3100' },
  webServer: external ? undefined : { command: 'npx next start -p 3100 -H 127.0.0.1', url: 'http://127.0.0.1:3100', reuseExistingServer: false, timeout: 60_000 },
});
