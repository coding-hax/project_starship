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
 */
let pool: Pool | undefined;
let instance: NodePgDatabase<typeof schema> | undefined;

function connect(): NodePgDatabase<typeof schema> {
  if (instance) return instance;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local.');
  }

  pool = new Pool({ connectionString: url });
  instance = drizzle(pool, { schema });
  return instance;
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
