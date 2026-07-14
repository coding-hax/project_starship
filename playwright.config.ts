import { defineConfig, devices } from '@playwright/test';
import { config } from 'dotenv';

// The specs assert against the real database, so they need DATABASE_URL.
// In CI it comes from the environment and the missing file is fine.
config({ path: '.env.local' });

const PORT = 3100;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false, // one database, one owner — parallel runs would fight over it
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
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_E2E: '1',
      RP_ID: 'localhost',
      RP_ORIGIN: baseURL,
      RP_NAME: 'Starship',
    },
  },
});
