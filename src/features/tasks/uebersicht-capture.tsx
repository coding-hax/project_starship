'use client';

import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { matchHabit } from '@/features/capture/habit-match';
import { hasCompletionVerb } from '@/features/capture/local-recognizer';
import {
  allowedCaptureKinds,
  decideCaptureRoute,
  previewKind,
} from '@/features/capture/route-capture';
import type { CaptureKind } from '@/features/capture/types';
import { useHabitLogs } from '@/features/habits/use-habit-logs';
import { useHabits } from '@/features/habits/use-habits';
import { useToggleHabitLog } from '@/features/habits/use-toggle-habit-log';
import { JOURNAL_HABIT_ID } from '@/features/journal/journal-habit';
import { useModules } from '@/features/settings/use-modules';
import { Chip } from '@/ui/chip';
import { Sheet } from '@/ui/sheet';
import { Toast } from '@/ui/toast';
import { setCaptureDraft } from './capture-draft-store';

const LABEL = 'Aufgabe erfassen';
const FORM_ID = 'uebersicht-capture-form';
const UNDO_TIMEOUT_MS = 5000;
const ART_PANEL_ID = 'uebersicht-capture-panel-art';

const ART_LABELS: Record<CaptureKind, string> = {
  task: 'Aufgabe',
  event: 'Termin',
  habit_check: 'Routine',
};

/** Referenz statt fertigem `oklch(...)`, damit Light-/Dark-Mode-Variante und der
 * einheitliche Motion-Übergang von `--accent` (tokens.css) automatisch greifen. */
const ART_ACCENT: Record<CaptureKind, string> = {
  task: 'var(--area-tasks)',
  event: 'var(--area-events)',
  habit_check: 'var(--area-habits)',
};

/** Welche Chip-Panel gerade offen ist — bislang nur „Art", weitere Kern-Chips
 * kommen mit AK3/AK4/AK5 dazu. */
type ChipKey = 'art';

interface HabitCheckUndo {
  habitId: string;
  habitName: string;
  logDate: string;
}

/**
 * Erfassungsknopf in der Titelzeile von `/uebersicht`: ein Freitextfeld, dessen
 * Ergebnis der Erkenner (`route-capture.ts`) laufend liest — der Art-Chip zeigt
 * die erkannte Art, bevor überhaupt angelegt wird (issue #715 AK1), der Akzent
 * des Sheets folgt ihr (AK2). Tippen auf den Chip überschreibt die Art von Hand
 * (`kindOverridden`) — bleibt dann fest, bis die nächste Sheet-Öffnung sie
 * zurücksetzt, genau wie eine geratene Fälligkeit erst durch eine bewusste
 * Eingabe „bestätigt" wird (#711 AK2).
 */
export function UebersichtCapture() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [now, setNow] = useState<Date>(() => new Date());
  const [kindOverridden, setKindOverridden] = useState<CaptureKind | null>(null);
  const [openChip, setOpenChip] = useState<ChipKey | null>(null);
  const [habitUndo, setHabitUndo] = useState<HabitCheckUndo | null>(null);
  const [unresolvedHabit, setUnresolvedHabit] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const undoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();
  const { isActive } = useModules();
  const habits = useHabits();
  const logs = useHabitLogs();
  const toggleHabitLog = useToggleHabitLog(logs);

  const captureHabits = useMemo(
    () =>
      (habits ?? [])
        .filter((habit) => habit.archivedAt === null && habit.id !== JOURNAL_HABIT_ID)
        .map((habit) => ({ id: habit.id, name: habit.name })),
    [habits],
  );
  const allowedKinds = useMemo(() => allowedCaptureKinds(isActive), [isActive]);

  // Reaktiv bei jedem Tastendruck neu berechnet (AK1) — derselbe Erkenner wie
  // beim Absenden, nur ohne dass er hier schon etwas anlegt oder navigiert.
  const decision = useMemo(
    () => decideCaptureRoute(title, { now, tz: 'Europe/Berlin', habits: captureHabits, allowedKinds }),
    [title, now, captureHabits, allowedKinds],
  );
  const displayedKind = kindOverridden ?? previewKind(decision);

  function toggleChip(key: ChipKey) {
    setOpenChip((current) => (current === key ? null : key));
  }

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
    const raw = title.trim();

    if (!raw) {
      inputRef.current?.focus();
      return;
    }

    // Journal ist nie ein Erfassungsziel (CLAUDE.md Regel 9) und die Journal-
    // Gewohnheit hakt sich nur über einen geschriebenen Eintrag ab, nie manuell
    // (habit-today.tsx sperrt ihre Checkbox genauso).
    // AK6 (#687): ein Erledigungsverb ohne (oder mit verneintem) Habit-Treffer legt
    // nichts an — weder Aufgabe noch Abhaken. `matchHabit` liefert bei Verneinung
    // ("Sport heute nicht gemacht") bewusst `matched: false`, genau wie bei einem
    // echten Nicht-Treffer ("Wäsche erledigt") — beide laufen hier zusammen.
    if (hasCompletionVerb(raw) && !matchHabit(raw, captureHabits).matched) {
      setUnresolvedHabit(true);
      return;
    }
    setUnresolvedHabit(false);

    setTitle('');
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
          setTitle('');
          setKindOverridden(null);
          setOpenChip(null);
          setNow(new Date());
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
        accent={ART_ACCENT[displayedKind]}
      >
        <form id={FORM_ID} className="quick-add" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            name="title"
            className="quick-add__input"
            placeholder="Todo Titel"
            aria-label="Titel der Aufgabe"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <div className="quick-add__chips">
            <Chip
              field="Art"
              emptyLabel="Art?"
              value={ART_LABELS[displayedKind]}
              guessed={kindOverridden === null}
              open={openChip === 'art'}
              panelId={ART_PANEL_ID}
              onOpen={() => toggleChip('art')}
            />
          </div>
          {openChip === 'art' && (
            <fieldset className="quick-add__priority" aria-label="Art" id={ART_PANEL_ID}>
              {allowedKinds.map((kind) => (
                <label key={kind} className="quick-add__priority-option">
                  <input
                    type="radio"
                    name="uebersicht-capture-art"
                    checked={displayedKind === kind}
                    onPointerDown={(event) => event.preventDefault()}
                    onChange={() => setKindOverridden(kind)}
                  />
                  {ART_LABELS[kind]}
                </label>
              ))}
            </fieldset>
          )}
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
