import { db, getMeta, META_LAST_PULLED_AT, setMeta } from './dexie';
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
    // Logged, never silently dropped (ADR-0001).
    console.warn('[sync] mutations rejected as stale', result.conflicts);
    await discardStale(result.conflicts.map((c) => c.mutationId));
  }

  if (result.rejected.length > 0) {
    // Malformed. Retrying would wedge the queue behind a mutation that can never land.
    console.error('[sync] malformed mutations dropped', result.rejected);
    await discardStale(result.rejected.map((r) => r.mutationId));
  }
}

export async function pull(): Promise<void> {
  const since = (await getMeta<string>(META_LAST_PULLED_AT)) ?? new Date(0).toISOString();

  let response: Response;
  try {
    response = await fetch(`/api/sync/pull?since=${encodeURIComponent(since)}`);
  } catch {
    return; // Offline. Try again on the next trigger.
  }
  if (!response.ok) return;

  const { changes, now }: PullResponse = await response.json();

  await db.transaction('rw', db.records, db.outbox, async () => {
    for (const change of changes) {
      const local = await db.records.get([change.table, change.id] as never);

      // A local row that is still queued for push is newer by definition — do not
      // overwrite it with what the server currently holds.
      const queued = await db.outbox.where('table').equals(change.table).toArray();
      if (queued.some((m) => m.rowId === change.id)) continue;

      if (local && local.updatedAt > change.updatedAt) continue;

      await db.records.put({
        table: change.table,
        id: change.id,
        updatedAt: change.updatedAt,
        deletedAt: change.deletedAt,
        syncedAt: change.updatedAt,
        data: change.data,
      });
    }
  });

  await setMeta(META_LAST_PULLED_AT, now);
}

/** Debounced trigger — call after a mutation without hammering the endpoint. */
export function scheduleSync(delayMs = 500): void {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    void sync();
  }, delayMs);
}

/**
 * Wires up the triggers from ARCHITECTURE.md: app start, foreground, reconnect.
 * Returns a teardown function.
 */
export function startSync(): () => void {
  const onOnline = () => void sync();
  const onVisible = () => {
    if (document.visibilityState === 'visible') void sync();
  };

  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisible);

  void sync();

  return () => {
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisible);
    if (debounce) clearTimeout(debounce);
  };
}
