'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useCapturePrefs } from '@/features/settings/use-capture-prefs';
import { mutate } from '@/local/outbox';
import { Fab } from '@/ui/fab';
import { Sheet } from '@/ui/sheet';
import { Toast } from '@/ui/toast';
import { consumeCaptureDraft } from './capture-draft-store';
import { CaptureConfirm, type CaptureConfirmDraft } from './capture-confirm';
import { isoToLocalInput, localInputToIso } from './datetime-local';
import { parseTaskInput, type ParsedTaskInput } from './parse-task-input';
import { groupTasks, useTasks } from './use-tasks';

const LABEL = 'Aufgabe erfassen';
const UNDO_TIMEOUT_MS = 5000;

/** Same three steps as the edit sheet — one vocabulary for a task's urgency. */
const PRIORITIES: { value: number; label: string }[] = [
  { value: 0, label: 'Normal' },
  { value: 1, label: 'Hoch' },
  { value: 2, label: 'Dringend' },
];

/** Sentinel for the "no parent" option — a real id can never equal this. */
const NO_PARENT = '';

function isTypingTarget(target: EventTarget | null): boolean {
  const tag = (target as HTMLElement | null)?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

interface UndoState {
  taskId: string;
  title: string;
}

/**
 * Everything the "Mehr"-Bereich can set, as one value. Kept together so it can
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
 * issue #650: dahinter liegt ein zugeklappter "Mehr"-Bereich mit denselben Feldern
 * wie das Bearbeiten-Sheet. Wer sie braucht, klappt einmal auf, statt die Aufgabe
 * erst anzulegen und dann nachzubearbeiten; wer nicht, sieht sie nie.
 */
export function QuickAddTask() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<{ confirm: CaptureConfirmDraft; extras: TaskExtras } | null>(
    null,
  );
  const [undo, setUndo] = useState<UndoState | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [notes, setNotes] = useState('');
  const [dueAt, setDueAt] = useState('');
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
  // rather than on the way out means an expanded "Mehr"-Bereich does not visibly
  // collapse while the sheet is still animating away (sheet.css exits over 200ms).
  const openSheet = useCallback(() => {
    setShowMore(false);
    setNotes('');
    setDueAt('');
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
    parsed: ParsedTaskInput,
    explicitDueAt: string | null = null,
    extras: TaskExtras = NO_EXTRAS,
  ) {
    // Ein im "Mehr"-Bereich gesetztes Datum ist eine bewusste Eingabe und schlägt
    // das aus dem Titel geratene (issue #650 AC5) — dann gibt es auch nichts mehr
    // zu bestätigen und keinen Undo-Toast, der ein ungeprüftes Datum absichert.
    if (explicitDueAt === null && parsed.dueAt !== null) {
      if (!directCapture) {
        setDraft({ confirm: { title: parsed.title, dueAt: parsed.dueAt }, extras });
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
    // erkannten Fälligkeit vorbefüllt und Fokus im leeren Titelfeld (Sheet-eigenes
    // `initialFocusRef`).
    if (item.title.trim() === '') {
      queueMicrotask(() => {
        setShowMore(item.dueAt !== null);
        setNotes('');
        setDueAt(isoToLocalInput(item.dueAt));
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
    // Sheet bleibt offen, eine erkannte Fälligkeit wandert ins "Mehr"-Feld, Fokus
    // zurück ins Titelfeld statt eine leere Aufgabe anzulegen.
    if (parsed.title === '') {
      if (parsed.dueAt && !dueAt) {
        setDueAt(isoToLocalInput(parsed.dueAt));
        setShowMore(true);
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

    await applyParsed(parsed, explicitDueAt, extras);
  }

  async function handleConfirm(title: string, dueAt: string) {
    const extras = draft?.extras ?? NO_EXTRAS;
    setDraft(null);
    await createTask(title, dueAt, extras, false);
  }

  return (
    <>
      <Fab label={LABEL} onClick={openSheet} />
      <Sheet open={open} onClose={() => setOpen(false)} label={LABEL} initialFocusRef={inputRef}>
        <form className="quick-add" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            name="title"
            className="quick-add__input"
            placeholder="Todo Titel"
            aria-label="Titel der Aufgabe"
          />
          <button
            type="button"
            className="quick-add__more"
            aria-expanded={showMore}
            aria-controls="quick-add-more"
            onClick={() => setShowMore((current) => !current)}
          >
            Mehr
            <span className="quick-add__more-icon" aria-hidden="true" />
          </button>
          {/* Gated on `open` as well, for the same reason the edit sheet gates its
              parent select: a closed <dialog> keeps its children in the DOM, and
              the <option> titles are real text nodes that would make every
              top-level task match any page-wide text query twice. */}
          {open && showMore && (
            <div className="quick-add__fields" id="quick-add-more">
              <textarea
                className="quick-add__notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Notiz"
                aria-label="Notiz der Aufgabe"
              />
              <label className="quick-add__field">
                <span>Fälligkeit</span>
                <input
                  type="datetime-local"
                  className="quick-add__due"
                  value={dueAt}
                  onChange={(event) => setDueAt(event.target.value)}
                  aria-label="Fälligkeit"
                />
              </label>
              <label className="quick-add__field">
                <span>Unteraufgabe von</span>
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
              </label>
              <fieldset className="quick-add__priority">
                <legend>Priorität</legend>
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
            </div>
          )}
          <button type="submit" className="quick-add__submit">
            Hinzufügen
          </button>
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
