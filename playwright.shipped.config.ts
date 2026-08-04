import { defineConfig, devices } from '@playwright/test';
import { config } from 'dotenv';
import { PORT_SHIPPED } from './tests/run-lock';

// The specs assert against the real database, so they need DATABASE_URL.
// In CI it comes from the environment and the missing file is fine.
config({ path: '.env.local' });

const baseURL = `http://localhost:${PORT_SHIPPED}`;

/**
 * Separate from playwright.config.ts on purpose (#497): the main config's `prodServer`
 * builds WITH `NEXT_PUBLIC_E2E=1` for offline-critical.spec.ts/push-sw.prod.spec.ts —
 * exactly the flag that tree-shakes out the service worker's E2E-only branches
 * (src/app/sw.ts) and the E2E bridge (src/app/(app)/layout.tsx) in the real bundle.
 * That build never proved the branch that actually ships still boots. This config
 * builds WITHOUT the flag — the real, shipped artefact — on its own port so the two
 * builds don't fight over `.next`.
 *
 * No `setup`/AUTH_STATE project: that session was captured against the E2E-flagged
 * build's origin, and shipped.prod.spec.ts registers its own passkey per test.
 */
export default defineConfig({
  testDir: './tests',
  testMatch: /shipped\.prod\.spec\.ts$/,
  fullyParallel: true,
  globalSetup: './tests/global-setup.ts',
  globalTeardown: './tests/global-teardown.ts',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // one database, one owner — same reasoning as playwright.config.ts
  reporter: process.env.CI ? [['html'], ['list']] : 'list',

  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'shipped-mobile',
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 } },
    },
    {
      name: 'shipped-desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],

  webServer: {
    // NEXT_PUBLIC_E2E is deliberately absent — this is the build that ships.
    command: `pnpm build && pnpm start --port ${PORT_SHIPPED}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 300_000, // production build
    env: {
      RP_ID: 'localhost',
      RP_NAME: 'Starship',
      RP_ORIGIN: baseURL,
      // Real (not E2E-specific) keys — production has these too, just generated for
      // real (ADR-0010). Same throwaway-but-well-formed reasoning as e2eEnv in
      // playwright.config.ts: never a real secret, never used outside this run.
      NEXT_PUBLIC_VAPID_PUBLIC_KEY:
        'BGPrJFHUqtjjSLRI_8sRvW1AGoogzhtSCbyrSCUioJlBpBw2RIH113USwjkfN5egVnSeuqNSDUD3sCSAbhrLRCE',
      VAPID_PRIVATE_KEY: 'izNKwr3NI2wtJth6i-nqAz0fBXNH-I0sIx90d0_bU44',
      VAPID_SUBJECT: 'mailto:e2e@example.com',
      REMINDER_SECRET: 'e2e-throwaway-reminder-secret',
    },
  },
});
