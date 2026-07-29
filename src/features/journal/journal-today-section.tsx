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
 */
export function JournalTodaySection() {
  const today = useJournalToday();

  if (!today) return null;

  return (
    <Link href="/journal" className="journal-today-section">
      <h2 className="journal-today-section__heading">Journal</h2>
      <p className="journal-today-section__status">
        {today.written
          ? today.mood
            ? `Heute geschrieben — Stimmung ${today.mood}/10`
            : 'Heute geschrieben'
          : 'Heute noch nicht geschrieben'}
      </p>
    </Link>
  );
}
