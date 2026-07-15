import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { requireOwner, UnauthorizedError } from '@/auth/session';
import { db } from '@/db';
import { missingRequired, SYNC_REGISTRY, writableFields } from '@/db/sync-tables';
import {
  isSyncTable,
  type Mutation,
  type PushConflict,
  type PushRejection,
  type PushResponse,
} from '@/local/types';

/**
 * Applies the client outbox.
 *
 * Idempotent through the row id: replaying a mutation compares equal timestamps,
 * writes the same values and yields the same state. A dropped connection mid-push
 * is therefore harmless — the client just sends it again.
 *
 * Last-write-wins: a mutation is applied when its updatedAt is not older than what
 * the server holds. The payload is partial, so two devices touching different fields
 * of the same row do not clobber each other. A genuinely stale mutation is reported
 * as a conflict, never silently swallowed (ADR-0001).
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
  for (const m of mutations) {
    if (
      !isSyncTable(m?.table) ||
      typeof m?.rowId !== 'string' ||
      typeof m?.updatedAt !== 'string'
    ) {
      return NextResponse.json({ error: 'malformed mutation' }, { status: 400 });
    }
  }

  const applied: string[] = [];
  const conflicts: PushConflict[] = [];
  const rejected: PushRejection[] = [];
  const now = new Date();

  // Oldest first, so a newer mutation always lands on top of an older one.
  const ordered = [...mutations].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  await db.transaction(async (tx) => {
    for (const mutation of ordered) {
      const entry = SYNC_REGISTRY[mutation.table];
      const table = entry.table;
      const incomingUpdatedAt = new Date(mutation.updatedAt);

      const [existing] = await tx.select().from(table).where(eq(table.id, mutation.rowId)).limit(1);

      if (existing && existing.updatedAt > incomingUpdatedAt) {
        conflicts.push({
          mutationId: mutation.id,
          rowId: mutation.rowId,
          reason: 'stale',
          incomingUpdatedAt: mutation.updatedAt,
          storedUpdatedAt: existing.updatedAt.toISOString(),
        });
        continue;
      }

      const fields = writableFields(mutation.table, mutation.payload ?? {});
      const deletedAt =
        mutation.op === 'delete'
          ? incomingUpdatedAt
          : mutation.op === 'restore'
            ? null
            : (existing?.deletedAt ?? null);

      if (existing) {
        await tx
          .update(table)
          .set({ ...fields, updatedAt: incomingUpdatedAt, deletedAt, syncedAt: now })
          .where(eq(table.id, mutation.rowId));
      } else {
        // Creating a row: the NOT NULL columns must be present. Reject at the door
        // rather than let the insert blow up as a 500 inside the transaction.
        const missing = missingRequired(mutation.table, fields);
        if (missing.length > 0) {
          rejected.push({ mutationId: mutation.id, missing });
          continue;
        }

        await tx.insert(table).values({
          id: mutation.rowId,
          ...fields,
          updatedAt: incomingUpdatedAt,
          deletedAt,
          syncedAt: now,
        } as typeof table.$inferInsert);
      }

      applied.push(mutation.id);
    }
  });

  const response: PushResponse = { applied, conflicts, rejected };
  return NextResponse.json(response);
}
