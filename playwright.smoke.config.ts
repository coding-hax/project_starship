import { defineConfig, devices } from '@playwright/test';
import { PORT } from './tests/run-lock';

/**
 * Separate from playwright.config.ts on purpose: the main config's globalSetup takes
 * the local DB run-lock (tests/global-setup.ts) and its webServer boots a dev server —
 * both wrong against a real, already-running production deployment.
 *
 * SMOKE_URL defaults to the local dev server so `pnpm e2e:smoke` also works against
 * `pnpm dev` running on the side, without requiring a real deploy to test against.
 */
export default defineConfig({
  testDir: './tests',
  testMatch: /smoke\.prod\.spec\.ts$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['html'], ['list']] : 'list',

  use: {
    baseURL: process.env.SMOKE_URL ?? `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'smoke', use: { ...devices['Desktop Chrome'] } }],
});
