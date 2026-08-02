'use client';

import { useSyncExternalStore } from 'react';
import './journal-header-date.css';

const HEADER_DATE_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  weekday: 'short',
  day: 'numeric',
  month: 'long',
});

function subscribe() {
  return () => {};
}

function getSnapshot() {
  return HEADER_DATE_FORMATTER.format(new Date());
}

function getServerSnapshot() {
  return null;
}

/** Heutiges Datum neben der Seitenüberschrift, oben rechts (issue #469) — anders
 * als `.journal-editor__date` zeigt dies immer den heutigen Tag, unabhängig
 * vom über die Suche ausgewählten, im Editor sichtbaren Tag.
 *
 * `useSyncExternalStore` statt `useState`/`new Date()` beim Rendern: der
 * Server kennt "heute" nicht zuverlässig genauso wie der Client
 * (Hydration-Mismatch) — derselbe Grund wie bei `useOnline` in
 * `task-list.tsx` und `useAppearance`. Der Server-Snapshot bleibt `null`,
 * der Client füllt ihn beim ersten Render nach der Hydration. */
export function JournalHeaderDate() {
  const label = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  if (label === null) return null;

  return <span className="journal-header-date">{label}</span>;
}
