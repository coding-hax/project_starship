import { bytesToBase64 } from '@/crypto/base64';
import type { EncryptedJournal } from '@/crypto/journal';
import { mutate } from '@/local/outbox';

/**
 * The one write path for a journal entry (issue #338, AC5). Since issue #376, a day
 * can carry any number of entries — every call creates a NEW row (uuidv7, generated
 * by `mutate()`), there is no more "same day -> same row" collapsing. `createdAt` is
 * client-set, same pattern as `tasks`/`habits` (src/db/schema.ts): it is the display/
 * sort anchor (issue #376 AC3), `syncSeq`/`updatedAt` change on every sync and cannot
 * serve that role. No editor/UI/decrypt here (S3a).
 */
export async function writeJournalEntry(
  entryDate: string,
  encrypted: EncryptedJournal,
): Promise<string> {
  return mutate({
    table: 'journal_entries',
    op: 'upsert',
    payload: {
      entryDate,
      createdAt: new Date().toISOString(),
      ciphertext: bytesToBase64(encrypted.ciphertext),
      nonce: bytesToBase64(encrypted.nonce),
    },
  });
}
