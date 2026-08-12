'use client';

import { IconHideCompleted } from '@/ui/icons';
import { useHideCompletedTasks } from './use-hide-completed-tasks';
import './hide-completed-toggle.css';

/** Sitzt neben der Überschrift auf /aufgaben (issue #654) — eine feste
 * Icon-Form, der Zustand steckt nur in Farbe und `aria-pressed`. */
export function HideCompletedToggle() {
  const { hideCompleted, setHideCompleted } = useHideCompletedTasks();

  return (
    <button
      type="button"
      className="hide-completed-toggle"
      aria-pressed={hideCompleted}
      aria-label="Erledigte Aufgaben ausblenden"
      onClick={() => setHideCompleted(!hideCompleted)}
    >
      <IconHideCompleted />
    </button>
  );
}
