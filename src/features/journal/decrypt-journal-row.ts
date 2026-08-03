import { base64ToBytes } from '@/crypto/base64';
import { decryptJournal, journalEntryAad, type JournalContent } from '@/crypto/journal';
import type { LocalRecord } from '@/local/dexie';

function isPresent<E>(entry: E | null): entry is E {
  return entry !== null;
}

/**
 * Decrypts every row on its own, so one poisoned row (wrong-DEK leftover,
 * truncated ciphertext) drops out instead of rejecting the whole batch via
 * `Promise.all` (issue #384) — every caller here decrypts an unbounded set of
 * rows in one shot. Never logs ciphertext/nonce/plaintext/key material (Regel
 * 9): `JournalDecryptError`'s message never carries any of that, so only the
 * row id plus that error are worth logging.
 */
export async function decryptJournalRows<T>(
  dek: CryptoKey,
  rows: LocalRecord[],
  toEntry: (row: LocalRecord, content: JournalContent) => T,
): Promise<T[]> {
  const results = await Promise.all<T | null>(
    rows.map(async (row) => {
      try {
        const ciphertext = base64ToBytes(row.data.ciphertext as string);
        const nonce = base64ToBytes(row.data.nonce as string);
        const aad = journalEntryAad(row.id, row.data.entryDate as string);
        const content = await decryptJournal(dek, ciphertext, nonce, aad);
        return toEntry(row, content);
      } catch (error) {
        console.warn('journal entry undecryptable, skipping', row.id, error);
        return null;
      }
    }),
  );
  return results.filter(isPresent);
}
