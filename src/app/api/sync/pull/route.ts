import { NextResponse } from 'next/server';
import { requireOwner, UnauthorizedError } from '@/auth/session';
import { db } from '@/db';
import { selectSince } from '@/local/conflict';
import type { PullResponse } from '@/local/types';
import { readChangesSince } from './read-changes-since';

/**
 * Everything that arrived after `since`, oldest arrival first.
 *
 * Soft-deleted rows are included on purpose: the client needs the tombstone, or a
 * row deleted on the phone would live on forever on the laptop.
 *
 * `since`/the returned cursor are `sync_seq` values (ADR-0008), not timestamps — a
 * client clock set far in the past or future can no longer cause a row to be
 * skipped or re-fetched forever.
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

  const raw = new URL(request.url).searchParams.get('since');
  const since = raw === null ? 0 : Number.parseInt(raw, 10);
  if (!Number.isInteger(since)) {
    return NextResponse.json({ error: 'since must be an integer sequence number' }, { status: 400 });
  }

  const changes = await db.transaction((tx) => readChangesSince(tx, since), {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });

  changes.sort((a, b) => a.syncSeq - b.syncSeq);

  const { cursor } = selectSince(changes, since);
  const response: PullResponse = { changes, cursor };
  return NextResponse.json(response);
}
