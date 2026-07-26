import { eq, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { requireOwner, UnauthorizedError } from '@/auth/session';
import { db } from '@/db';
import { acquireSyncWriteLock } from '@/db/sync-lock';
import { missingRequired, SYNC_REGISTRY, writableFields } from '@/db/sync-tables';
import { detectOverwrite, resolveDeletedAt } from '@/local/conflict';
import {
  isReadOnlyTable,
  malformedFields,
  type Mutation,
  type PushConflict,
  type PushRejection,
  type PushResponse,
} from '@/local/types';

/**
 * Applies the client outbox.
 *
 * Idempotent through the row id: replaying a mutation writes the same fields and
 * yields the same state, modulo an extra `sync_seq` bump — harmless, since `upsert`
 * is tombstone-neutral and never resurrects a deleted row. A dropped connection
 * mid-push is therefore harmless — the client just sends it again.
 *
 * Arrival wins (ADR-0008): every mutation is applied and stamped with the next
 * `sync_seq`, in the order the client sent them (its outbox is already createdAt-
 * ascending, i.e. this device's arrival order). A mutation based on a row version
 * something else has since overwritten is still applied — it is reported as a
 * conflict, never silently dropped (ADR-0001). `pg_advisory_xact_lock` serializes
 * concurrent pushes so sequence-assignment order always matches commit order —
 * otherwise a later-committing transaction could hand out a lower `sync_seq` than
 * one that is still in flight, and that row would never appear to a puller reading
 * the sequence range in between (ADR-0008).
 */
export async function POST(request: Request) {
  try {
    await requireOwner();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    throw error;
  }

  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.mutations)) {
    return NextResponse.json({ error: 'mutations must be an array' }, { status: 400 });
  }

  const mutations = body.mutations as Mutation[];

  const applied: string[] = [];
  const conflicts: PushConflict[] = [];
  const rejected: PushRejection[] = [];
  const now = new Date();

  await db.transaction(async (tx) => {
    await acquireSyncWriteLock(tx);

    // Receipt order, not updatedAt order: the client's outbox is already this
    // device's arrival order, and arrival — not the client clock — decides now.
    for (const mutation of mutations) {
      const malformed = malformedFields(mutation);
      if (malformed.length > 0) {
        rejected.push({ mutationId: mutation?.id, reason: 'malformed', missing: malformed });
        continue;
      }

      // Server-origin data (ADR-0011): rejected before it ever touches the table,
      // not via an empty `writable` list — that alone would still let an empty
      // payload through and tombstone a row via `deletedAt`.
      if (isReadOnlyTable(mutation.table)) {
        rejected.push({ mutationId: mutation.id, reason: 'read-only', missing: [] });
        continue;
      }

      const entry = SYNC_REGISTRY[mutation.table];
      const table = entry.table;
      const incomingUpdatedAt = new Date(mutation.updatedAt);

      const [existing] = await tx.select().from(table).where(eq(table.id, mutation.rowId)).limit(1);

      const deletedAt = resolveDeletedAt(
        mutation.op,
        existing?.deletedAt ?? null,
        incomingUpdatedAt,
      );
      const conflict = detectOverwrite(mutation.baseSeq, existing?.syncSeq ?? null);

      const fields = writableFields(mutation.table, mutation.payload ?? {});

      if (existing) {
        await tx
          .update(table)
          .set({
            ...fields,
            updatedAt: incomingUpdatedAt,
            deletedAt,
            syncedAt: now,
            syncSeq: sql`nextval('sync_seq')`,
          })
          .where(eq(table.id, mutation.rowId));
      } else {
        // Creating a row: the NOT NULL columns must be present. Reject at the door
        // rather than let the insert blow up as a 500 inside the transaction.
        const missing = missingRequired(mutation.table, fields);
        if (missing.length > 0) {
          rejected.push({ mutationId: mutation.id, reason: 'missing-required', missing });
          continue;
        }

        await tx.insert(table).values({
          id: mutation.rowId,
          ...fields,
          updatedAt: incomingUpdatedAt,
          deletedAt,
          syncedAt: now,
          syncSeq: sql`nextval('sync_seq')`,
        } as unknown as typeof table.$inferInsert);
      }

      applied.push(mutation.id);
      if (conflict) {
        conflicts.push({
          mutationId: mutation.id,
          rowId: mutation.rowId,
          reason: 'overwritten',
          incomingUpdatedAt: mutation.updatedAt,
          overwrittenUpdatedAt: (existing?.updatedAt ?? incomingUpdatedAt).toISOString(),
        });
      }
    }
  });

  const response: PushResponse = { applied, conflicts, rejected };
  return NextResponse.json(response);
}
