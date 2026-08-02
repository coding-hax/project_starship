'use client';

import './journal-header-date.css';

const HEADER_DATE_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  weekday: 'short',
  day: 'numeric',
  month: 'long',
});

/** Heutiges Datum neben der Seitenüberschrift, oben rechts (issue #469) — anders
 * als `.journal-editor__date` zeigt dies immer den heutigen Tag, unabhängig
 * vom über die Suche ausgewählten, im Editor sichtbaren Tag. */
export function JournalHeaderDate() {
  return <span className="journal-header-date">{HEADER_DATE_FORMATTER.format(new Date())}</span>;
}
