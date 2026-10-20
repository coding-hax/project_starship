import { and, eq, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { authErrorResponse } from '@/auth/auth-response';
import { recordSessionVersion, requireUser } from '@/auth/session';
import { db } from '@/db';
import { isOverLimit } from '@/db/storage-quota';
import { acquireSyncWriteLock } from '@/db/sync-lock';
import { recordSyncCounters } from '@/db/sync-counters';
import { missingRequired, SYNC_REGISTRY, writableFields } from '@/db/sync-tables';
import { detectOverwrite, resolveDeletedAt } from '@/local/conflict';
import {
  malformedFields,
  NATURAL_KEYS,
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
 *
 * Each write runs in its own savepoint: a DB constraint violation rolls back only
 * that mutation and is reported as `rejected` (`reason: 'constraint'`), instead of
 * aborting the whole transaction and 500-ing the entire batch.
 *
 * Every statement below carries `userId` from the session (ADR-0031). The row key
 * is `(user_id, id)`, so a mutation naming another account's `rowId` cannot reach
 * that row at all: the lookup misses, and the insert creates this account's own
 * row under the same id. The `eq(table.userId, …)` clauses are the second lock on
 * the same door — belt to the composite key's braces.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    throw error;
  }

  // App-stand je Gerät (#1235 AK4) — never lets a broken recorder break the
  // push it rides along with (AK6), same stance as every counter below.
  try {
    await recordSessionVersion(user.sessionId, user.appVersion, request.headers.get('x-app-version'));
  } catch {
    // fail-open (AK6)
  }

  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.mutations)) {
    return NextResponse.json({ error: 'mutations must be an array' }, { status: 400 });
  }

  const mutations = body.mutations as Mutation[];

  // Quota (#1205 AC6): a batch of only `delete`s can only shrink the account, so
  // it is always let through — otherwise a full account could never free itself.
  // Pull/read stays unaffected; this route is the only write path. Fail-open is
  // inside `isOverLimit` itself, same stance as the auth rate limiter.
  if (mutations.some((mutation) => mutation.op !== 'delete') && (await isOverLimit(user.userId))) {
    try {
      await recordSyncCounters(user.userId, { rejectedQuota: 1 });
    } catch {
      // fail-open (AK6)
    }
    return NextResponse.json(
      { error: 'Dein Speicher ist voll. Lösche etwas, um wieder schreiben zu können.' },
      { status: 413 },
    );
  }

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

      const entry = SYNC_REGISTRY[mutation.table];
      const table = entry.table;
      const incomingUpdatedAt = new Date(mutation.updatedAt);

      let [existing] = await tx
        .select()
        .from(table)
        .where(and(eq(table.userId, user.userId), eq(table.id, mutation.rowId)))
        .limit(1);

      const fields = writableFields(mutation.table, mutation.payload ?? {});

      // Two devices offline can each mint their own uuid for the same natural key
      // (`habit_logs`, issue #475) — the id lookup above finds
      // nothing, but a row for this (habitId, logDate) may already exist. Upsert
      // on the natural key instead of blindly inserting a second row that then
      // collides with the table's `uniqueIndex`. Only `upsert` takes this path;
      // `delete`/`restore` always carry the real `rowId`.
      const keyFields = NATURAL_KEYS[mutation.table];
      let targetId = mutation.rowId;
      if (!existing && mutation.op === 'upsert' && keyFields?.every((f) => f in fields)) {
        const columns = table as unknown as Record<string, Parameters<typeof eq>[0]>;
        [existing] = await tx
          .select()
          .from(table)
          .where(
            and(eq(table.userId, user.userId), ...keyFields.map((f) => eq(columns[f], fields[f]))),
          )
          .limit(1);
        if (existing) targetId = existing.id as string;
      }

      const deletedAt = resolveDeletedAt(
        mutation.op,
        existing?.deletedAt ?? null,
        incomingUpdatedAt,
      );
      const conflict = detectOverwrite(mutation.baseSeq, existing?.syncSeq ?? null);

      if (!existing) {
        // Creating a row: the NOT NULL columns must be present. Reject at the door
        // rather than let the insert blow up as a 500 inside the transaction.
        const missing = missingRequired(mutation.table, fields);
        if (missing.length > 0) {
          rejected.push({ mutationId: mutation.id, reason: 'missing-required', missing });
          continue;
        }
      }

      try {
        await tx.transaction(async (sp) => {
          if (existing) {
            await sp
              .update(table)
              .set({
                ...fields,
                updatedAt: incomingUpdatedAt,
                deletedAt,
                syncedAt: now,
                syncSeq: sql`nextval('sync_seq')`,
              })
              .where(and(eq(table.userId, user.userId), eq(table.id, targetId)));
          } else {
            await sp.insert(table).values({
              userId: user.userId,
              id: targetId,
              ...fields,
              updatedAt: incomingUpdatedAt,
              deletedAt,
              syncedAt: now,
              syncSeq: sql`nextval('sync_seq')`,
            } as unknown as typeof table.$inferInsert);
          }
        });
      } catch {
        console.error('[push] mutation rejected by the database', {
          mutationId: mutation.id,
          table: mutation.table,
        });
        rejected.push({ mutationId: mutation.id, reason: 'constraint', missing: [] });
        continue;
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

  // One upsert for everything this call found (AK1, AK5 "kein zusätzlicher
  // Query" — the tallies are already in memory from the loop above). Never lets
  // a broken counter turn a successful push into a failed response (AK6).
  try {
    await recordSyncCounters(user.userId, {
      rejectedMalformed: rejected.filter((r) => r.reason === 'malformed').length,
      rejectedMissingRequired: rejected.filter((r) => r.reason === 'missing-required').length,
      rejectedConstraint: rejected.filter((r) => r.reason === 'constraint').length,
      conflicts: conflicts.length,
    });
  } catch {
    // fail-open (AK6)
  }

  const response: PushResponse = { applied, conflicts, rejected };
  return NextResponse.json(response);
}
