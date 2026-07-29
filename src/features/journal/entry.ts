import { base64ToBytes } from '@/crypto/base64';
import { decryptJournal, encryptJournal, type JournalContent } from '@/crypto/journal';
import { db } from '@/local/dexie';
import { journalEntryId } from '@/local/uuid5';
import { journalDek } from './lock-store';
import { writeJournalEntry } from './write';

/** Local calendar day, `YYYY-MM-DD` — device-local, not UTC (`toISOString`
 * would drift a day near midnight for anyone west of Greenwich). Playwright's
 * `page.clock` pins `Date` itself, so this stays deterministic in tests. Shared
 * between the editor and the "written today?" overview section (issue #342) —
 * one definition, so the two can never disagree on what day "today" is. */
export function todayKey(): string {
  return new Date().toLocaleDateString('en-CA');
}

/** No mood, no text, no tags — writing this for a day that has no row yet would
 * plant a ghost entry S5's "written today?" flag would then wrongly report. */
function isEmptyContent(content: JournalContent): boolean {
  return !content.mood && content.text === '' && (content.tags ?? []).length === 0;
}

/** `null` while the journal is locked, or once there is nothing to show yet. */
export async function loadJournalEntry(entryDate: string): Promise<JournalContent | null> {
  const dek = journalDek();
  if (!dek) return null;

  const rowId = await journalEntryId(entryDate);
  const row = await db.records.get(['journal_entries', rowId] as never);
  if (!row || row.deletedAt !== null) return null;

  const ciphertext = base64ToBytes(row.data.ciphertext as string);
  const nonce = base64ToBytes(row.data.nonce as string);
  return decryptJournal(dek, ciphertext, nonce);
}

/**
 * Encrypts mood/text/tags into the one ciphertext (ADR-0004) and upserts through
 * the existing write path (issue #338 AC5) — same deterministic row id, so a
 * second call for the same day always lands on the same row. A no-op while
 * locked, since there is no key to encrypt with.
 */
export async function saveJournalEntry(entryDate: string, content: JournalContent): Promise<void> {
  const dek = journalDek();
  if (!dek) return;

  if (isEmptyContent(content)) {
    const rowId = await journalEntryId(entryDate);
    const existing = await db.records.get(['journal_entries', rowId] as never);
    if (!existing || existing.deletedAt !== null) return;
  }

  const encrypted = await encryptJournal(dek, content);
  await writeJournalEntry(entryDate, encrypted);
}
