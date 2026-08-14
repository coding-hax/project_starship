'use client';

import { type CSSProperties } from 'react';
import { useJournalSearchEntries } from './use-journal-search-entries';
import './journal-mood-band.css';

const BAND_DAYS = 14;

const DAY_LABEL_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  weekday: 'short',
  day: 'numeric',
  month: 'long',
});

interface DaySlot {
  key: string;
  date: Date;
  isToday: boolean;
  /** Arithmetic mean of the day's set moods (issue #700 Q1), or `null` when the
   * day has no entry at all or only entries without a mood — a plain text entry
   * must not pull the day up or down. `null` renders the grey baseline. */
  mean: number | null;
}

/** The 14 day slots, oldest first so the band reads left→right into today. Keys
 * are built device-locally (same basis as `todayKey()` in entry.ts) — never via
 * `toISOString`, which drifts a day near midnight west of Greenwich and would
 * stop matching the stored `entryDate`. */
function buildDaySlots(moodsByDay: Map<string, number[]>): DaySlot[] {
  const slots: DaySlot[] = [];
  for (let offset = BAND_DAYS - 1; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - offset);
    const key = date.toLocaleDateString('en-CA');
    const moods = moodsByDay.get(key);
    const mean =
      moods && moods.length > 0 ? moods.reduce((sum, value) => sum + value, 0) / moods.length : null;
    slots.push({ key, date, isToday: offset === 0, mean });
  }
  return slots;
}

/** Only entries with a real numeric mood contribute — a mood-less text entry
 * leaves the day on the grey baseline (see `DaySlot.mean`). */
function collectMoodsByDay(
  entries: { entryDate: string; mood?: string }[],
): Map<string, number[]> {
  const byDay = new Map<string, number[]>();
  for (const entry of entries) {
    if (entry.mood == null) continue;
    const value = Number(entry.mood);
    if (Number.isNaN(value)) continue;
    const bucket = byDay.get(entry.entryDate);
    if (bucket) bucket.push(value);
    else byDay.set(entry.entryDate, [value]);
  }
  return byDay;
}

function slotLabel(slot: DaySlot): string {
  const day = DAY_LABEL_FORMATTER.format(slot.date);
  if (slot.mean === null) return `${day} · keine Stimmung`;
  const mean = slot.mean.toLocaleString('de-DE', { maximumFractionDigits: 1 });
  return `${day} · ⌀ ${mean}`;
}

/**
 * A 14-day mood band above the entry stream (issue #703): one slot per day,
 * today last and marked. Each day's height is the arithmetic mean of that day's
 * set moods (issue #700 Q1, bound in #700); a day with no entry — or only
 * mood-less entries — shows a grey baseline instead of a coloured bar, and is
 * never left out (AK1). Pure read consumer of the session cache the editor
 * already decrypts on every unlocked page (`useJournalSearchEntries`), so it
 * costs no extra decrypt (AK7).
 *
 * Rendered only in the unlocked, non-search branch of `JournalEditor`, so it is
 * absent while locked and absent in search mode (AK6) without its own guard.
 */
export function JournalMoodBand() {
  const entries = useJournalSearchEntries();

  // Loading or locked — render nothing, no skeleton (matches the editor's own
  // no-loading-state convention, AK7).
  if (entries === undefined) return null;

  // Loaded but there is not a single entry yet: a calm note instead of an empty
  // band frame (AK8). A few entries — even none within the last 14 days — still
  // render the band (grey baselines), the note is only for "no entry at all".
  if (entries.length === 0) {
    return (
      <p className="journal-mood-band__empty">
        Noch keine Stimmungen. Dein Stimmungsband der letzten zwei Wochen erscheint hier, sobald du
        deine erste Stimmung festhältst.
      </p>
    );
  }

  const slots = buildDaySlots(collectMoodsByDay(entries));

  return (
    <div className="journal-mood-band" aria-label="Stimmung der letzten 14 Tage">
      {slots.map((slot) => (
        <div
          key={slot.key}
          className="journal-mood-band__slot"
          data-today={slot.isToday || undefined}
          aria-current={slot.isToday ? 'date' : undefined}
          title={slotLabel(slot)}
          aria-label={slotLabel(slot)}
        >
          {slot.mean === null ? (
            <span className="journal-mood-band__baseline" />
          ) : (
            <span
              className="journal-mood-band__bar"
              style={{ '--mood': slot.mean } as CSSProperties}
            />
          )}
        </div>
      ))}
    </div>
  );
}
