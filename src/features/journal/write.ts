import { bytesToBase64 } from '@/crypto/base64';
import type { EncryptedJournal } from '@/crypto/journal';
import { mutate } from '@/local/outbox';
import { journalEntryId } from '@/local/uuid5';

/**
 * The one write path for a journal entry (issue #338, AC5). `entryDate` decides the
 * row id (src/local/uuid5.ts) — writing the same day twice targets the same row
 * instead of creating a second one, so "one entry per day" holds without the sync
 * engine knowing anything about journal semantics. No editor/UI/decrypt here (S3a).
 */
export async function writeJournalEntry(
  entryDate: string,
  encrypted: EncryptedJournal,
): Promise<string> {
  const rowId = await journalEntryId(entryDate);
  await mutate({
    table: 'journal_entries',
    rowId,
    op: 'upsert',
    payload: {
      entryDate,
      ciphertext: bytesToBase64(encrypted.ciphertext),
      nonce: bytesToBase64(encrypted.nonce),
    },
  });
  return rowId;
}
