'use client';

import { useMemo, useRef, useState, type FormEvent } from 'react';
import { matchHabit } from '@/features/capture/habit-match';
import { hasCompletionVerb, utteranceMentions } from '@/features/capture/local-recognizer';
import {
  allowedCaptureKinds,
  defaultEventStart,
  describeDroppedFields,
  eventFieldsFromDraft,
  habitFieldsFromDraft,
  mergeDraft,
  previewDraft,
  summarizeChanges,
  taskFieldsFromDraft,
} from '@/features/capture/route-capture';
import type { CaptureContext, CaptureDraft, CaptureKind } from '@/features/capture/types';
import {
  EventEditor,
  type EventEditorPrefill,
  type EventEditorState,
} from '@/features/events/event-editor';
import { useEventExceptions } from '@/features/events/use-event-exceptions';
import { EVENT_CATEGORIES } from '@/features/events/use-events';
import { useHabitLogs } from '@/features/habits/use-habit-logs';
import { useHabits } from '@/features/habits/use-habits';
import { useToggleHabitLog } from '@/features/habits/use-toggle-habit-log';
import { JOURNAL_HABIT_ID } from '@/features/journal/journal-habit';
import { useModules } from '@/features/settings/use-modules';
import { mutate } from '@/local/outbox';
import { berlinNow } from '@/push/schedule';
import { Chip } from '@/ui/chip';
import { Fab } from '@/ui/fab';
import { Sheet } from '@/ui/sheet';
import { formatDueLabel, isoToLocalInput, localInputToIso } from './datetime-local';
import { PRIORITIES } from './quick-add';
import { TaskEditor, type TaskEditorState } from './task-editor';
import { groupTasks, useTasks } from './use-tasks';

const LABEL = 'Aufgabe erfassen';
const FORM_ID = 'uebersicht-capture-form';
const ART_PANEL_ID = 'uebersicht-capture-panel-art';
const TITEL_PANEL_ID = 'uebersicht-capture-panel-titel';
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

/** issue #780 E4: solange `preview.provisional` gilt, ist noch keine Art entschieden —
 * der Sheet-Akzent bleibt neutral statt den Aufgaben-Akzent vorwegzunehmen. */
const NEUTRAL_ACCENT = 'var(--accent-neutral)';

/** Welche Chip-Panel gerade offen ist — höchstens eine gleichzeitig. */
type ChipKey = 'art' | 'titel' | 'wann' | 'prio' | 'zeit' | 'kategorie' | 'routine';

const ROUTINE_UNRESOLVED_LABEL = 'Keiner Gewohnheit zugeordnet';

/** issue #716 AK6: das Kernpaar Priorität(task) ↔ Kategorie(event), dazu Routine
 * (habit_check) — je Art genau ein Feld ohne Gegenstück in den anderen Arten. Ein
 * Artwechsel hebt nur die Anzeige auf; der Wert bleibt im Komponentenstand stehen,
 * bis entweder die Art zurückwechselt (taucht dann markiert wieder auf) oder das
 * Sheet schließt (`closeAndReset`). */
const EXTRA_FIELD: Record<CaptureKind, { label: string; chip: ChipKey }> = {
  task: { label: 'Priorität', chip: 'prio' },
  event: { label: 'Kategorie', chip: 'kategorie' },
  habit_check: { label: 'Routine', chip: 'routine' },
};

/**
 * Öffnet das volle Modul-Sheet (AK4) — kein Feld mit Wert/Panel wie `Chip`,
 * deshalb die Chip-Optik ohne deren Disclosure-Semantik (`aria-expanded`/
 * `aria-controls` wären für einen reinen Öffnen-Knopf falsch).
 */
function MoreChip({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="chip">
      <button type="button" className="chip__body" onClick={onOpen}>
        Mehr
      </button>
    </div>
  );
}

/**
 * Erfassungsknopf auf `/uebersicht`: seit issue #920 ein schwebender `Fab`
 * unten rechts (wie auf /aufgaben, /routinen, /journal, /kalender) statt eines
 * Knopfes in der Titelzeile — hebt die #618-Entscheidung auf. Ein Freitextfeld, dessen
 * Ergebnis der Erkenner (`route-capture.ts`) laufend liest. Seit issue #716 lebt
 * der Stand nicht mehr nur in dieser einen Zeile, sondern in `accumulated` — jede
 * Übernahme (Enter, ein Chip-Öffnen oder „Anlegen") faltet die Zeile hinein und
 * leert sie (AK1); was eine Äußerung nicht nennt, bleibt dabei unangetastet
 * stehen (AK3). `preview` (die „Vorschau-Merge") faltet die gerade getippte, noch
 * nicht übernommene Zeile nur testweise dazu, damit die Chips weiter bei jedem
 * Tastendruck reagieren (issue #715 AK1), ohne die Übernahme vorwegzunehmen.
 *
 * Die Art (`CaptureDraft.kind`) wird mit der ersten Übernahme fix — danach ändert
 * sie nur noch der Art-Chip von Hand (Entscheidung C des Plans), genau wie eine
 * geratene Fälligkeit erst durch eine bewusste Eingabe „bestätigt" wird.
 *
 * AK3 (#715): Aufgabe und Termin legt „Anlegen" direkt über `mutate` an — kein
 * `router.push` mehr, das Sheet schließt und bleibt auf `/uebersicht`.
 *
 * AK5 (#715): bei Art Routine macht der Routine-Kern-Chip den bisher stillen
 * „Keiner Gewohnheit zugeordnet"-Fall sichtbar — „Anlegen" öffnet dann die
 * Auswahl statt nichts zu tun.
 */
export function UebersichtCapture() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [now, setNow] = useState<Date>(() => new Date());
  // issue #716: der Stand nach der letzten Übernahme — `null` vor der ersten.
  const [accumulated, setAccumulated] = useState<CaptureDraft | null>(null);
  const [openChip, setOpenChip] = useState<ChipKey | null>(null);
  // issue #716 AK5: welche Chips die letzte Übernahme verändert hat, rein visuell.
  const [lastChanged, setLastChanged] = useState<ReadonlySet<ChipKey>>(new Set());
  // issue #716 AK5/AK6: die role="status"-Zeile — was die letzte Übernahme geändert
  // hat, oder was ein Artwechsel hat entfallen lassen.
  const [status, setStatus] = useState<string | null>(null);
  // Aufgabe: Priorität. Termin: Kategorie. Beide leben außerhalb von `CaptureDraft`
  // (die Grammatik parst weder das eine noch das andere aus Text) — ein Artwechsel
  // lässt sie einfach stehen (EXTRA_FIELD oben), `closeAndReset` räumt sie weg.
  const [priority, setPriority] = useState(0);
  const [category, setCategory] = useState(NO_CATEGORY);
  const [unresolvedHabit, setUnresolvedHabit] = useState(false);
  // AK4 "Mehr": ein zweites Sheet, nie gleichzeitig mit dem Kern-Sheet offen —
  // "Mehr" schließt dieses hier und öffnet jenes mit den bisherigen Werten.
  const [taskEditorState, setTaskEditorState] = useState<TaskEditorState>(null);
  const [eventEditorState, setEventEditorState] = useState<EventEditorState>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { isActive } = useModules();
  const habits = useHabits();
  const logs = useHabitLogs();
  const toggleHabitLog = useToggleHabitLog(logs);
  const allTasks = useTasks();
  const eventExceptions = useEventExceptions();

  // "Unteraufgabe von" im Mehr-Sheet: dieselbe Kandidatenliste wie quick-add.tsx
  // (nur Top-Level-Aufgaben, die neue Aufgabe existiert ja noch gar nicht).
  const taskNestCandidates = useMemo(
    () => groupTasks(allTasks ?? []).map((node) => node.task),
    [allTasks],
  );

  const captureHabits = useMemo(
    () =>
      (habits ?? [])
        .filter((habit) => habit.archivedAt === null && habit.id !== JOURNAL_HABIT_ID)
        .map((habit) => ({ id: habit.id, name: habit.name })),
    [habits],
  );
  const allowedKinds = useMemo(() => allowedCaptureKinds(isActive), [isActive]);

  const ctx: CaptureContext = useMemo(
    () => ({ now, tz: 'Europe/Berlin', habits: captureHabits, allowedKinds }),
    [now, captureHabits, allowedKinds],
  );

  // Reaktiv bei jedem Tastendruck neu berechnet (issue #715 AK1): die „Vorschau-
  // Merge" (issue #716) faltet die gerade getippte, noch nicht übernommene Zeile
  // nur testweise in `accumulated`, ohne sie zu übernehmen — eine leere Zeile
  // faltet nichts hinein, `preview` ist dann `accumulated` selbst (bzw. der leere
  // Baseline-Entwurf, solange noch nie übernommen wurde).
  const liveUtterance = useMemo(() => previewDraft(title, ctx), [title, ctx]);
  const liveMentions = useMemo(() => utteranceMentions(title, ctx), [title, ctx]);
  const preview = useMemo(
    () => mergeDraft(accumulated, liveUtterance, liveMentions),
    [accumulated, liveUtterance, liveMentions],
  );
  const displayedKind = preview.kind;

  const taskFields = useMemo(() => taskFieldsFromDraft(preview), [preview]);
  const dueLocal = isoToLocalInput(taskFields.dueAt);
  const dueGuessed =
    preview.dueAt !== null &&
    (preview.confidence.date.level === 'guessed' || preview.confidence.time.level === 'guessed');

  const eventFields = useMemo(() => eventFieldsFromDraft(preview, now), [preview, now]);
  const eventStartLocal = eventFields.startsAt
    ? isoToLocalInput(eventFields.startsAt)
    : defaultEventStart(now);
  const eventStartGuessed =
    eventFields.startsAt !== null &&
    (preview.confidence.date.level === 'guessed' || preview.confidence.time.level === 'guessed');

  const habitFields = useMemo(() => habitFieldsFromDraft(preview, now), [preview, now]);
  const resolvedHabitId = habitFields.resolved ? habitFields.habitId : null;
  const habitName = resolvedHabitId
    ? (captureHabits.find((habit) => habit.id === resolvedHabitId)?.name ?? null)
    : null;

  /** issue #716 AK1/AK3: faltet die getippte Zeile in `accumulated` — Enter, jedes
   * Chip-Öffnen und „Anlegen" lösen das aus. Eine leere Zeile ist ein No-op (kein
   * Feld wird je durch Schweigen gelöscht) und liefert den bisherigen Stand
   * unverändert zurück, damit Aufrufer synchron mit dem frischesten Stand
   * weiterarbeiten können, statt auf den nächsten Render zu warten. */
  function commit(): CaptureDraft | null {
    const raw = title.trim();
    if (!raw) return accumulated;

    const utterance = previewDraft(raw, ctx);
    const mentions = utteranceMentions(raw, ctx);
    const next = mergeDraft(accumulated, utterance, mentions);

    // AK5: nur ab der zweiten Übernahme gibt es einen Vorzustand, gegen den sich
    // „geändert" überhaupt behaupten lässt.
    const changedChips = new Set<ChipKey>();
    const changedLabels: string[] = [];
    if (accumulated !== null) {
      if (mentions.titleSubstantial) {
        changedChips.add('titel');
        changedLabels.push('Titel');
      }
      if (mentions.due) {
        changedChips.add(next.kind === 'event' ? 'zeit' : 'wann');
        changedLabels.push(next.kind === 'event' ? 'Zeit' : 'Fälligkeit');
      }
      if (mentions.habit) {
        changedChips.add('routine');
        changedLabels.push('Routine');
      }
    }

    setAccumulated(next);
    setLastChanged(changedChips);
    setStatus(summarizeChanges(changedLabels));
    setTitle('');
    return next;
  }

  function toggleChip(key: ChipKey) {
    commit();
    setOpenChip((current) => (current === key ? null : key));
  }

  function extraFieldSet(kind: CaptureKind, draft: CaptureDraft): boolean {
    if (kind === 'task') return priority !== 0;
    if (kind === 'event') return category !== NO_CATEGORY;
    return draft.habitId !== null;
  }

  /** issue #716 AK6: committet zuerst die Zeile, dann wechselt nur `accumulated.kind`
   * — das Kernpaar-Feld der alten Art bleibt im Komponentenstand stehen (nur
   * unsichtbar), das der neuen Art taucht wieder auf (markiert als geändert), wenn
   * es vorher schon einmal gesetzt war. */
  function changeKind(newKind: CaptureKind) {
    const committed = commit();
    const base = committed ?? preview;
    const oldKind = base.kind;
    // issue #780: der Art-Chip trifft eine bewusste Wahl — die Art ist damit nicht
    // mehr provisorisch, unabhängig davon, ob ein Signal je gepunktet hat.
    setAccumulated({ ...base, kind: newKind, provisional: false });
    if (oldKind === newKind) return;

    const dropped = extraFieldSet(oldKind, base) ? [EXTRA_FIELD[oldKind].label] : [];
    const restored = extraFieldSet(newKind, base);
    setStatus(describeDroppedFields(dropped));
    setLastChanged(new Set(restored ? [EXTRA_FIELD[newKind].chip] : []));
  }

  // AK4: "Mehr" übernimmt die bisherigen Kern-Werte und schließt dieses Sheet
  // zugunsten des vollen Modul-Sheets — kein Seitenwechsel, ein zweites Sheet.
  function openMoreForTask() {
    const final = commit() ?? preview;
    setOpen(false);
    setOpenChip(null);
    const fields = taskFieldsFromDraft(final);
    setTaskEditorState({
      mode: 'create',
      prefill: { title: fields.title, dueAt: fields.dueAt, priority },
    });
  }

  function openMoreForEvent() {
    const final = commit() ?? preview;
    setOpen(false);
    setOpenChip(null);
    const fields = eventFieldsFromDraft(final, now);
    const startsAt = fields.startsAt ?? localInputToIso(defaultEventStart(now));
    const endsAt = startsAt
      ? new Date(new Date(startsAt).getTime() + 60 * 60 * 1000).toISOString()
      : null;
    const prefill: EventEditorPrefill = {
      title: fields.title,
      allDay: false,
      startsAt,
      endsAt,
      startDate: null,
      endDate: null,
      category: (category || null) as EventEditorPrefill['category'],
      titleConfidence: fields.titleConfidence,
      dateConfidence: fields.dateConfidence,
      timeConfidence: fields.timeConfidence,
    };
    setEventEditorState({ mode: 'create', event: null, occurrence: null, prefill });
  }

  function closeAndReset() {
    setOpen(false);
    setTitle('');
    setAccumulated(null);
    setOpenChip(null);
    setLastChanged(new Set());
    setStatus(null);
    setPriority(0);
    setCategory(NO_CATEGORY);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const raw = title.trim();

    // Journal ist nie ein Erfassungsziel (CLAUDE.md Regel 9) und die Journal-
    // Gewohnheit hakt sich nur über einen geschriebenen Eintrag ab, nie manuell
    // (habit-today.tsx sperrt ihre Checkbox genauso).
    // AK6 (#687): ein Erledigungsverb ohne (oder mit verneintem) Habit-Treffer legt
    // nichts an — weder Aufgabe noch Abhaken. Das prüft die ZEILE, unabhängig vom
    // Übernahme-Stand.
    if (hasCompletionVerb(raw) && !matchHabit(raw, captureHabits).matched) {
      setUnresolvedHabit(true);
      return;
    }
    setUnresolvedHabit(false);

    // issue #716: eine leere Zeile blockt nicht mehr grundsätzlich — nur, wenn der
    // übernommene Stand selbst nichts Anlegbares trägt (kein Titel / keine
    // aufgelöste Routine). Eine zweite "Anlegen"-Betätigung nach einer bereits
    // gefalteten Zeile (z. B. nach der Routine-Auswahl, AK5 #715) hat leere `raw`,
    // aber einen längst gefüllten `accumulated`-Stand.
    const final = commit();
    if (!final) {
      inputRef.current?.focus();
      return;
    }

    if (final.kind === 'task') {
      const trimmedTitle = final.title.trim();
      if (!trimmedTitle) {
        inputRef.current?.focus();
        return;
      }
      const fields = taskFieldsFromDraft(final);
      const payload: Record<string, unknown> = {
        title: trimmedTitle,
        createdAt: new Date().toISOString(),
      };
      if (fields.dueAt) payload.dueAt = fields.dueAt;
      if (priority !== 0) payload.priority = priority;
      closeAndReset();
      await mutate({ table: 'tasks', op: 'upsert', payload });
      return;
    }

    if (final.kind === 'event') {
      const trimmedTitle = final.title.trim();
      if (!trimmedTitle) {
        inputRef.current?.focus();
        return;
      }
      const fields = eventFieldsFromDraft(final, now);
      const startsAt = fields.startsAt ?? localInputToIso(defaultEventStart(now));
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

    // issue #758 AK3, seit #780 auch automatisch über den Erkenner (routineIntent):
    // der "Neue Routine anlegen"-Zweig — legt eine neue Gewohnheit mit den
    // Create-Defaults aus habit-editor.tsx an (kein Rhythmus aus Spracheingabe,
    // das verfeinert sich danach auf /routinen).
    if (final.newHabit) {
      const name = final.title.trim();
      if (!name) {
        inputRef.current?.focus();
        return;
      }
      closeAndReset();
      await mutate({
        table: 'habits',
        op: 'upsert',
        payload: {
          name,
          schedule: 'daily',
          target: 1,
          color: null,
          archivedAt: null,
          createdAt: new Date().toISOString(),
        },
      });
      return;
    }

    // habit_check (issue #715 AK5): kein oder mehrdeutiger Treffer öffnet sichtbar
    // die Auswahl statt still nach /routinen zu navigieren — „Anlegen" verlangt
    // erst eine bewusste Wahl.
    const finalHabitFields = habitFieldsFromDraft(final, now);
    if (!finalHabitFields.resolved || !finalHabitFields.habitId) {
      setOpenChip('routine');
      return;
    }
    const habitId = finalHabitFields.habitId;
    const logDate = finalHabitFields.logDate;
    closeAndReset();
    await toggleHabitLog(habitId, logDate);
  }

  const priorityLabel = priority !== 0 ? PRIORITIES.find((p) => p.value === priority)!.label : null;
  const categoryLabel = category
    ? (EVENT_CATEGORIES.find((c) => c.value === category)?.label ?? null)
    : null;

  return (
    <>
      <Fab
        label={LABEL}
        text="Erfassen"
        reserveLabelWidth={76}
        onClick={() => {
          setUnresolvedHabit(false);
          setTitle('');
          setAccumulated(null);
          setOpenChip(null);
          setLastChanged(new Set());
          setStatus(null);
          setPriority(0);
          setCategory(NO_CATEGORY);
          setNow(new Date());
          setOpen(true);
        }}
      />
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        label={LABEL}
        initialFocusRef={inputRef}
        header={{ actionLabel: 'Anlegen', formId: FORM_ID }}
        accent={preview.provisional ? NEUTRAL_ACCENT : ART_ACCENT[displayedKind]}
      >
        <form id={FORM_ID} className="quick-add" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            name="title"
            className="quick-add__input"
            placeholder="Aufgabe, Termin, Routine …"
            aria-label="Titel der Aufgabe"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              // AK1: Enter übernimmt (faltet + leert die Zeile), legt aber nichts
              // an — genau die iOS-„Return"-Taste nach einem Diktat.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                commit();
              }
            }}
          />
          <div className="quick-add__chips">
            <Chip
              field="Art"
              emptyLabel="Art?"
              value={preview.provisional ? null : ART_LABELS[displayedKind]}
              guessed={false}
              open={openChip === 'art'}
              panelId={ART_PANEL_ID}
              onOpen={() => toggleChip('art')}
            />
            {(displayedKind === 'task' ||
              displayedKind === 'event' ||
              (displayedKind === 'habit_check' && preview.newHabit)) && (
              <Chip
                field="Titel"
                emptyLabel="Titel?"
                value={preview.title || null}
                guessed={preview.confidence.title.level === 'guessed'}
                open={openChip === 'titel'}
                panelId={TITEL_PANEL_ID}
                onOpen={() => toggleChip('titel')}
                changed={lastChanged.has('titel')}
              />
            )}
            {displayedKind === 'task' && (
              <>
                <Chip
                  field="Fälligkeit"
                  emptyLabel="Wann?"
                  value={dueLocal ? formatDueLabel(dueLocal) : null}
                  guessed={dueGuessed}
                  open={openChip === 'wann'}
                  panelId={WANN_PANEL_ID}
                  onOpen={() => toggleChip('wann')}
                  onDiscard={() => {
                    const base = accumulated ?? preview;
                    setAccumulated({
                      ...base,
                      dueAt: null,
                      confidence: {
                        ...base.confidence,
                        date: { level: 'high' },
                        time: { level: 'high' },
                      },
                    });
                  }}
                  changed={lastChanged.has('wann')}
                />
                <Chip
                  field="Priorität"
                  emptyLabel="Priorität?"
                  value={priorityLabel}
                  open={openChip === 'prio'}
                  panelId={PRIO_PANEL_ID}
                  onOpen={() => toggleChip('prio')}
                  changed={lastChanged.has('prio')}
                />
                <MoreChip onOpen={openMoreForTask} />
              </>
            )}
            {displayedKind === 'event' && (
              <>
                <Chip
                  field="Zeit"
                  emptyLabel="Wann?"
                  value={eventStartLocal ? formatDueLabel(eventStartLocal) : null}
                  guessed={eventStartGuessed}
                  open={openChip === 'zeit'}
                  panelId={ZEIT_PANEL_ID}
                  onOpen={() => toggleChip('zeit')}
                  onDiscard={() => {
                    const base = accumulated ?? preview;
                    const defaultIso = localInputToIso(defaultEventStart(now));
                    setAccumulated({
                      ...base,
                      dueAt: defaultIso,
                      confidence: {
                        ...base.confidence,
                        date: { level: 'high' },
                        time: { level: 'high' },
                      },
                    });
                  }}
                  changed={lastChanged.has('zeit')}
                />
                <Chip
                  field="Kategorie"
                  emptyLabel="Kategorie?"
                  value={categoryLabel}
                  open={openChip === 'kategorie'}
                  panelId={KATEGORIE_PANEL_ID}
                  onOpen={() => toggleChip('kategorie')}
                  changed={lastChanged.has('kategorie')}
                />
                <MoreChip onOpen={openMoreForEvent} />
              </>
            )}
            {displayedKind === 'habit_check' && (
              <Chip
                field="Routine"
                emptyLabel={ROUTINE_UNRESOLVED_LABEL}
                value={preview.newHabit ? `Neu: „${preview.title}"` : habitName}
                open={openChip === 'routine'}
                panelId={ROUTINE_PANEL_ID}
                onOpen={() => toggleChip('routine')}
                changed={lastChanged.has('routine')}
              />
            )}
          </div>
          {openChip === 'art' && (
            <fieldset className="quick-add__priority" aria-label="Art" id={ART_PANEL_ID}>
              {allowedKinds.map((kind) => (
                <label key={kind} className="quick-add__priority-option">
                  <input
                    type="radio"
                    name="uebersicht-capture-art"
                    checked={!preview.provisional && displayedKind === kind}
                    onPointerDown={(event) => event.preventDefault()}
                    onChange={() => changeKind(kind)}
                  />
                  {ART_LABELS[kind]}
                </label>
              ))}
            </fieldset>
          )}
          {openChip === 'titel' && (
            <input
              type="text"
              className="quick-add__input"
              id={TITEL_PANEL_ID}
              value={preview.title}
              onChange={(event) => {
                const base = accumulated ?? preview;
                setAccumulated({
                  ...base,
                  title: event.target.value,
                  confidence: { ...base.confidence, title: { level: 'high' } },
                });
              }}
              aria-label="Titel"
            />
          )}
          {openChip === 'wann' && (
            <input
              type="datetime-local"
              className="quick-add__due"
              id={WANN_PANEL_ID}
              value={dueLocal}
              onChange={(event) => {
                const iso = localInputToIso(event.target.value);
                const base = accumulated ?? preview;
                setAccumulated({
                  ...base,
                  dueAt: iso,
                  confidence: { ...base.confidence, date: { level: 'high' }, time: { level: 'high' } },
                });
              }}
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
              value={eventStartLocal}
              onChange={(event) => {
                const iso = localInputToIso(event.target.value);
                const base = accumulated ?? preview;
                setAccumulated({
                  ...base,
                  dueAt: iso,
                  confidence: { ...base.confidence, date: { level: 'high' }, time: { level: 'high' } },
                });
              }}
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
                    checked={!preview.newHabit && resolvedHabitId === habit.id}
                    onPointerDown={(event) => event.preventDefault()}
                    onChange={() => {
                      const base = accumulated ?? preview;
                      setAccumulated({
                        ...base,
                        habitId: habit.id,
                        newHabit: false,
                        confidence: { ...base.confidence, habit: { level: 'high' } },
                      });
                    }}
                  />
                  {habit.name}
                </label>
              ))}
              {/* issue #758 AK2: nur bei nicht-leerem Titel — ein leerer Name lässt sich
                  nicht anlegen (dieselbe Regel wie bei Aufgabe/Termin, AK3 prüft es erneut
                  bei "Anlegen"). */}
              {preview.title.trim() && (
                <label className="quick-add__priority-option">
                  <input
                    type="radio"
                    name="uebersicht-capture-routine"
                    checked={preview.newHabit}
                    onPointerDown={(event) => event.preventDefault()}
                    onChange={() => {
                      const base = accumulated ?? preview;
                      setAccumulated({
                        ...base,
                        habitId: null,
                        newHabit: true,
                        confidence: { ...base.confidence, habit: { level: 'high' } },
                      });
                    }}
                  />
                  {`Neue Routine anlegen: „${preview.title}"`}
                </label>
              )}
            </fieldset>
          )}
          {status && (
            <p role="status" className="uebersicht-capture__notice">
              {status}
            </p>
          )}
          {unresolvedHabit && (
            <p role="status" className="uebersicht-capture__notice">
              Keiner Gewohnheit zugeordnet.
            </p>
          )}
        </form>
      </Sheet>
      <TaskEditor
        state={taskEditorState}
        onClose={() => setTaskEditorState(null)}
        nestCandidates={taskNestCandidates}
        hasChildren={false}
      />
      <EventEditor
        state={eventEditorState}
        selectedDay={berlinNow(now).dateKey}
        exceptions={eventExceptions ?? []}
        onClose={() => setEventEditorState(null)}
        onDelete={() => {}}
      />
    </>
  );
}
