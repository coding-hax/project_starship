import { db } from '@/local/dexie';
import { decryptJournalRows } from './decrypt-journal-row';
import { journalDek } from './lock-store';
import type { JournalSearchEntry } from './search';

let runCount = 0;

/** Test-only tally of `loadSearchableJournalEntries` calls (issue #1049 AK6) —
 * lets a Playwright spec assert that "An diesem Tag" reuses the existing
 * session-cache hook instead of starting its own decrypt pass, without a
 * feature toggle to compare a with/without build. Never read in production. */
export function debugDecryptRunCount(): number {
  return runCount;
}

/**
 * Decrypts every `journal_entries` row once into memory (AC2, owner decision "3a"
 * in #301) — the session cache the search reads from. The result only ever lives
 * in the caller's React state; nothing here writes to IndexedDB, so no plaintext
 * ever touches disk. Empty (not thrown) while locked — there is no key to open
 * anything with. A single undecryptable row is skipped (issue #384), not fatal
 * to the whole cache — see decrypt-journal-row.ts.
 */
export async function loadSearchableJournalEntries(): Promise<JournalSearchEntry[]> {
  const dek = journalDek();
  if (!dek) return [];
  runCount += 1;

  const rows = await db.records.where('table').equals('journal_entries').toArray();
  const visible = rows.filter((row) => row.deletedAt === null);

  return decryptJournalRows(dek, visible, (row, content) => ({
    id: row.id,
    entryDate: row.data.entryDate as string,
    createdAt: (row.data.createdAt as string | undefined) ?? row.updatedAt,
    text: content.text,
    tags: content.tags ?? [],
    mood: content.mood,
  }));
}
