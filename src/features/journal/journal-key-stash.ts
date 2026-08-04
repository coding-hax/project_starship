import { db, type JournalKeyStashEntry } from '@/local/dexie';

/**
 * Only `@/local/dexie` — never `./lock-store` (issue #518). `sync.ts` calls into
 * this module directly from `pull()`; importing `lock-store` here would close a
 * cycle (`sync.ts` → `journal-key-stash.ts` → `lock-store.ts` → `sync.ts`).
 */

/**
 * Stashes the local `journal_keys` envelope a foreign, newer arrival is about to
 * overwrite (issue #518) — called from `pull()` right before the incoming row
 * lands, inside the same transaction. A no-op when the two envelopes are
 * byte-identical (JSON compare): that is this device's own push echoed back, or a
 * legitimate rewrap under the same DEK, not a competing setup — stashing it would
 * just accumulate noise no recovery attempt will ever need.
 */
export async function stashDisplacedJournalKey(
  localData: Record<string, unknown>,
  incomingData: Record<string, unknown>,
): Promise<void> {
  const localEnvelope = localData.envelope;
  if (localEnvelope == null) return;
  if (JSON.stringify(localEnvelope) === JSON.stringify(incomingData.envelope)) return;

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
