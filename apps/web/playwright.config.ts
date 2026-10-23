import { defineConfig } from '@playwright/test';

// Runs against a full Compose deployment (web + API + PostgreSQL + Redis behind Caddy).
// A fresh install needs E2E_BOOTSTRAP_TOKEN from `docker compose exec api node dist/cli.js bootstrap-token`.
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080' },
});
