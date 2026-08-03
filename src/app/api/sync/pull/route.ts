import { NextResponse } from 'next/server';
import { requireOwner, UnauthorizedError } from '@/auth/session';
import { db } from '@/db';
import { pageChanges, PULL_PAGE_LIMIT } from '@/local/conflict';
import type { PullResponse } from '@/local/types';
import { readChangesSince } from './read-changes-since';

/**
 * Up to `PULL_PAGE_LIMIT` changes that arrived after `since`, oldest arrival
 * first. `hasMore` tells the client whether to pull again with `since = cursor`
 * (fund F5, #478) — an unbounded response here is exactly the recovery-sync
 * timeout/OOM the fund describes.
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

  const { changes, truncated } = await db.transaction((tx) => readChangesSince(tx, since), {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });

  const { changes: page, cursor, hasMore } = pageChanges(changes, since, PULL_PAGE_LIMIT, truncated);
  const response: PullResponse = { changes: page, cursor, hasMore };
  return NextResponse.json(response);
}
