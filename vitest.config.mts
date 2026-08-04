import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';
import { slotWorkerLimit } from './vitest.pool.mts';

export default defineConfig({
  test: {
    environment: 'node',
    // Playwright owns tests/. Vitest owns the logic specs next to the code.
    include: ['src/**/*.test.ts', 'scripts/runner/**/*.test.ts', 'vitest.pool.test.ts'],
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
