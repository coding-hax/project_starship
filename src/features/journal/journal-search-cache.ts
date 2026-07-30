import { db } from '@/local/dexie';
import { decryptJournalRows } from './decrypt-journal-row';
import { journalDek } from './lock-store';
import type { JournalSearchEntry } from './search';

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

  const rows = await db.records.where('table').equals('journal_entries').toArray();
  const visible = rows.filter((row) => row.deletedAt === null);

  return decryptJournalRows(dek, visible, (row, content) => ({
    id: row.id,
    entryDate: row.data.entryDate as string,
    createdAt: (row.data.createdAt as string | undefined) ?? row.updatedAt,
    text: content.text,
    tags: content.tags ?? [],
  }));
}
