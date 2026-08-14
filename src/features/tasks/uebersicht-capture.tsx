'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { matchHabit } from '@/features/capture/habit-match';
import { hasCompletionVerb } from '@/features/capture/local-recognizer';
import { allowedCaptureKinds, decideCaptureRoute } from '@/features/capture/route-capture';
import { useHabitLogs } from '@/features/habits/use-habit-logs';
import { useHabits } from '@/features/habits/use-habits';
import { useToggleHabitLog } from '@/features/habits/use-toggle-habit-log';
import { JOURNAL_HABIT_ID } from '@/features/journal/journal-habit';
import { useModules } from '@/features/settings/use-modules';
import { Sheet } from '@/ui/sheet';
import { Toast } from '@/ui/toast';
import { setCaptureDraft } from './capture-draft-store';

const LABEL = 'Aufgabe erfassen';
const FORM_ID = 'uebersicht-capture-form';
const UNDO_TIMEOUT_MS = 5000;

interface HabitCheckUndo {
  habitId: string;
  habitName: string;
  logDate: string;
}

/**
 * Erfassungsknopf in der Titelzeile von `/uebersicht`: ein Freitextfeld, dessen
 * Ergebnis der Router (issue #619, `route-capture.ts`) in eine von drei Bahnen
 * lenkt — `task`/`event` wandern über den Draft-Store zum passenden Editor
 * (`/aufgaben` bzw. `/kalender`, issue #618/#619), `habit_check` hakt bei hoher
 * Konfidenz sofort ab (Undo-Toast, kein Editor) oder schickt bei unklarem
 * Treffer nach `/routinen`, ohne etwas anzurühren.
 */
export function UebersichtCapture() {
  const [open, setOpen] = useState(false);
  const [habitUndo, setHabitUndo] = useState<HabitCheckUndo | null>(null);
  const [unresolvedHabit, setUnresolvedHabit] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const undoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();
  const { isActive } = useModules();
  const habits = useHabits();
  const logs = useHabitLogs();
  const toggleHabitLog = useToggleHabitLog(logs);

  function dismissHabitUndo() {
    if (undoTimeoutRef.current !== null) {
      clearTimeout(undoTimeoutRef.current);
      undoTimeoutRef.current = null;
    }
    setHabitUndo(null);
  }

  async function handleHabitUndo() {
    if (!habitUndo) return;
    const { habitId, logDate } = habitUndo;
    dismissHabitUndo();
    await toggleHabitLog(habitId, logDate);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const raw = inputRef.current?.value.trim();

    if (!raw) {
      inputRef.current?.focus();
      return;
    }

    // Journal ist nie ein Erfassungsziel (CLAUDE.md Regel 9) und die Journal-
    // Gewohnheit hakt sich nur über einen geschriebenen Eintrag ab, nie manuell
    // (habit-today.tsx sperrt ihre Checkbox genauso).
    const captureHabits = (habits ?? [])
      .filter((habit) => habit.archivedAt === null && habit.id !== JOURNAL_HABIT_ID)
      .map((habit) => ({ id: habit.id, name: habit.name }));

    // AK6 (#687): ein Erledigungsverb ohne (oder mit verneintem) Habit-Treffer legt
    // nichts an — weder Aufgabe noch Abhaken. `matchHabit` liefert bei Verneinung
    // ("Sport heute nicht gemacht") bewusst `matched: false`, genau wie bei einem
    // echten Nicht-Treffer ("Wäsche erledigt") — beide laufen hier zusammen.
    if (hasCompletionVerb(raw) && !matchHabit(raw, captureHabits).matched) {
      setUnresolvedHabit(true);
      return;
    }
    setUnresolvedHabit(false);

    const decision = decideCaptureRoute(raw, {
      now: new Date(),
      tz: 'Europe/Berlin',
      habits: captureHabits,
      allowedKinds: allowedCaptureKinds(isActive),
    });

    if (inputRef.current) inputRef.current.value = '';
    setOpen(false);

    if (decision.action === 'task') {
      setCaptureDraft({ items: [decision.draft] });
      router.push('/aufgaben');
      return;
    }

    if (decision.action === 'event') {
      setCaptureDraft({ items: [decision.draft] });
      router.push('/kalender');
      return;
    }

    if (decision.action === 'habit-review') {
      router.push('/routinen');
      return;
    }

    const { habitId, logDate } = decision;
    const habitName = captureHabits.find((habit) => habit.id === habitId)?.name ?? '';
    dismissHabitUndo();
    await toggleHabitLog(habitId, logDate);
    setHabitUndo({ habitId, habitName, logDate });
    undoTimeoutRef.current = setTimeout(dismissHabitUndo, UNDO_TIMEOUT_MS);
  }

  return (
    <>
      <button
        type="button"
        className="uebersicht-capture__button"
        onClick={() => {
          setUnresolvedHabit(false);
          setOpen(true);
        }}
        aria-label={LABEL}
      >
        <span aria-hidden="true">+</span>
      </button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        label={LABEL}
        initialFocusRef={inputRef}
        header={{ actionLabel: 'Anlegen', formId: FORM_ID }}
      >
        <form id={FORM_ID} className="quick-add" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            name="title"
            className="quick-add__input"
            placeholder="Todo Titel"
            aria-label="Titel der Aufgabe"
          />
          {unresolvedHabit && (
            <p role="status" className="uebersicht-capture__notice">
              Keiner Gewohnheit zugeordnet.
            </p>
          )}
        </form>
      </Sheet>
      {habitUndo && (
        <Toast
          message={`„${habitUndo.habitName}" abgehakt`}
          actionLabel="Rückgängig"
          onAction={handleHabitUndo}
          onDismiss={dismissHabitUndo}
        />
      )}
    </>
  );
}
