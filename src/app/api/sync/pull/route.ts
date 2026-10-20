import { NextResponse } from 'next/server';
import { authErrorResponse } from '@/auth/auth-response';
import { recordSessionVersion, requireUser } from '@/auth/session';
import { db } from '@/db';
import { recordSyncCounters } from '@/db/sync-counters';
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
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    throw error;
  }

  // App-stand je Gerät (#1235 AK4) — see the push route for the same call.
  try {
    await recordSessionVersion(user.sessionId, user.appVersion, request.headers.get('x-app-version'));
  } catch {
    // fail-open (AK6)
  }

  const raw = new URL(request.url).searchParams.get('since');
  const since = raw === null ? 0 : Number.parseInt(raw, 10);
  if (!Number.isInteger(since)) {
    return NextResponse.json({ error: 'since must be an integer sequence number' }, { status: 400 });
  }

  if (since === 0) {
    try {
      await recordSyncCounters(user.userId, { fullPulls: 1 });
    } catch {
      // fail-open (AK6)
    }
  }

  const { changes, truncated } = await db.transaction(
    (tx) => readChangesSince(tx, since, user.userId),
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );

  const { changes: page, cursor, hasMore } = pageChanges(changes, since, PULL_PAGE_LIMIT, truncated);
  const response: PullResponse = { changes: page, cursor, hasMore };
  return NextResponse.json(response);
}
