import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { users } from '@/db/schema';
import { SYNC_TABLES } from '@/local/types';

/**
 * Per-account quota (#1205, S6) when `users.storage_limit_bytes` is `NULL` — see
 * the column's doc comment in `src/db/schema.ts` for why that's an override, not
 * a column default.
 */
export const DEFAULT_STORAGE_LIMIT_BYTES = 100 * 1024 * 1024; // 100 MB

export function effectiveLimit(user: { storageLimitBytes: number | null }): number {
  return user.storageLimitBytes ?? DEFAULT_STORAGE_LIMIT_BYTES;
}

/**
 * Ist-Verbrauch eines Kontos: Summe `pg_column_size(t.*)` über jede synchronisierte
 * Tabelle (`SYNC_TABLES`), inklusive Tombstones und Journal-Chiffraten — ein
 * grober, aber ehrlicher Ist-Wert, ohne TOAST-/Index-Overhead. `pg_column_size`
 * ist Standard-Postgres, kein Vendor-Primitiv (ADR-0001).
 */
export async function accountStorageBytes(userId: string): Promise<number> {
  const perTable = SYNC_TABLES.map(
    (table) =>
      sql`coalesce((select sum(pg_column_size(t.*)) from ${sql.identifier(table)} as t where t.user_id = ${userId}), 0)`,
  );
  const result = await db.execute<{ bytes: string | null }>(
    sql`select (${sql.join(perTable, sql` + `)})::bigint as bytes`,
  );
  return Number(result.rows[0]?.bytes ?? 0);
}

/**
 * Fail-open, same stance as `enforce()` in `src/auth/rate-limit.ts`: a broken
 * measurement must never 500 a sync that would otherwise succeed — in doubt,
 * let the write through rather than lock an account out over a measurement bug.
 */
export async function isOverLimit(userId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ storageLimitBytes: users.storageLimitBytes })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) return false;

    const used = await accountStorageBytes(userId);
    return used > effectiveLimit(row);
  } catch (error) {
    console.error('storage-quota: measurement failed, allowing the write', error);
    return false;
  }
}
