'use client';

import { IconChevronLeft, IconChevronRight } from '@/ui/icons';
import { useJournalDayNav } from './journal-current-day';

const LONG_DATE_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

/** Blank rather than empty (issue #868's `TodayLongDate` reasoning): a truly
 * empty element has zero height, and the title row below would jump up for
 * the one render before hydration settles. */
const NBSP = ' ';

/** Local calendar day (not UTC), same reasoning as `entry.ts`'s `todayKey`. */
function formatDayLong(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  return LONG_DATE_FORMATTER.format(new Date(year, month - 1, day));
}

/**
 * Chevrons flanking the shown day's long date, in the journal's own eyebrow
 * row (issue #1050, AK4/AK6) — replaces the plain `TodayLongDate` that used to
 * sit there, now that the page can show any day, not just today. Reads the
 * same module store the swipeable day card does (`journal-current-day.ts`),
 * so a chevron here and a swipe over the card change the very same day; no
 * animation here either way (AK3: the header itself never glides).
 */
export function JournalDayNav() {
  const { date, nextDate, previousDate, goTo } = useJournalDayNav();

  return (
    <div className="journal-page__day-nav">
      <button
        type="button"
        className="journal-page__day-nav-button"
        aria-label="Vorheriger Tag"
        disabled={!previousDate}
        onClick={() => previousDate && goTo(previousDate)}
      >
        <IconChevronLeft />
      </button>
      <span className="journal-page__day-nav-date">{date ? formatDayLong(date) : NBSP}</span>
      <button
        type="button"
        className="journal-page__day-nav-button"
        aria-label="Nächster Tag"
        disabled={!nextDate}
        onClick={() => nextDate && goTo(nextDate)}
      >
        <IconChevronRight />
      </button>
    </div>
  );
}
