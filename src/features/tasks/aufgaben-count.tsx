'use client';

import { useTasks } from './use-tasks';

const NBSP = ' ';

/**
 * Augenbraue auf /aufgaben (issue #868): „N offen · M erledigt" über alle
 * Aufgaben-Zeilen (Eltern + Unteraufgaben) aus `useTasks()` — kein Tages-
 * oder Sichtfilter wie `TaskList`/`belongsOnUebersicht`, einfach der volle
 * Bestand.
 *
 * NBSP statt `null` während `useTasks()` noch lädt (gleiches Muster wie
 * `TodayLongDate`/`GreetingHeading`): ein leeres Element hat Höhe 0, die
 * Augenbraue-Zeile wächst sonst beim Eintreffen der ersten IndexedDB-Antwort
 * von 0 auf eine Zeile und verschiebt den Titel darunter (CI-Fund
 * formsprache.spec.ts AK6, gemessener Layout-Shift 0,0063 > Schwelle 0,001).
 */
export function AufgabenCount() {
  const tasks = useTasks();
  if (tasks === undefined) return <>{NBSP}</>;

  const done = tasks.filter((task) => task.completedAt !== null).length;
  const open = tasks.length - done;

  return <>{`${open} offen · ${done} erledigt`}</>;
}
