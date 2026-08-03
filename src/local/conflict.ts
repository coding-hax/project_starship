/**
 * Pure conflict-resolution semantics for ADR-0008 — no DB, no framework, so the
 * rules that decide who wins a sync conflict live in one place and are directly
 * testable. `src/app/api/sync/push/route.ts` and `pull/route.ts` call these
 * functions rather than duplicating the logic.
 */

import type { Mutation } from './types';

/**
 * What `deleted_at` becomes after applying a mutation, given the row's current
 * `deleted_at`. `upsert` is tombstone-neutral — it never touches `deleted_at` —
 * so a field edit can never resurrect a deleted row, whichever order it arrives
 * in relative to the delete. `delete`/`restore` set it deterministically; which
 * of two competing `delete`/`restore` mutations wins falls out of arrival order
 * (the caller applies mutations in arrival order, so the last call wins).
 */
export function resolveDeletedAt(
  op: Mutation['op'],
  existingDeletedAt: Date | null,
  incomingUpdatedAt: Date,
): Date | null {
  switch (op) {
    case 'upsert':
      return existingDeletedAt;
    case 'delete':
      return incomingUpdatedAt;
    case 'restore':
      return null;
  }
}

/**
 * True if this mutation's `baseSeq` is older than the row's current `syncSeq` —
 * i.e. it was written against a version of the row that something else has
 * since overwritten. The mutation is still applied (arrival wins, ADR-0008);
 * this only decides whether to report it as a conflict.
 */
export function detectOverwrite(baseSeq: number | null, existingSyncSeq: number | null): boolean {
  return baseSeq != null && existingSyncSeq != null && baseSeq < existingSyncSeq;
}

interface WithSyncSeq {
  syncSeq: number;
}

/**
 * The pull cursor is pure arithmetic: rows strictly newer than `since`, and the
 * next cursor is the highest `syncSeq` actually returned — or `since` unchanged
 * if nothing came back, so an empty pull never rewinds the cursor.
 */
export function selectSince<T extends WithSyncSeq>(
  rows: readonly T[],
  since: number,
): { changes: T[]; cursor: number } {
  const changes = rows.filter((row) => row.syncSeq > since);
  const cursor = changes.reduce((max, row) => Math.max(max, row.syncSeq), since);
  return { changes, cursor };
}

/**
 * Page size for `/api/sync/pull` (fund F5, #478). An unbounded first sync reads a
 * device's entire history into one response — a recovery-case timeout/OOM. 200 is a
 * compromise: few round trips for a large recovery sync, bounded response size.
 */
export const PULL_PAGE_LIMIT = 200;

/**
 * Caps a pull's rows to `limit` and reports whether more remain, given a global,
 * monotonic `syncSeq` (ADR-0008) — keyset pagination is exact here: `> since`
 * never skips or repeats a row, whichever page it lands on.
 *
 * `rows` is not assumed sorted; that is this function's job, so a caller merging
 * several per-table queries can hand over the concatenation as-is. `moreBeyondLimit`
 * flags a table whose own query already hit its `LIMIT` — such a table may hold rows
 * beyond what was fetched at all, so `hasMore` must stay true even when the merged
 * `rows` fit within `limit` (e.g. one table maxed out, every other table came back
 * empty).
 */
export function pageChanges<T extends WithSyncSeq>(
  rows: readonly T[],
  since: number,
  limit: number,
  moreBeyondLimit: boolean,
): { changes: T[]; cursor: number; hasMore: boolean } {
  const sorted = [...rows].sort((a, b) => a.syncSeq - b.syncSeq);
  const overflow = sorted.length > limit;
  const changes = overflow ? sorted.slice(0, limit) : sorted;
  const cursor = changes.reduce((max, row) => Math.max(max, row.syncSeq), since);
  return { changes, cursor, hasMore: overflow || moreBeyondLimit };
}
