import { base64ToBytes } from '@/crypto/base64';
import { decryptJournal, type JournalContent } from '@/crypto/journal';
import { db, type JournalConflict } from '@/local/dexie';
import { appendJournalEntry } from './entry';
import { journalDek } from './lock-store';

/** `null` while locked — the conflict copy stays opaque until the DEK is back. */
export async function decryptJournalConflict(conflict: JournalConflict): Promise<JournalContent | null> {
  const dek = journalDek();
  if (!dek) return null;
  const ciphertext = base64ToBytes(conflict.ciphertext);
  const nonce = base64ToBytes(conflict.nonce);
  return decryptJournal(dek, ciphertext, nonce);
}

/**
 * Brings the displaced version back as a new entry for that day (AC8) — a
 * visible choice, not a silent merge. Since issue #376 there is no single
 * "current entry" per day to overwrite, so restoring appends it like any other
 * submission. Removes the conflict copy only once it is actually restored, so a
 * locked/failed attempt never loses it.
 */
export async function restoreJournalConflict(conflict: JournalConflict): Promise<void> {
  const content = await decryptJournalConflict(conflict);
  if (!content) return;
  await appendJournalEntry(conflict.entryDate, content);
  await db.journalConflicts.delete(conflict.id);
}
