import { base64ToBytes } from '@/crypto/base64';
import { decryptJournal } from '@/crypto/journal';
import { db } from '@/local/dexie';
import { journalDek } from './lock-store';
import type { JournalSearchEntry } from './search';

/**
 * Decrypts every `journal_entries` row once into memory (AC2, owner decision "3a"
 * in #301) — the session cache the search reads from. The result only ever lives
 * in the caller's React state; nothing here writes to IndexedDB, so no plaintext
 * ever touches disk. Empty (not thrown) while locked — there is no key to open
 * anything with.
 */
export async function loadSearchableJournalEntries(): Promise<JournalSearchEntry[]> {
  const dek = journalDek();
  if (!dek) return [];

  const rows = await db.records.where('table').equals('journal_entries').toArray();
  const visible = rows.filter((row) => row.deletedAt === null);

  return Promise.all(
    visible.map(async (row) => {
      const ciphertext = base64ToBytes(row.data.ciphertext as string);
      const nonce = base64ToBytes(row.data.nonce as string);
      const content = await decryptJournal(dek, ciphertext, nonce);
      return {
        entryDate: row.data.entryDate as string,
        text: content.text,
        tags: content.tags ?? [],
      };
    }),
  );
}
