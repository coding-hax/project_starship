import { base64ToBytes } from '@/crypto/base64';
import { decryptJournal, encryptJournal, type JournalContent } from '@/crypto/journal';
import { db, type LocalRecord } from '@/local/dexie';
import { mutate } from '@/local/outbox';
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

/** Milliseconds until the next device-local midnight — the exact point at
 * which the editor's visible "today" (issue #374 AC2) needs to roll onto the
 * new day, same local basis as `todayKey`. Scheduling a single timeout for
 * this instant, instead of polling, means there's no window where a
 * submission just after midnight could still land on the old day (AC3). */
export function msUntilNextMidnight(): number {
  const now = new Date();
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return nextMidnight.getTime() - now.getTime();
}

/** No mood, no text, no tags — submitting this would create an entry with
 * nothing in it (issue #376 AC2: submit is explicit, but an empty submission
 * still has nothing worth storing). */
function isEmptyContent(content: JournalContent): boolean {
  return !content.mood && content.text === '' && (content.tags ?? []).length === 0;
}

export interface JournalEntryView {
  id: string;
  entryDate: string;
  /** ISO. Client-set at write time (write.ts) — falls back to the record's
   * `updatedAt` for entries written before issue #376, which never got a
   * `createdAt` payload field. */
  createdAt: string;
  content: JournalContent;
}

async function decryptRow(dek: CryptoKey, row: LocalRecord): Promise<JournalEntryView> {
  const ciphertext = base64ToBytes(row.data.ciphertext as string);
  const nonce = base64ToBytes(row.data.nonce as string);
  const content = await decryptJournal(dek, ciphertext, nonce);
  return {
    id: row.id,
    entryDate: row.data.entryDate as string,
    createdAt: (row.data.createdAt as string | undefined) ?? row.updatedAt,
    content,
  };
}

/**
 * Every entry for one day, newest first (AC3). `[]` while locked — there is no
 * key to open anything with.
 */
export async function listJournalEntries(entryDate: string): Promise<JournalEntryView[]> {
  const dek = journalDek();
  if (!dek) return [];

  const rows = await db.records
    .where('table')
    .equals('journal_entries')
    .and((row) => row.deletedAt === null && row.data.entryDate === entryDate)
    .toArray();

  const entries = await Promise.all(rows.map((row) => decryptRow(dek, row)));
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Encrypts mood/text/tags into one ciphertext (ADR-0004) and appends a new row
 * through the write path (write.ts) — every submission is its own entry (issue
 * #376), never an edit of a previous one. A no-op while locked or for an empty
 * submission.
 */
export async function appendJournalEntry(entryDate: string, content: JournalContent): Promise<void> {
  const dek = journalDek();
  if (!dek || isEmptyContent(content)) return;

  const encrypted = await encryptJournal(dek, content);
  await writeJournalEntry(entryDate, encrypted);
}

/** Soft-delete over the existing sync path (AC5) — same tombstone mechanism as
 * every other table, no journal-specific delete route. */
export async function deleteJournalEntry(id: string): Promise<void> {
  await mutate({ table: 'journal_entries', rowId: id, op: 'delete' });
}
