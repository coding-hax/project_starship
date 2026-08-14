'use client';

import { useMemo, useRef, useState, type FormEvent } from 'react';
import { matchHabit } from '@/features/capture/habit-match';
import { hasCompletionVerb } from '@/features/capture/local-recognizer';
import {
  allowedCaptureKinds,
  defaultEventStart,
  eventFieldsFromDraft,
  habitFieldsFromDraft,
  previewDraft,
  taskFieldsFromDraft,
} from '@/features/capture/route-capture';
import type { CaptureKind } from '@/features/capture/types';
import { EVENT_CATEGORIES } from '@/features/events/use-events';
import { useHabitLogs } from '@/features/habits/use-habit-logs';
import { useHabits } from '@/features/habits/use-habits';
import { useToggleHabitLog } from '@/features/habits/use-toggle-habit-log';
import { JOURNAL_HABIT_ID } from '@/features/journal/journal-habit';
import { useModules } from '@/features/settings/use-modules';
import { mutate } from '@/local/outbox';
import { Chip } from '@/ui/chip';
import { Sheet } from '@/ui/sheet';
import { Toast } from '@/ui/toast';
import { formatDueLabel, isoToLocalInput, localInputToIso } from './datetime-local';
import { PRIORITIES } from './quick-add';

const LABEL = 'Aufgabe erfassen';
const FORM_ID = 'uebersicht-capture-form';
const UNDO_TIMEOUT_MS = 5000;
const ART_PANEL_ID = 'uebersicht-capture-panel-art';
const WANN_PANEL_ID = 'uebersicht-capture-panel-wann';
const PRIO_PANEL_ID = 'uebersicht-capture-panel-prio';
const ZEIT_PANEL_ID = 'uebersicht-capture-panel-zeit';
const KATEGORIE_PANEL_ID = 'uebersicht-capture-panel-kategorie';
const ROUTINE_PANEL_ID = 'uebersicht-capture-panel-routine';

/** Sentinel for "keine Kategorie" — same convention as `event-editor.tsx`. */
const NO_CATEGORY = '';

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

/** Welche Chip-Panel gerade offen ist — höchstens eine gleichzeitig. */
type ChipKey = 'art' | 'wann' | 'prio' | 'zeit' | 'kategorie' | 'routine';

const ROUTINE_UNRESOLVED_LABEL = 'Keiner Gewohnheit zugeordnet';

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
 *
 * AK3: Aufgabe und Termin legt „Anlegen" direkt über `mutate` an — kein
 * `router.push` mehr, das Sheet schließt und bleibt auf `/uebersicht`. Der
 * separate Bestätigen-Dialog entfällt auf diesem Pfad (anders als beim FAB in
 * `quick-add.tsx`): eine geratene Fälligkeit/Zeit zeigt sich inline als
 * `guessed`-Chip statt in einem Zwischenschritt.
 *
 * AK5: bei Art Routine macht der Routine-Kern-Chip den bisher stillen
 * „Keiner Gewohnheit zugeordnet"-Fall sichtbar (kein oder mehrdeutiger
 * `matchHabit`-Treffer) — „Anlegen" öffnet dann die Auswahl statt nichts zu
 * tun oder blind nach `/routinen` zu navigieren.
 */
export function UebersichtCapture() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [now, setNow] = useState<Date>(() => new Date());
  const [kindOverridden, setKindOverridden] = useState<CaptureKind | null>(null);
  const [openChip, setOpenChip] = useState<ChipKey | null>(null);
  // Aufgabe: Fälligkeit + Priorität. `dueOverride` ist `null`, solange der
  // Nutzer sie nicht angefasst hat (Chip-Wert folgt dann der Erkennung) — ein
  // leerer String zählt als bewusstes „kein Datum" (Discard), nicht als
  // unberührt (issue #711 AK2 Muster).
  const [dueOverride, setDueOverride] = useState<string | null>(null);
  const [priority, setPriority] = useState(0);
  // Termin: Zeit (Von) + Kategorie — „Bis" leitet sich beim Direkt-Anlegen aus
  // Von + 1h ab (AK4), Ganztägig/Wiederholung liegen hinter „Mehr" (P4).
  const [eventStartOverride, setEventStartOverride] = useState<string | null>(null);
  const [category, setCategory] = useState(NO_CATEGORY);
  // Routine: welche Gewohnheit abgehakt wird — `null` folgt der Erkennung
  // (AK5: nur bei eindeutigem Treffer vorbelegt), `''` ist die bewusste
  // Rücknahme auf „Keiner Gewohnheit zugeordnet".
  const [habitOverride, setHabitOverride] = useState<string | null>(null);
  const [habitUndo, setHabitUndo] = useState<HabitCheckUndo | null>(null);
  const [unresolvedHabit, setUnresolvedHabit] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const undoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const draft = useMemo(
    () => previewDraft(title, { now, tz: 'Europe/Berlin', habits: captureHabits, allowedKinds }),
    [title, now, captureHabits, allowedKinds],
  );
  const displayedKind = kindOverridden ?? draft.kind;

  // Kern-Kernfelder folgen der Erkennung, solange der Nutzer sie nicht selbst
  // angefasst hat (issue #711 AK2 Muster: ein geratener Wert gilt als
  // akzeptiert, bis er bewusst bearbeitet oder verworfen wird) — unabhängig
  // von `draft.kind`, damit eine von Hand überschriebene Art die erkannten
  // Felder trotzdem übernimmt. Abgeleitet statt effekt-synchronisiert: kein
  // zweiter Render-Zyklus nötig, nur `dueOverride`/`eventStartOverride` selbst
  // ist echter State.
  const taskFields = useMemo(() => taskFieldsFromDraft(draft), [draft]);
  const dueAt = dueOverride ?? isoToLocalInput(taskFields.dueAt);
  const dueGuessed = dueOverride === null && taskFields.dueAt !== null;

  const eventFields = useMemo(() => eventFieldsFromDraft(draft, now), [draft, now]);
  const eventStart =
    eventStartOverride ??
    (eventFields.startsAt ? isoToLocalInput(eventFields.startsAt) : defaultEventStart(now));
  const eventStartGuessed = eventStartOverride === null && eventFields.startsAt !== null;

  const habitFields = useMemo(() => habitFieldsFromDraft(draft, now), [draft, now]);
  const resolvedHabitId =
    habitOverride === null ? (habitFields.resolved ? habitFields.habitId : null) : habitOverride || null;
  const habitGuessed = habitOverride === null && habitFields.resolved;
  const habitName = resolvedHabitId
    ? (captureHabits.find((habit) => habit.id === resolvedHabitId)?.name ?? null)
    : null;

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

  function closeAndReset() {
    setOpen(false);
    setTitle('');
    setKindOverridden(null);
    setOpenChip(null);
    setDueOverride(null);
    setPriority(0);
    setEventStartOverride(null);
    setCategory(NO_CATEGORY);
    setHabitOverride(null);
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

    if (displayedKind === 'task') {
      const trimmedTitle = taskFields.title.trim();
      if (!trimmedTitle) {
        inputRef.current?.focus();
        return;
      }
      const payload: Record<string, unknown> = { title: trimmedTitle, createdAt: new Date().toISOString() };
      const finalDueAt = localInputToIso(dueAt);
      if (finalDueAt) payload.dueAt = finalDueAt;
      if (priority !== 0) payload.priority = priority;
      closeAndReset();
      await mutate({ table: 'tasks', op: 'upsert', payload });
      return;
    }

    if (displayedKind === 'event') {
      const trimmedTitle = eventFields.title.trim();
      if (!trimmedTitle) {
        inputRef.current?.focus();
        return;
      }
      const startsAt = localInputToIso(eventStart) ?? localInputToIso(defaultEventStart(now));
      const endsAt = startsAt
        ? new Date(new Date(startsAt).getTime() + 60 * 60 * 1000).toISOString()
        : null;
      const payload: Record<string, unknown> = {
        title: trimmedTitle,
        allDay: false,
        startsAt,
        endsAt,
        startDate: null,
        endDate: null,
        category: category || null,
      };
      closeAndReset();
      await mutate({ table: 'events', op: 'upsert', payload });
      return;
    }

    // habit_check (AK5): kein oder mehrdeutiger Treffer öffnet sichtbar die
    // Auswahl statt still nach /routinen zu navigieren — „Anlegen" verlangt
    // erst eine bewusste Wahl.
    if (!resolvedHabitId) {
      setOpenChip('routine');
      return;
    }
    const checkedHabitName = captureHabits.find((habit) => habit.id === resolvedHabitId)?.name ?? '';
    const logDate = habitFields.logDate;
    closeAndReset();
    dismissHabitUndo();
    await toggleHabitLog(resolvedHabitId, logDate);
    setHabitUndo({ habitId: resolvedHabitId, habitName: checkedHabitName, logDate });
    undoTimeoutRef.current = setTimeout(dismissHabitUndo, UNDO_TIMEOUT_MS);
  }

  const priorityLabel = priority !== 0 ? PRIORITIES.find((p) => p.value === priority)!.label : null;
  const categoryLabel = category
    ? (EVENT_CATEGORIES.find((c) => c.value === category)?.label ?? null)
    : null;

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
          setDueOverride(null);
          setPriority(0);
          setEventStartOverride(null);
          setCategory(NO_CATEGORY);
          setHabitOverride(null);
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
            {displayedKind === 'task' && (
              <>
                <Chip
                  field="Fälligkeit"
                  emptyLabel="Wann?"
                  value={dueAt ? formatDueLabel(dueAt) : null}
                  guessed={dueGuessed}
                  open={openChip === 'wann'}
                  panelId={WANN_PANEL_ID}
                  onOpen={() => toggleChip('wann')}
                  onDiscard={() => setDueOverride('')}
                />
                <Chip
                  field="Priorität"
                  emptyLabel="Priorität?"
                  value={priorityLabel}
                  open={openChip === 'prio'}
                  panelId={PRIO_PANEL_ID}
                  onOpen={() => toggleChip('prio')}
                />
              </>
            )}
            {displayedKind === 'event' && (
              <>
                <Chip
                  field="Zeit"
                  emptyLabel="Wann?"
                  value={eventStart ? formatDueLabel(eventStart) : null}
                  guessed={eventStartGuessed}
                  open={openChip === 'zeit'}
                  panelId={ZEIT_PANEL_ID}
                  onOpen={() => toggleChip('zeit')}
                  onDiscard={() => setEventStartOverride(defaultEventStart(now))}
                />
                <Chip
                  field="Kategorie"
                  emptyLabel="Kategorie?"
                  value={categoryLabel}
                  open={openChip === 'kategorie'}
                  panelId={KATEGORIE_PANEL_ID}
                  onOpen={() => toggleChip('kategorie')}
                />
              </>
            )}
            {displayedKind === 'habit_check' && (
              <Chip
                field="Routine"
                emptyLabel={ROUTINE_UNRESOLVED_LABEL}
                value={habitName}
                guessed={habitGuessed}
                disabled={captureHabits.length === 0}
                open={openChip === 'routine'}
                panelId={ROUTINE_PANEL_ID}
                onOpen={() => toggleChip('routine')}
                onDiscard={() => setHabitOverride('')}
              />
            )}
          </div>
          {openChip === 'art' && (
            <fieldset className="quick-add__priority" aria-label="Art" id={ART_PANEL_ID}>
              {allowedKinds.map((kind) => {
                // Kante (AK5): keine wählbare Gewohnheit -> "Routine" führt in
                // eine Sackgasse, deshalb hier gesperrt statt anwählbar.
                const disabled = kind === 'habit_check' && captureHabits.length === 0;
                return (
                  <label key={kind} className="quick-add__priority-option">
                    <input
                      type="radio"
                      name="uebersicht-capture-art"
                      checked={displayedKind === kind}
                      disabled={disabled}
                      onPointerDown={(event) => event.preventDefault()}
                      onChange={() => setKindOverridden(kind)}
                    />
                    {ART_LABELS[kind]}
                  </label>
                );
              })}
            </fieldset>
          )}
          {openChip === 'wann' && (
            <input
              type="datetime-local"
              className="quick-add__due"
              id={WANN_PANEL_ID}
              value={dueAt}
              onChange={(event) => setDueOverride(event.target.value)}
              aria-label="Fälligkeit"
            />
          )}
          {openChip === 'prio' && (
            <fieldset className="quick-add__priority" aria-label="Priorität" id={PRIO_PANEL_ID}>
              {PRIORITIES.map((p) => (
                <label key={p.value} className="quick-add__priority-option">
                  <input
                    type="radio"
                    name="uebersicht-capture-priority"
                    checked={priority === p.value}
                    onPointerDown={(event) => event.preventDefault()}
                    onChange={() => setPriority(p.value)}
                  />
                  {p.label}
                </label>
              ))}
            </fieldset>
          )}
          {openChip === 'zeit' && (
            <input
              type="datetime-local"
              className="quick-add__due"
              id={ZEIT_PANEL_ID}
              value={eventStart}
              onChange={(event) => setEventStartOverride(event.target.value)}
              aria-label="Zeit"
            />
          )}
          {openChip === 'kategorie' && (
            <select
              className="quick-add__parent"
              id={KATEGORIE_PANEL_ID}
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              aria-label="Kategorie"
            >
              <option value={NO_CATEGORY}>Keine</option>
              {EVENT_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
          {openChip === 'routine' && (
            <fieldset className="quick-add__priority" aria-label="Routine" id={ROUTINE_PANEL_ID}>
              {captureHabits.map((habit) => (
                <label key={habit.id} className="quick-add__priority-option">
                  <input
                    type="radio"
                    name="uebersicht-capture-routine"
                    checked={resolvedHabitId === habit.id}
                    onPointerDown={(event) => event.preventDefault()}
                    onChange={() => setHabitOverride(habit.id)}
                  />
                  {habit.name}
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
