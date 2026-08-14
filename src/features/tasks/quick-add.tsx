'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { confidenceFromReason, titleConfidence } from '@/features/capture/field-confidence';
import type { FieldConfidence } from '@/features/capture/types';
import { useCapturePrefs } from '@/features/settings/use-capture-prefs';
import { mutate } from '@/local/outbox';
import { Chip } from '@/ui/chip';
import { Fab } from '@/ui/fab';
import { Sheet } from '@/ui/sheet';
import { Toast } from '@/ui/toast';
import { consumeCaptureDraft } from './capture-draft-store';
import { CaptureConfirm, type CaptureConfirmDraft } from './capture-confirm';
import { formatDueLabel, isoToLocalInput, localInputToIso } from './datetime-local';
import { DuePicker } from './due-picker';
import { parseTaskInput } from './parse-task-input';
import { groupTasks, useTasks } from './use-tasks';

/** Gemeinsame Form für `applyParsed` — sowohl ein frischer `parseTaskInput`-Aufruf
 * (mit Grundtext-Strings, #691) als auch ein `TaskCaptureDraftItem` aus dem Draft-Store
 * (schon als `FieldConfidence`) bringen diese Felder mit. */
interface AppliedTaskInput {
  title: string;
  dueAt: string | null;
  needsConfirmation: boolean;
  titleConfidence: FieldConfidence;
  dateConfidence: FieldConfidence;
  timeConfidence: FieldConfidence;
}

const LABEL = 'Aufgabe erfassen';
const FORM_ID = 'quick-add-form';
const UNDO_TIMEOUT_MS = 5000;

/** Same three steps as the edit sheet — one vocabulary for a task's urgency. */
const PRIORITIES: { value: number; label: string }[] = [
  { value: 0, label: 'Normal' },
  { value: 1, label: 'Hoch' },
  { value: 2, label: 'Dringend' },
];

/** Sentinel for the "no parent" option — a real id can never equal this. */
const NO_PARENT = '';

/** Which chip's panel is open — at most one at a time (issue #711 AK3). */
type ChipKey = 'wann' | 'prio' | 'notiz' | 'parent';

function isTypingTarget(target: EventTarget | null): boolean {
  const tag = (target as HTMLElement | null)?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

interface UndoState {
  taskId: string;
  title: string;
}

/**
 * Everything the chip row can set, as one value. Kept together so it can
 * ride along to the confirm sheet inside the draft it belongs to, instead of
 * sitting in a second piece of state that could drift away from it.
 */
interface TaskExtras {
  notes: string | null;
  priority: number;
  parentId: string | null;
}

const NO_EXTRAS: TaskExtras = { notes: null, priority: 0, parentId: null };

/**
 * FAB + bottom sheet. The fast path (VISION.md: under 5 seconds, no navigation)
 * is still one field and Enter — the task lands in IndexedDB directly, the outbox
 * picks it up whenever the network does.
 *
 * issue #47: der Titel wird durch `parseTaskInput` geschickt. Erkennt der Text ein
 * Datum, öffnet sich ein Bestätigungs-Sheet mit dem aufgelösten Termin — außer die
 * Einstellung "ohne Bestätigung direkt anlegen" ist an, dann legt der Direkt-Pfad
 * sofort an und zeigt stattdessen einen Undo-Toast als Sicherheitsnetz (AC4).
 *
 * issue #650/#711: dahinter liegt eine Chip-Zeile (Wann · Priorität · Notiz · Teil
 * von) mit denselben Feldern wie das Bearbeiten-Sheet. Wer eins braucht, tippt
 * seinen Chip an, statt die Aufgabe erst anzulegen und dann nachzubearbeiten; wer
 * keins braucht, sieht nie mehr als die Chip-Zeile.
 */
export function QuickAddTask() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<{ confirm: CaptureConfirmDraft; extras: TaskExtras } | null>(
    null,
  );
  const [undo, setUndo] = useState<UndoState | null>(null);
  const [openChip, setOpenChip] = useState<ChipKey | null>(null);
  const [notes, setNotes] = useState('');
  const [dueAt, setDueAt] = useState('');
  // Set by the two silent-prefill paths below (empty title, a date the parser
  // recognised on its own) — a guessed Fälligkeit is accepted unless the "x" on
  // its chip discards it (issue #711 AK2); editing the field in its panel clears
  // the flag, since that is no longer an unreviewed guess.
  const [dueGuessed, setDueGuessed] = useState(false);
  const [priority, setPriority] = useState(0);
  const [parentId, setParentId] = useState(NO_PARENT);
  const inputRef = useRef<HTMLInputElement>(null);
  const undoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { directCapture } = useCapturePrefs();
  const allTasks = useTasks();

  // Only top-level tasks can take a child — one level of nesting, same rule as the
  // edit sheet (issue #89). Nothing to exclude here: the task does not exist yet.
  const nestCandidates = useMemo(
    () => groupTasks(allTasks ?? []).map((node) => node.task),
    [allTasks],
  );

  // A create sheet, not an editor: every open starts blank. Clearing on the way in
  // rather than on the way out means an open chip panel does not visibly collapse
  // while the sheet is still animating away (sheet.css exits over 200ms).
  const openSheet = useCallback(() => {
    setOpenChip(null);
    setNotes('');
    setDueAt('');
    setDueGuessed(false);
    setPriority(0);
    setParentId(NO_PARENT);
    setOpen(true);
  }, []);

  // Desktop shortcut (DESIGN_SYSTEM.md: `n` = neu). Ignored while typing elsewhere,
  // so it cannot hijack a keystroke in some other field.
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== 'n' || isTypingTarget(event.target)) return;
      event.preventDefault();
      openSheet();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openSheet]);

  function dismissUndo() {
    if (undoTimeoutRef.current !== null) {
      clearTimeout(undoTimeoutRef.current);
      undoTimeoutRef.current = null;
    }
    setUndo(null);
  }

  async function createTask(
    title: string,
    dueAt: string | null,
    extras: TaskExtras,
    showUndo: boolean,
  ) {
    // Anchors the chronological running list (issue #88) — set once, here, and
    // never touched again by an edit.
    const payload: Record<string, unknown> = { title, createdAt: new Date().toISOString() };
    if (dueAt) payload.dueAt = dueAt;
    // Only fields the user actually touched go in — an untouched field must not
    // write a default over whatever the sync engine would otherwise leave alone.
    if (extras.notes) payload.notes = extras.notes;
    if (extras.priority !== 0) payload.priority = extras.priority;
    if (extras.parentId) payload.parentId = extras.parentId;
    const taskId = await mutate({ table: 'tasks', op: 'upsert', payload });

    if (showUndo) {
      dismissUndo();
      setUndo({ taskId, title });
      undoTimeoutRef.current = setTimeout(dismissUndo, UNDO_TIMEOUT_MS);
    }
  }

  async function handleUndo() {
    if (!undo) return;
    const { taskId } = undo;
    dismissUndo();
    // Rückgängig macht die Anlage per Tombstone, nicht per Hard-Delete (CLAUDE.md
    // rule 8 / ADR-0001 §3) — funktioniert damit auch offline.
    await mutate({ table: 'tasks', rowId: taskId, op: 'delete' });
  }

  // issue #618: derselbe Entscheidungsweg für Eingaben aus diesem Sheet und für
  // Drafts, die von der Übersicht her über den Draft-Store ankommen — ein einziger
  // Entscheidungsort statt zweier Kopien der Sheet-vs-Direkt-Logik.
  async function applyParsed(
    parsed: AppliedTaskInput,
    explicitDueAt: string | null = null,
    extras: TaskExtras = NO_EXTRAS,
  ) {
    // Eine über den Wann-Chip gesetzte Fälligkeit ist eine bewusste Eingabe und
    // schlägt die aus dem Titel geratene (issue #650 AC5) — dann gibt es auch
    // nichts mehr zu bestätigen und keinen Undo-Toast, der ein ungeprüftes Datum
    // absichert.
    if (explicitDueAt === null && parsed.dueAt !== null) {
      // #688 R2 Regel 5 + AK4: eine geratene Nachtzeit oder eine regionale Kurzform
      // schlägt die Direkt-Erfassung — das ist die einzige Stelle im Erfassungspfad,
      // an der eine geratene Uhrzeit sonst ungeprüft in die Datenbank liefe.
      if (!directCapture || parsed.needsConfirmation) {
        setDraft({
          confirm: {
            title: parsed.title,
            dueAt: parsed.dueAt,
            titleConfidence: parsed.titleConfidence,
            dateConfidence: parsed.dateConfidence,
            timeConfidence: parsed.timeConfidence,
          },
          extras,
        });
        return;
      }
      // Ein Undo-Toast ersetzt bewusst das übersprungene Bestätigungs-Sheet (AC4).
      await createTask(parsed.title, parsed.dueAt, extras, true);
      return;
    }

    await createTask(parsed.title, explicitDueAt ?? parsed.dueAt, extras, false);
  }

  // Konsumiert einen Draft, der über die Erfassung auf /uebersicht angelegt wurde
  // (issue #618) — genau einmal pro Mount, der Store leert sich selbst beim Lesen.
  // `queueMicrotask` schiebt `applyParsed` (und sein mögliches `setDraft`) hinter
  // einen echten Tick, statt synchron im Effekt-Body selbst Zustand zu setzen.
  // Der Store trägt seit #619 auch `event`-Items (Ziel `/kalender`) — die landen
  // nie hier, aber der Discriminant muss trotzdem geprüft werden.
  useEffect(() => {
    const batch = consumeCaptureDraft();
    const item = batch?.items[0];
    if (item?.kind !== 'task') return;
    // AK5 (#687): bleibt nach dem Erkennen kein Titel übrig, legt der Direkt-Pfad nicht
    // mehr still eine Aufgabe ohne Titel an — das Sheet öffnet stattdessen mit der
    // erkannten Fälligkeit vorbefüllt (Wann-Chip zeigt sie als geraten, #711 AK2) und
    // Fokus im leeren Titelfeld (Sheet-eigenes `initialFocusRef`).
    if (item.title.trim() === '') {
      queueMicrotask(() => {
        setOpenChip(null);
        setNotes('');
        setDueAt(isoToLocalInput(item.dueAt));
        setDueGuessed(item.dueAt !== null);
        setPriority(0);
        setParentId(NO_PARENT);
        setOpen(true);
      });
      return;
    }
    queueMicrotask(() => void applyParsed(item));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const raw = inputRef.current?.value.trim();

    if (!raw) {
      inputRef.current?.focus();
      return;
    }

    const parsed = parseTaskInput(raw, new Date());

    // AK5 (#687): bleibt kein Titel übrig, legt der Direkt-Pfad nichts mehr an — das
    // Sheet bleibt offen, eine erkannte Fälligkeit wandert auf den Wann-Chip als
    // geraten (#711 AK2), Fokus zurück ins Titelfeld statt eine leere Aufgabe
    // anzulegen.
    if (parsed.title === '') {
      if (parsed.dueAt && !dueAt) {
        setDueAt(isoToLocalInput(parsed.dueAt));
        setDueGuessed(true);
      }
      inputRef.current?.focus();
      return;
    }

    // Read the fields before closing — the create runs async, and the next open
    // blanks them.
    const explicitDueAt = localInputToIso(dueAt);
    const extras: TaskExtras = {
      notes: notes.trim() || null,
      priority,
      parentId: parentId || null,
    };

    if (inputRef.current) inputRef.current.value = '';
    setOpen(false);

    await applyParsed(
      {
        title: parsed.title,
        dueAt: parsed.dueAt,
        needsConfirmation: parsed.needsConfirmation,
        titleConfidence: titleConfidence(parsed.title),
        dateConfidence: confidenceFromReason(parsed.dateGuessReason),
        timeConfidence: confidenceFromReason(parsed.timeGuessReason),
      },
      explicitDueAt,
      extras,
    );
  }

  async function handleConfirm(title: string, dueAt: string) {
    const extras = draft?.extras ?? NO_EXTRAS;
    setDraft(null);
    await createTask(title, dueAt, extras, false);
  }

  function toggleChip(key: ChipKey) {
    setOpenChip((current) => (current === key ? null : key));
  }

  const priorityLabel = priority !== 0 ? PRIORITIES.find((p) => p.value === priority)!.label : null;
  const parentLabel = parentId
    ? (nestCandidates.find((candidate) => candidate.id === parentId)?.title ?? null)
    : null;

  return (
    <>
      <Fab label={LABEL} onClick={openSheet} />
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
          <div className="quick-add__chips">
            <Chip
              field="Fälligkeit"
              emptyLabel="Wann?"
              value={dueAt ? formatDueLabel(dueAt) : null}
              guessed={dueGuessed}
              open={openChip === 'wann'}
              panelId="quick-add-panel-wann"
              onOpen={() => toggleChip('wann')}
              onDiscard={() => {
                setDueAt('');
                setDueGuessed(false);
              }}
            />
            <Chip
              field="Priorität"
              emptyLabel="Priorität?"
              value={priorityLabel}
              open={openChip === 'prio'}
              panelId="quick-add-panel-prio"
              onOpen={() => toggleChip('prio')}
            />
            <Chip
              field="Notiz"
              emptyLabel="Notiz?"
              value={notes.trim() || null}
              open={openChip === 'notiz'}
              panelId="quick-add-panel-notiz"
              onOpen={() => toggleChip('notiz')}
            />
            <Chip
              field="Teil von"
              emptyLabel="Teil von?"
              value={parentLabel}
              disabled={nestCandidates.length === 0}
              open={openChip === 'parent'}
              panelId="quick-add-panel-parent"
              onOpen={() => toggleChip('parent')}
            />
          </div>
          {/* Reserves the tallest panel's height from the sheet's first paint on,
              so opening any one of them never changes this box's own size — and
              with it never moves the header/title above (issue #711 AK5, same
              principle as the reserved-height fix in weather-forecast.css).
              Gated on `open` for the same reason the edit sheet gates its parent
              select: a closed <dialog> keeps its children in the DOM, and the
              <option> titles are real text nodes that would make every top-level
              task match any page-wide text query twice. */}
          {open && (
            <div className="quick-add__panel-slot" id={`quick-add-panel-${openChip ?? 'none'}`}>
              {openChip === 'wann' && (
                <DuePicker
                  value={dueAt}
                  onChange={(next) => {
                    setDueAt(next);
                    setDueGuessed(false);
                  }}
                />
              )}
              {openChip === 'prio' && (
                <fieldset className="quick-add__priority" aria-label="Priorität">
                  {PRIORITIES.map((p) => (
                    <label key={p.value} className="quick-add__priority-option">
                      <input
                        type="radio"
                        name="quick-add-priority"
                        checked={priority === p.value}
                        // A tap's default action focuses the radio, stealing focus from
                        // the title field mid-typing (#138). Suppressing it leaves focus
                        // where it was; `onChange` still fires via the click that follows.
                        onPointerDown={(event) => event.preventDefault()}
                        onChange={() => setPriority(p.value)}
                      />
                      {p.label}
                    </label>
                  ))}
                </fieldset>
              )}
              {openChip === 'notiz' && (
                <textarea
                  className="quick-add__notes"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Notiz"
                  aria-label="Notiz der Aufgabe"
                />
              )}
              {openChip === 'parent' && (
                <select
                  className="quick-add__parent"
                  value={parentId}
                  onChange={(event) => setParentId(event.target.value)}
                  aria-label="Unteraufgabe von"
                >
                  <option value={NO_PARENT}>Keine (Top-Level)</option>
                  {nestCandidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.title}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </form>
      </Sheet>
      <CaptureConfirm
        draft={draft?.confirm ?? null}
        onConfirm={handleConfirm}
        onClose={() => setDraft(null)}
      />
      {undo && (
        <Toast
          message={`„${undo.title}" angelegt`}
          actionLabel="Rückgängig"
          onAction={handleUndo}
          onDismiss={dismissUndo}
        />
      )}
    </>
  );
}
