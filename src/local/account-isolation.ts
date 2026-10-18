import { db, getMeta, setMeta } from './dexie';

/** The `meta` key the local DB's account marker lives under (S2, #1201) — reuses
 * `getMeta`/`setMeta` instead of a new store, same as `META_LAST_PULLED_SEQ`. */
export const META_ACCOUNT_ID = 'accountId';

export type AccountCheckResult = 'ready' | 'blocked' | 'unauthenticated' | 'offline';

interface StatusResponse {
  authenticated: boolean;
  userId?: string;
  blocked?: boolean;
}

/** Terminal results are cached — `offline` never is, so the next online trigger
 * (sync's own 'online' listener, a focus event, …) re-checks instead of being
 * stuck behind a stale miss. */
let cached: AccountCheckResult | null = null;
let inFlight: Promise<AccountCheckResult> | null = null;

let blocked = false;
const blockedListeners = new Set<() => void>();
function notifyBlocked() {
  for (const listener of blockedListeners) listener();
}

/** Flipped by a sync 403 (AK5) or found already blocked by the check below —
 * either way short-circuits every later `ensureAccountChecked()` without a
 * fresh fetch. */
export function markBlocked(): void {
  cached = 'blocked';
  if (!blocked) {
    blocked = true;
    notifyBlocked();
  }
}

export function subscribeBlocked(onChange: () => void): () => void {
  blockedListeners.add(onChange);
  return () => blockedListeners.delete(onChange);
}

export function isBlocked(): boolean {
  return blocked;
}

/** For tests/a real re-login after `unauthenticated` — clears the memoized result
 * so the next call re-checks from scratch instead of replaying a stale verdict. */
export function resetAccountCheck(): void {
  cached = null;
  inFlight = null;
  blocked = false;
}

const wipeHooks = new Set<() => void>();

/** Lets another module drop in-memory state a wipe would otherwise leave behind
 * (the journal DEK in `lock-store.ts`) — registered once at module load, run
 * every time `wipeLocalDatabase` clears the stores below. */
export function registerWipeHook(fn: () => void): void {
  wipeHooks.add(fn);
}

/**
 * Clears every local store in one `rw` transaction over the already-open Dexie
 * connection — never `indexedDB.deleteDatabase()`/`db.delete()`, which races
 * Dexie's own `versionchange` handler (journal.spec.ts #338 AC3). `nextAccountId`,
 * when given, stamps the marker this device now belongs to in the same
 * transaction; omitted (a plain logout, or an account that no longer exists),
 * the marker stays empty until the next account checks in.
 */
export async function wipeLocalDatabase(nextAccountId?: string): Promise<void> {
  // The array overload, not the fixed-arity ones (max 5 tables) — seven stores.
  await db.transaction(
    'rw',
    [db.records, db.outbox, db.meta, db.weather, db.journalSession, db.journalKeyStash, db.icsSubscriptions],
    async () => {
      await db.records.clear();
      await db.outbox.clear();
      await db.meta.clear();
      await db.weather.clear();
      await db.journalSession.clear();
      await db.journalKeyStash.clear();
      await db.icsSubscriptions.clear();
      if (nextAccountId) await setMeta(META_ACCOUNT_ID, nextAccountId);
    },
  );
  for (const hook of wipeHooks) hook();
}

async function check(): Promise<AccountCheckResult> {
  let response: Response;
  try {
    response = await fetch('/api/auth/status');
  } catch {
    return 'offline';
  }
  if (!response.ok) return 'offline';

  const status: StatusResponse = await response.json();

  if (!status.authenticated) {
    await wipeLocalDatabase();
    return 'unauthenticated';
  }

  if (status.blocked) {
    markBlocked();
    return 'blocked';
  }

  const stored = await getMeta<string>(META_ACCOUNT_ID);
  if (stored !== status.userId) {
    // A different account than the one this device's IndexedDB belongs to — spill
    // nothing of A's into B's session. The cursor stays unset, so the next pull
    // starts fresh from 0 (AK4), not from wherever A's last pull left off.
    await wipeLocalDatabase(status.userId);
  }

  blocked = false;
  return 'ready';
}

/**
 * Gates the first pull of every sync (src/local/sync.ts) and `lock-store`'s own
 * boot — memoized so the many independent boot effects that can trigger a sync
 * (`SyncBoot`, `JournalHabitBoot`, `lock-store`) serialize onto one in-flight
 * check instead of racing it, and a wipe this triggers runs exactly once.
 */
export async function ensureAccountChecked(): Promise<AccountCheckResult> {
  if (cached) return cached;
  if (inFlight) return inFlight;

  inFlight = check();
  const result = await inFlight;
  inFlight = null;
  if (result !== 'offline') cached = result;
  return result;
}
