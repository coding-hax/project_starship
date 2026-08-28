'use client';

import { useTasks } from './use-tasks';

/**
 * Augenbraue auf /aufgaben (issue #868): „N offen · M erledigt" über alle
 * Aufgaben-Zeilen (Eltern + Unteraufgaben) aus `useTasks()` — kein Tages-
 * oder Sichtfilter wie `TaskList`/`belongsOnUebersicht`, einfach der volle
 * Bestand.
 */
export function AufgabenCount() {
  const tasks = useTasks();
  if (tasks === undefined) return null;

  const done = tasks.filter((task) => task.completedAt !== null).length;
  const open = tasks.length - done;

  return <>{`${open} offen · ${done} erledigt`}</>;
}
