import { asc, gt } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { requireOwner, UnauthorizedError } from '@/auth/session';
import { db } from '@/db';
import { SYNC_REGISTRY } from '@/db/sync-tables';
import { SYNC_TABLES, type ChangeRow, type PullResponse } from '@/local/types';

/**
 * Everything that changed since `since`, oldest first.
 *
 * Soft-deleted rows are included on purpose: the client needs the tombstone, or a
 * row deleted on the phone would live on forever on the laptop.
 *
 * The cursor returned is the server clock, not the newest row's timestamp — that
 * keeps the client from anchoring on a stale local clock.
 */
export async function GET(request: Request) {
  try {
    await requireOwner();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    throw error;
  }

  const raw = new URL(request.url).searchParams.get('since') ?? new Date(0).toISOString();
  const since = new Date(raw);
  if (Number.isNaN(since.getTime())) {
    return NextResponse.json({ error: 'since must be an ISO timestamp' }, { status: 400 });
  }

  const now = new Date();
  const changes: ChangeRow[] = [];

  for (const name of SYNC_TABLES) {
    const table = SYNC_REGISTRY[name].table;
    const writable = SYNC_REGISTRY[name].writable as readonly string[];

    const rows = await db
      .select()
      .from(table)
      .where(gt(table.updatedAt, since))
      .orderBy(asc(table.updatedAt));

    for (const row of rows) {
      const data: Record<string, unknown> = {};
      for (const field of writable) {
        data[field] = (row as Record<string, unknown>)[field];
      }

      changes.push({
        table: name,
        id: row.id,
        updatedAt: row.updatedAt.toISOString(),
        deletedAt: row.deletedAt?.toISOString() ?? null,
        data,
      });
    }
  }

  changes.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  const response: PullResponse = { changes, now: now.toISOString() };
  return NextResponse.json(response);
}
