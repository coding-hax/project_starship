import { db } from '@/local/dexie';
import { mutate } from '@/local/outbox';

/**
 * Fixed, checked-in row id (ADR-0016 pattern, same as `JOURNAL_KEYS_ROW_ID` in
 * journal-keys.ts) — the Journal habit is a normal `habits` row, recognized by
 * this id alone (issue #505).
 */
export const JOURNAL_HABIT_ID = '5b5c9dc3-25c8-4f97-a4c5-61cb4c736c80';
export const JOURNAL_HABIT_NAME = 'Journal';
export const JOURNAL_HABIT_COLOR = '--area-journal';

async function readHabitRow() {
  return db.records.get(['habits', JOURNAL_HABIT_ID] as never);
}

/**
 * Idempotent on row *existence* alone (issue #505 "Kein Ping-Pong über den
 * Sync") — an archived row is left untouched, so calling this on every boot
 * never fights an archive done elsewhere. Callers decide *when* it is safe to
 * call (see journal-habit-boot.tsx: never before the first pull, or this would
 * clobber a rhythm/color already chosen on another device).
 */
export async function ensureJournalHabit(): Promise<void> {
  const existing = await readHabitRow();
  if (existing) return;

  await mutate({
    table: 'habits',
    rowId: JOURNAL_HABIT_ID,
    op: 'upsert',
    payload: {
      name: JOURNAL_HABIT_NAME,
      schedule: 'daily',
      color: JOURNAL_HABIT_COLOR,
      archivedAt: null,
      createdAt: new Date().toISOString(),
    },
  });
}

export async function archiveJournalHabit(): Promise<void> {
  const existing = await readHabitRow();
  if (!existing || existing.deletedAt !== null) return;
  if (existing.data.archivedAt) return;

  await mutate({
    table: 'habits',
    rowId: JOURNAL_HABIT_ID,
    op: 'upsert',
    payload: { archivedAt: new Date().toISOString() },
  });
}

export async function unarchiveJournalHabit(): Promise<void> {
  await ensureJournalHabit();
  const existing = await readHabitRow();
  if (!existing?.data.archivedAt) return;

  await mutate({
    table: 'habits',
    rowId: JOURNAL_HABIT_ID,
    op: 'upsert',
    payload: { archivedAt: null },
  });
}

/**
 * Checks off the Journal habit for `entryDate` (issue #505 AC4) — the row is
 * display-only from the habit UI's side (habit-today.tsx/habit-week-grid.tsx
 * never toggle it), this is its only writer. Looks up any existing log row
 * first, same reasoning as use-toggle-habit-log.ts: a second entry the same
 * day must upsert that row instead of racing `UNIQUE(habit_id, log_date)` with
 * a fresh insert (ADR-0018).
 */
export async function logJournalHabit(entryDate: string): Promise<void> {
  const existing = await db.records
    .where('table')
    .equals('habit_logs')
    .and(
      (row) =>
        row.deletedAt === null &&
        row.data.habitId === JOURNAL_HABIT_ID &&
        row.data.logDate === entryDate,
    )
    .first();

  if (existing?.data.done === true) return;

  // Server FK: habit_logs.habit_id -> habits.id. Push applies mutations in
  // outbox order, so the habit row must be enqueued before the log that
  // points at it.
  await ensureJournalHabit();

  await mutate({
    table: 'habit_logs',
    rowId: existing?.id,
    op: 'upsert',
    payload: existing ? { done: true } : { habitId: JOURNAL_HABIT_ID, logDate: entryDate, done: true },
  });
}
