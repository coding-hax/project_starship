import { db, type JournalKeyStashEntry } from '@/local/dexie';

/**
 * Only `@/local/dexie` — never `./lock-store` (issue #518). `sync.ts` calls into
 * this module directly from `pull()`; importing `lock-store` here would close a
 * cycle (`sync.ts` → `journal-key-stash.ts` → `lock-store.ts` → `sync.ts`).
 */

/**
 * Order-independent JSON equality: the envelope column is `jsonb` (schema.ts),
 * and Postgres's jsonb explicitly does not preserve object key order on
 * round-trip — a plain `JSON.stringify` compare would call this device's own
 * push, echoed back unchanged, a "foreign" envelope purely because the server
 * happened to re-serialize its keys in a different order, and stash it wrongly.
 */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as object).sort();
    const bKeys = Object.keys(b as object).sort();
    if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) return false;
    return aKeys.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/**
 * Stashes the local `journal_keys` envelope a foreign, newer arrival is about to
 * overwrite (issue #518) — called from `pull()` right before the incoming row
 * lands, inside the same transaction. A no-op when the two envelopes are equal
 * (order-independent): that is this device's own push echoed back, or a
 * legitimate rewrap under the same DEK, not a competing setup — stashing it would
 * just accumulate noise no recovery attempt will ever need.
 */
export async function stashDisplacedJournalKey(
  localData: Record<string, unknown>,
  incomingData: Record<string, unknown>,
): Promise<void> {
  const localEnvelope = localData.envelope;
  if (localEnvelope == null) return;
  if (sameJson(localEnvelope, incomingData.envelope)) return;

  const entry: JournalKeyStashEntry = {
    id: crypto.randomUUID(),
    envelope: localEnvelope,
    recoveryEnvelope: localData.recoveryEnvelope,
    capturedAt: new Date().toISOString(),
  };
  await db.journalKeyStash.add(entry);
}

export async function listJournalKeyStash(): Promise<JournalKeyStashEntry[]> {
  return db.journalKeyStash.toArray();
}

export async function deleteJournalKeyStash(id: string): Promise<void> {
  await db.journalKeyStash.delete(id);
}
