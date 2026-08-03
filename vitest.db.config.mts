import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

/**
 * The one Vitest tier that needs a real Postgres — DATABASE_URL, real MVCC
 * snapshot semantics (fund F1 / #472). Kept out of `vitest.config.mts` /
 * `pnpm test` so that stays DB-free and runs in a fresh worktree with no
 * database configured. Run via `pnpm test:db`, wired into `e2e-offline` in
 * `.github/workflows/ci.yml`, the first job that already has both a Postgres
 * service and `pnpm db:migrate`.
 *
 * Next.js reads .env.local implicitly; a standalone Vitest config does not
 * (same reason drizzle.config.ts and src/db/migrate.ts load it explicitly).
 * In CI there is no .env.local — config() no-ops and the workflow's own
 * DATABASE_URL env var stands, since dotenv never overwrites an existing var.
 */
config({ path: '.env.local' });

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/app/api/sync/pull/route.test.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
