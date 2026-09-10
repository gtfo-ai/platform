/**
 * Playwright (technical/10 § UI: "Playwright e2e with fake SSE backend", Playwright 1.63).
 *
 * The suite runs against the **built** SPA served by `test/web-e2e/support/fake-backend.ts` on one
 * origin, which is the arrangement technical/08 describes for production and the only one in which
 * the session cookie, the CSRF header and `EventSource`'s same-origin credentials mean anything. A
 * Vite dev server behind a proxy would test a topology nothing ships.
 *
 * technical/09 says "Playwright e2e against the Docker image": the image is WP-22's, and running
 * against it needs a compose file that does not exist. This is the same coverage without a second
 * image to build on every run, and it is recorded as the substitution it is.
 *
 * No retries and no `test.slow()`: a wall-clock assertion is a hardware assertion (standing rule
 * 2), and everything here waits on Playwright's own auto-waiting expectations instead.
 */
import process from 'node:process';
import { defineConfig, devices } from '@playwright/test';

const port = Number.parseInt(process.env['WEB_E2E_PORT'] ?? '4318', 10);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './test/web-e2e',
  // Every test drives the same fake backend, whose SSE control endpoints are global state.
  workers: 1,
  fullyParallel: false,
  forbidOnly: process.env['CI'] === 'true',
  retries: 0,
  reporter: process.env['CI'] === 'true' ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // The build is part of the command rather than a `globalSetup`, so a stale `dist/` can never
    // be what the suite tested.
    command:
      'pnpm --filter @platform/web run build && node --import ./scripts/ts-source-resolver.mjs test/web-e2e/support/serve.ts',
    // `/__test__/streams` answers 200 without a session; `/api/*` deliberately does not.
    url: `${baseURL}/__test__/streams`,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
  },
});
