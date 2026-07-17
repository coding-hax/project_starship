import { defineConfig, devices } from '@playwright/test';
import { config } from 'dotenv';
import { PORT } from './tests/run-lock';

// The specs assert against the real database, so they need DATABASE_URL.
// In CI it comes from the environment and the missing file is fine.
config({ path: '.env.local' });

const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests',
  // Owns its own config (playwright.smoke.config.ts) and target — no webServer, no
  // DB run-lock, points at SMOKE_URL instead of the local dev server. See #56.
  testIgnore: /smoke\.prod\.spec\.ts$/,
  fullyParallel: false, // one database, one owner — parallel runs would fight over it
  // …and this enforces it: a second concurrent run aborts instead of wiping our credentials.
  globalSetup: './tests/global-setup.ts',
  globalTeardown: './tests/global-teardown.ts',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['html'], ['list']] : 'list',

  use: {
    baseURL,
    // Read the trace before changing anything (WORKFLOW.md). Artefacts only on failure —
    // a green run should not cost a gigabyte.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  // Every feature test runs in both viewports. A layout that only works on desktop
  // is not done.
  projects: [
    {
      name: 'mobile',
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 } },
    },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],

  webServer: {
    command: 'pnpm dev --port ' + PORT,
    url: baseURL,
    // Never reuse: a foreign process on 3100 (or a dev server on its way out) would be
    // adopted silently, and every test would then fail with ERR_CONNECTION_REFUSED.
    // Refusing to start says what is wrong; reusing hides it.
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_E2E: '1',
      RP_ID: 'localhost',
      RP_ORIGIN: baseURL,
      RP_NAME: 'Starship',
    },
  },
});
