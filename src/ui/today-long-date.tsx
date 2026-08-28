'use client';

import { useSyncExternalStore } from 'react';

const LONG_DATE_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

function subscribe() {
  return () => {};
}

function getSnapshot() {
  return LONG_DATE_FORMATTER.format(new Date());
}

function getServerSnapshot() {
  return null;
}

const NBSP = ' ';

/**
 * Augenbraue „Dienstag, 16. August" über dem Seitentitel — geteilt von
 * Übersicht und Journal (issue #868, ersetzt dort das frühere, kurze
 * `JournalHeaderDate`). Gleiches Hydration-Muster wie `GreetingHeading`
 * (`useSyncExternalStore`, Server-Snapshot `null`): der Server kennt „heute"
 * nicht zuverlässig wie der Client. NBSP statt `null` vor der Hydration (wie
 * `GreetingHeading`): die Augenbraue sitzt über der Titelzeile, ein wirklich
 * leeres Element hat Höhe 0 und der Titel rutschte beim Hydration-Flip eine
 * Zeile nach oben.
 */
export function TodayLongDate() {
  const label = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return <>{label ?? NBSP}</>;
}
