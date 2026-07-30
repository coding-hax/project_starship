'use client';

import Link from 'next/link';
import './journal-today-section.css';
import { useJournalToday } from './use-journal-today';

/**
 * "Heute schon geschrieben?" (issue #342, S5 of #302) — binary state from
 * `entryDate` alone, correct even while the journal is locked (AC1/AC2). Richer
 * only once unlocked and a mood was recorded (AC4); no schema change and no new
 * plaintext field back it (AC3, see `use-journal-today.ts`). The whole card is
 * one `<Link>` to `/journal`, same pattern as `activity-month-strip.tsx` (AC5).
 *
 * `aria-label` carries the state so the link's accessible name differs from the
 * nav's plain "Journal" — two links with the same accessible name on one page is
 * an a11y bug (issue #363, found via #342's `shell.spec.ts` strict-mode violation).
 */
export function JournalTodaySection() {
  const today = useJournalToday();

  if (!today) return null;

  const status = today.written
    ? today.mood
      ? `heute geschrieben, Stimmung ${today.mood} von 10`
      : 'heute geschrieben'
    : 'heute noch nicht geschrieben';

  return (
    <Link href="/journal" className="journal-today-section" aria-label={`Journal — ${status}`}>
      <p className="journal-today-section__heading" aria-hidden="true">
        Journal
      </p>
      <p className="journal-today-section__status" aria-hidden="true">
        {today.written
          ? today.mood
            ? `Heute geschrieben — Stimmung ${today.mood}/10`
            : 'Heute geschrieben'
          : 'Heute noch nicht geschrieben'}
      </p>
    </Link>
  );
}
