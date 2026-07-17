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
