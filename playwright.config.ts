import { defineConfig, devices } from '@playwright/test';
import { config } from 'dotenv';
import { AUTH_STATE, PORT, PORT_PROD } from './tests/run-lock';

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
  // No config-level testIgnore on purpose (#115): a project that declares its own
  // `testIgnore` REPLACES the config-level one, so a global rule here would silently
  // apply to some projects and not others. Every project below states its own scope.
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
  // is not done. Two specs are the exception and run only against the prod-build
  // projects below: offline-critical.spec.ts needs a real service worker, and
  // smoke.prod.spec.ts asserts a production artefact (`/sw.js`). The latter used to
  // run here and passed only because an earlier `pnpm build` had left `public/sw.js`
  // behind for the dev server to serve — an accident, not coverage (#115).
  projects: [
    // Runs the real WebAuthn ceremony once and leaves the session in AUTH_STATE; every
    // project below starts from it instead of registering a passkey per test (#115).
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        // Whichever server this scope actually boots.
        baseURL: E2E_SCOPE === 'offline' ? baseURLProd : baseURL,
      },
    },
    // A handful of shell assertions only hold in one layout (#126: the settings entry
    // point is inline on Heute for mobile, in the sidebar for desktop). Those live in
    // `*.mobile.spec.ts` / `*.desktop.spec.ts` and are routed by project here — the way
    // Playwright scopes tests to a viewport. Doing it with `test.skip(project.name !== …)`
    // inside a shared file would be a runtime skip, which `test-integrity` rejects and
    // rightly so: nothing in the file tells a scoped test apart from a disabled one.
    {
      name: 'mobile',
      testIgnore: /(offline-critical|smoke\.prod|.*\.desktop)\.spec\.ts$/,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 375, height: 812 },
        storageState: AUTH_STATE,
      },
    },
    {
      name: 'desktop',
      testIgnore: /(offline-critical|smoke\.prod|.*\.mobile)\.spec\.ts$/,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        storageState: AUTH_STATE,
      },
    },
    {
      name: 'offline-mobile',
      testMatch: /(offline-critical|smoke\.prod)\.spec\.ts$/,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: AUTH_STATE,
        viewport: { width: 375, height: 812 },
        baseURL: baseURLProd,
      },
    },
    {
      name: 'offline-desktop',
      testMatch: /(offline-critical|smoke\.prod)\.spec\.ts$/,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: AUTH_STATE,
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
