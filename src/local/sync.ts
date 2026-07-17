import { db, getMeta, META_LAST_PULLED_SEQ, setMeta } from './dexie';
import { discardStale, markApplied, markFailed, pending } from './outbox';
import type { Mutation, PullResponse, PushResponse } from './types';

/**
 * Push, then pull. Never the other way round: pulling first would overwrite local
 * changes that have not been sent yet.
 *
 * iOS has no background sync (ADR-0001) — every trigger here is a foreground one.
 * That is accepted, not an oversight.
 */

let inFlight: Promise<void> | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;

export async function sync(): Promise<void> {
  // Coalesce: a second call while one is running joins the running one.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      await push();
      await pull();
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
    // Offline. The queue survives — that is the entire point.
    await markFailed(
      mutations.map((m) => m.id),
      'offline',
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
    // Malformed. Retrying would wedge the queue behind a mutation that can never land.
    console.error('[sync] malformed mutations dropped', result.rejected);
    await discardStale(result.rejected.map((r) => r.mutationId));
  }
}

export async function pull(): Promise<void> {
  const since = (await getMeta<number>(META_LAST_PULLED_SEQ)) ?? 0;

  let response: Response;
  try {
    response = await fetch(`/api/sync/pull?since=${since}`);
  } catch {
    return; // Offline. Try again on the next trigger.
  }
  if (!response.ok) return;

  const { changes, cursor }: PullResponse = await response.json();

  await db.transaction('rw', db.records, db.outbox, async () => {
    for (const change of changes) {
      const local = await db.records.get([change.table, change.id] as never);

      // A local row that is still queued for push is newer by definition — do not
      // overwrite it with what the server currently holds.
      const queued = await db.outbox.where('table').equals(change.table).toArray();
      if (queued.some((m) => m.rowId === change.id)) continue;

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
    }
  });

  await setMeta(META_LAST_PULLED_SEQ, cursor);
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
