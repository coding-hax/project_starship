import { defineConfig, devices } from '@playwright/test';
import { config } from 'dotenv';
import { PORT, PORT_PROD } from './tests/run-lock';

// The specs assert against the real database, so they need DATABASE_URL.
// In CI it comes from the environment and the missing file is fine.
config({ path: '.env.local' });

const baseURL = `http://localhost:${PORT}`;
const baseURLProd = `http://localhost:${PORT_PROD}`;

// The service worker is only built in production (next.config.ts: `disable:
// NODE_ENV === 'development'`) — the dev server the other projects use never
// registers one. offline-critical.spec.ts needs the real thing, so it gets its
// own prod-build server instead.
const e2eEnv = {
  NEXT_PUBLIC_E2E: '1',
  RP_ID: 'localhost',
  RP_NAME: 'Starship',
};

// 'main' = dev server only, 'offline' = production build only, unset = both (#115).
const E2E_SCOPE = process.env.E2E_SCOPE ?? 'all';

const devServer = {
  command: 'pnpm dev --port ' + PORT,
  url: baseURL,
  // Never reuse: a foreign process on 3100 (or a dev server on its way out) would be
  // adopted silently, and every test would then fail with ERR_CONNECTION_REFUSED.
  // Refusing to start says what is wrong; reusing hides it.
  reuseExistingServer: false,
  timeout: 120_000,
  env: { ...e2eEnv, RP_ORIGIN: baseURL },
};

const prodServer = {
  // NEXT_PUBLIC_E2E is inlined at build time — it must be set on the build step
  // too, or the E2E bridge (src/ui/e2e-bridge.tsx) is simply missing from the bundle.
  command: `pnpm build && pnpm start --port ${PORT_PROD}`,
  url: baseURLProd,
  reuseExistingServer: false,
  // A production build needs more room than the dev server's plain boot.
  timeout: 300_000,
  env: { ...e2eEnv, RP_ORIGIN: baseURLProd },
};

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
  // is not done. offline-critical.spec.ts is the exception — it needs a real service
  // worker, so it runs only against the prod-build projects below.
  projects: [
    {
      name: 'mobile',
      testIgnore: /offline-critical\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 } },
    },
    {
      name: 'desktop',
      testIgnore: /offline-critical\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'offline-mobile',
      testMatch: /offline-critical\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 375, height: 812 },
        baseURL: baseURLProd,
      },
    },
    {
      name: 'offline-desktop',
      testMatch: /offline-critical\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        baseURL: baseURLProd,
      },
    },
  ],

  // `webServer` is global: Playwright boots EVERY entry before any project runs. So a
  // run that only needs the dev server would still pay the full production build —
  // which only offline-critical.spec.ts actually needs. E2E_SCOPE (#115) lets CI split
  // the suite into two parallel jobs, each booting just its own server. Unset (a plain
  // local `pnpm e2e`) keeps both, so nothing changes for developers.
  webServer: [
    ...(E2E_SCOPE === 'offline' ? [] : [devServer]),
    ...(E2E_SCOPE === 'main' ? [] : [prodServer]),
  ],
});
