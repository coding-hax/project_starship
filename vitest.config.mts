import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';
import { slotWorkerLimit } from './vitest.pool.mts';

export default defineConfig({
  test: {
    environment: 'node',
    // Playwright owns tests/ as a directory of specs, but `route-readiness.ts` and the
    // exported probe in `global-setup.ts` (issue #1142) are framework-agnostic/DB-free
    // logic that happens to live next to auth.setup.ts — same reasoning as the
    // scripts/runner exception below. playwright.config.ts's `mobile` project excludes
    // both files from Playwright's own discovery.
    include: [
      'src/**/*.test.ts',
      'scripts/runner/**/*.test.ts',
      'tests/route-readiness.test.ts',
      'tests/global-setup.test.ts',
      'vitest.pool.test.ts',
    ],
    // Needs a real Postgres (MVCC snapshot semantics a mock cannot have, fund
    // F1 / #472) — runs separately via `pnpm test:db` in a job that has one
    // (vitest.db.config.mts), not in this DB-free default tier.
    exclude: [...configDefaults.exclude, 'src/app/api/sync/pull/route.test.ts'],
    ...slotWorkerLimit(),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
