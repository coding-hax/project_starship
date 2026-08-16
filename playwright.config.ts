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
  // Throwaway VAPID keypair (issue #122) generated solely for this test run — not
  // a real secret, not tied to any device or account, never used outside the E2E
  // suite. Real deployments generate their own via `npx web-push generate-vapid-keys`
  // and keep VAPID_PRIVATE_KEY out of the repo (ADR-0010, .env.example).
  NEXT_PUBLIC_VAPID_PUBLIC_KEY:
    'BGPrJFHUqtjjSLRI_8sRvW1AGoogzhtSCbyrSCUioJlBpBw2RIH113USwjkfN5egVnSeuqNSDUD3sCSAbhrLRCE',
  VAPID_PRIVATE_KEY: 'izNKwr3NI2wtJth6i-nqAz0fBXNH-I0sIx90d0_bU44',
  VAPID_SUBJECT: 'mailto:e2e@example.com',
  // Throwaway bearer value for the reminders cron route (#239) — same idea as the
  // VAPID keypair above: without it the route's "never fall open" guard answers
  // every request with 503 before the owner-session check ever runs.
  REMINDER_SECRET: 'e2e-throwaway-reminder-secret',
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
  // fullyParallel only changes how tests are handed out for sharding/ordering — with
  // workers fixed at 1 below, exactly one test still runs at a time. Without it,
  // `--shard` divides by file, not by test, so shards land unevenly (#118). A second
  // concurrent *run* is still refused by the run-lock in global-setup.ts below —
  // that's the actual guard against fighting over one database.
  fullyParallel: true,
  globalSetup: './tests/global-setup.ts',
  globalTeardown: './tests/global-teardown.ts',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // one database, one owner — parallel workers would fight over it
  reporter: process.env.CI ? [['html'], ['list']] : 'list',

  use: {
    baseURL,
    // Read the trace before changing anything (WORKFLOW.md). Artefacts only on failure —
    // a green run should not cost a gigabyte.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  // Feature tests run in ONE viewport: 375 × 812. The second one is gone (#564) —
  // see the `mobile` project below for what that cost and why it was still done.
  // Three specs are the exception and run only against the prod-build projects
  // below: offline-critical.spec.ts and push-sw.prod.spec.ts need a real service
  // worker (Serwist is disabled in dev, see next.config.ts), and smoke.prod.spec.ts
  // asserts a production artefact (`/sw.js`). The latter used to run here and passed
  // only because an earlier `pnpm build` had left `public/sw.js` behind for the dev
  // server to serve — an accident, not coverage (#115).
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
    // The `desktop` twin of this project is gone (#564). It was exactly half the
    // suite — 573 tests, 48.8 of the 98 minutes `e2e-main` spent running them — and
    // 568 of those 573 were the same assertions replayed at 1280 × 800. Dropping it
    // takes `e2e-main` from ~13 min to ~6 min of wall clock.
    //
    // The remaining 5 were NOT duplicates, and they are the real price of this
    // change: `shell.desktop.spec.ts` (3) and `nav-order.desktop.spec.ts` (2) cover
    // layout that only exists on a wide screen (#126: the settings entry point is
    // inline on Heute for mobile, in the sidebar for desktop). Nothing runs them
    // anymore. Both files stay in the repo on purpose — "erstmal" means desktop can
    // come back by re-adding the project, and deleting the files would drop the
    // `test(` count that `test-integrity` guards. So: this project's `testIgnore`
    // still excludes `*.desktop.spec.ts`, which now means those specs match no
    // project at all. Playwright does not warn about that. This comment is the warning.
    {
      name: 'mobile',
      testIgnore:
        /(offline-critical|smoke\.prod|push-sw\.prod|shipped\.prod|navigation\.prod|csp\.prod|.*\.desktop)\.spec\.ts$/,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 375, height: 812 },
        storageState: AUTH_STATE,
      },
    },
    {
      name: 'offline-mobile',
      testMatch: /(offline-critical|smoke\.prod|push-sw\.prod|navigation\.prod|csp\.prod)\.spec\.ts$/,
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
      testMatch: /(offline-critical|smoke\.prod|push-sw\.prod|navigation\.prod|csp\.prod)\.spec\.ts$/,
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
