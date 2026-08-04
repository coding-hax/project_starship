import { cursorAfterSkips } from './conflict';
import { db, getMeta, META_LAST_PULLED_SEQ, setMeta } from './dexie';
import { discardStale, markApplied, markFailed, pending } from './outbox';
import { naturalKeyOf, type Mutation, type PullResponse, type PushResponse } from './types';

/**
 * Push, then pull. Never the other way round: pulling first would overwrite local
 * changes that have not been sent yet.
 *
 * iOS has no background sync (ADR-0001) — every trigger here is a foreground one.
 * That is accepted, not an oversight.
 */

let inFlight: Promise<void> | null = null;
let rerun = false;
let debounce: ReturnType<typeof setTimeout> | null = null;

export async function sync(): Promise<void> {
  // Coalesce overlapping triggers into the running sync, but never let coalescing
  // drop a caller's own work. A call arriving mid-run flags a rerun and joins the
  // in-flight promise; the loop takes another lap only if that rerun coincides with
  // queued work. So a sync() issued right after mutate() is guaranteed to push that
  // mutation — its `await` cannot resolve on a run that began before the row existed
  // — while overlapping *pull-only* triggers (the visible-tab interval and a focus
  // firing together, #29) enqueue nothing and still collapse into a single pull.
  if (inFlight) {
    rerun = true;
    return inFlight;
  }

  inFlight = (async () => {
    try {
      do {
        rerun = false;
        await push();
        await pull();
      } while (rerun && (await pending()).length > 0);
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export async function push(): Promise<void> {
  const queue = await pending();
  if (queue.length === 0) return;

  const mutations: Mutation[] = queue.map((entry) => ({
    id: entry.id,
    table: entry.table,
    rowId: entry.rowId,
    op: entry.op,
    payload: entry.payload,
    updatedAt: entry.updatedAt,
    baseSeq: entry.baseSeq,
  }));

  let response: Response;
  try {
    response = await fetch('/api/sync/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mutations }),
    });
  } catch {
    // Offline. The queue survives — that is the entire point. Does not count
    // towards SYNC_ERROR_THRESHOLD (#182) — offline is not a server rejecting it.
    await markFailed(
      mutations.map((m) => m.id),
      'offline',
      true,
    );
    return;
  }

  if (!response.ok) {
    await markFailed(
      mutations.map((m) => m.id),
      `push failed: ${response.status}`,
    );
    return;
  }

  const result: PushResponse = await response.json();

  const appliedIds = new Set(result.applied);
  await markApplied(mutations.filter((m) => appliedIds.has(m.id)));

  if (result.conflicts.length > 0) {
    // Arrival wins (ADR-0008) — a conflicted mutation was still applied (see
    // markApplied above), this is purely informative. Logged, never silently
    // dropped (ADR-0001).
    console.warn('[sync] mutations overwrote an unseen change', result.conflicts);
  }

  if (result.rejected.length > 0) {
    // Unhealable (malformed, read-only, or a DB constraint). Retrying would wedge
    // the queue behind a mutation that can never land.
    console.error('[sync] rejected mutations dropped', result.rejected);
    await discardStale(result.rejected.map((r) => r.mutationId));
  }
}

/**
 * Resolves `true` only if the server's changes were actually applied. Callers that
 * merely trigger a sync can ignore it; a caller that has to tell "the server has
 * nothing" apart from "we never asked" cannot (issue #371).
 *
 * Loops page by page (fund F5, #478) — the server caps a single response at
 * `PULL_PAGE_LIMIT` and reports `hasMore`; a fresh device's first sync can be many
 * pages. `since` is re-read from `META_LAST_PULLED_SEQ` every round rather than
 * carried in a local variable, and the cursor is persisted after each page, not
 * just at the end — so a mid-loop failure (offline, tab closed) leaves the next
 * sync resuming from the last completed page, never restarting at 0 (AK4).
 */
export async function pull(): Promise<boolean> {
  let appliedAny = false;

  for (;;) {
    const since = (await getMeta<number>(META_LAST_PULLED_SEQ)) ?? 0;

    let response: Response;
    try {
      response = await fetch(`/api/sync/pull?since=${since}`);
    } catch {
      return appliedAny; // Offline. Try again on the next trigger.
    }
    if (!response.ok) return appliedAny;

    const { changes, cursor, hasMore }: PullResponse = await response.json();

    const skipped: number[] = [];

    await db.transaction('rw', db.records, db.outbox, async () => {
      const queued = await db.outbox.toArray();
      const queuedSet = new Set(queued.map((m) => `${m.table}:${m.rowId}`));

      for (const change of changes) {
        const local = await db.records.get([change.table, change.id] as never);

        // A local row that is still queued for push is newer by definition — do not
        // overwrite it with what the server currently holds.
        if (queuedSet.has(`${change.table}:${change.id}`)) {
          skipped.push(change.syncSeq);
          continue;
        }

        // syncSeq, not updatedAt (ADR-0008) — a client clock cannot suppress a
        // legitimate incoming change, nor let a stale one through.
        if (local?.syncSeq != null && local.syncSeq >= change.syncSeq) continue;

        await db.records.put({
          table: change.table,
          id: change.id,
          updatedAt: change.updatedAt,
          deletedAt: change.deletedAt,
          syncedAt: change.updatedAt,
          syncSeq: change.syncSeq,
          data: change.data,
        });

        // Two devices offline can each mint their own uuid for the same natural
        // key (`habit_logs`/`habit_freezes`, issue #475). The server upsert
        // (route.ts) already collapsed both onto one server-side row — `change`
        // above — but this device may still hold the displaced local row under
        // its own uuid. Sweep it out now so the store never shows the same
        // (habitId, logDate) twice. Cheap even unindexed: local record counts per
        // table stay in the dozens for a single-user app.
        const key = naturalKeyOf(change.table, change.data);
        if (key !== null) {
          const siblings = await db.records.where('table').equals(change.table).toArray();
          for (const sibling of siblings) {
            if (
              sibling.id !== change.id &&
              naturalKeyOf(change.table, sibling.data) === key &&
              !queuedSet.has(`${sibling.table}:${sibling.id}`)
            ) {
              await db.records.delete([sibling.table, sibling.id] as never);
            }
          }
        }
      }
    });

    // Clamped below any row this page skipped (issue #479) — everything at or
    // above the clamp is re-delivered on a later pull, once the local mutation
    // that shadowed it has cleared.
    const nextCursor = cursorAfterSkips(cursor, skipped);
    await setMeta(META_LAST_PULLED_SEQ, nextCursor);
    appliedAny = true;

    // `nextCursor <= since` guards against a server that reports `hasMore` without
    // the cursor actually advancing, and against a skip clamping this page's cursor
    // back to (or below) where it started — either way, looping again here would
    // just re-fetch the same page forever instead of making progress.
    if (!hasMore || nextCursor <= since) break;
  }

  return appliedAny;
}

/** Debounced trigger — call after a mutation without hammering the endpoint. */
export function scheduleSync(delayMs = 500): void {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    void sync();
  }, delayMs);
}

/** A tab left open elsewhere gets changes from other devices without a reload. */
const PULL_INTERVAL_MS = 30_000;

/**
 * Wires up the triggers from ARCHITECTURE.md: app start, foreground, reconnect —
 * plus a visible-tab poll and a `focus` pull (#29), since neither reconnect nor
 * visibilitychange fires for a tab that was never backgrounded or offline.
 * Returns a teardown function.
 */
export function startSync(): () => void {
  let interval: ReturnType<typeof setInterval> | null = null;

  const startInterval = () => {
    if (interval) return;
    interval = setInterval(() => void sync(), PULL_INTERVAL_MS);
  };
  const stopInterval = () => {
    if (interval) clearInterval(interval);
    interval = null;
  };

  const onOnline = () => void sync();
  const onFocus = () => void sync();
  const onVisible = () => {
    if (document.visibilityState === 'visible') {
      void sync();
      startInterval();
    } else {
      // No background sync (ADR-0001) — the interval pauses, not just the requests.
      stopInterval();
    }
  };

  window.addEventListener('online', onOnline);
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisible);

  void sync();
  if (document.visibilityState === 'visible') startInterval();

  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisible);
    stopInterval();
    if (debounce) clearTimeout(debounce);
  };
}
