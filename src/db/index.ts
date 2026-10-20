import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

/**
 * The connection is opened on first use, not on import.
 *
 * Importing this module used to throw when DATABASE_URL was unset — which meant the
 * *build* needed a database, not just the runtime. `next build` imports every route
 * to collect page data, so a Vercel preview without env vars died with
 * "Failed to collect page data for /api/auth/login/options" instead of anything
 * resembling the real problem. A missing variable must surface where it is actually
 * needed: at the first query.
 *
 * A plain connection string, no provider-specific driver — ADR-0001 requires that
 * moving off Neon stays a configuration change, not a rewrite.
 *
 * Cached on `globalThis`, not a plain module-level variable — `next dev`
 * re-evaluates this module on on-demand compiles/HMR without tearing down the
 * previous instance first. A module-level `let` would mint a brand-new,
 * unrelated `Pool` each time that happens, and a write committed through one
 * pool was then not reliably visible yet to a query issued moments later
 * through a freshly-minted other one — observed as e2e flakes where a PATCH's
 * own confirmed response disagreed with a page reload or a raw verification
 * query seconds later (`auth-geraete.spec.ts` AK1, `admin-aktionen.spec.ts`
 * AK2, #1224). `globalThis` survives the module re-evaluation; production
 * never HMRs, so this is a no-op behavior change there.
 */
const globalForDb = globalThis as unknown as {
  dbPool?: Pool;
  dbInstance?: NodePgDatabase<typeof schema>;
};

function connect(): NodePgDatabase<typeof schema> {
  if (globalForDb.dbInstance) return globalForDb.dbInstance;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local.');
  }

  globalForDb.dbPool = new Pool({ connectionString: url });
  globalForDb.dbInstance = drizzle(globalForDb.dbPool, { schema });
  return globalForDb.dbInstance;
}

/**
 * Behaves like the drizzle instance, but resolves it lazily. Callers keep writing
 * `db.select()…` and never learn that the pool did not exist a moment ago.
 */
export const db = new Proxy({} as NodePgDatabase<typeof schema>, {
  get(_target, property, receiver) {
    return Reflect.get(connect(), property, receiver);
  },
});

export { schema };
