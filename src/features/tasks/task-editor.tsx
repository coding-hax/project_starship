'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { mutate } from '@/local/outbox';
import { Sheet } from '@/ui/sheet';
import { isoToLocalInput, localInputToIso } from './datetime-local';
import type { TaskView } from './use-tasks';

const EDIT_LABEL = 'Aufgabe bearbeiten';
// Bewusst nicht "Aufgabe erfassen" (das Kern-Sheet auf /uebersicht heißt schon
// so, issue #715 AK4 "Mehr" mountet dieses Sheet daneben) — zwei gleichnamige
// `<dialog>` würden Rollen-Abfragen mehrdeutig machen, auch während das eine
// schon (ohne `open`-Attribut) schließt: `dialog.sheet`s Exit-Transition
// (`allow-discrete`, sheet.css) hält es noch einen Frame im Accessibility-Baum.
const CREATE_LABEL = 'Neue Aufgabe';
const FORM_ID = 'task-editor-form';

const PRIORITIES: { value: number; label: string }[] = [
  { value: 0, label: 'Normal' },
  { value: 1, label: 'Hoch' },
  { value: 2, label: 'Dringend' },
];

/** Sentinel for the "no parent" option — a real id can never equal this. */
const NO_PARENT = '';

/** Seed for a frisch geöffnetes Create-Sheet (issue #715 AK4 "Mehr"): die
 * bereits im Kern-Sheet gesammelten Werte wandern hier hinein, Notiz und
 * Unteraufgabe starten leer — genau die zwei Felder, die "Mehr" überhaupt
 * erst zeigt. */
export interface TaskEditorPrefill {
  title: string;
  dueAt: string | null;
  priority: number;
}

export type TaskEditorState =
  | { mode: 'edit'; task: TaskView }
  | { mode: 'create'; prefill?: TaskEditorPrefill }
  | null;

export interface TaskEditorProps {
  /** `null` closes the sheet. */
  state: TaskEditorState;
  onClose: () => void;
  /**
   * Top-level tasks `task` could become a subtask of (issue #89) — excludes
   * `task` itself. Deterministic second path to nesting, alongside drag-to-nest.
   */
  nestCandidates: TaskView[];
  /** `task` itself has subtasks — nesting it would create a second level, which
   * is not allowed, so the nest field is hidden entirely for a parent. Irrelevant
   * in `create`-mode (a brand new task never has children). */
  hasChildren: boolean;
}

/**
 * Edits an existing task, or (issue #715 AK4) creates a new one — same bottom
 * sheet shell as quick-add (docs/DESIGN_SYSTEM.md), same fields either way. In
 * `edit` mode only the fields that actually changed go into the mutation
 * (issue #8 AC2) — two devices touching different fields of the same row must
 * not clobber each other (ADR-0001 §3); `create` just upserts a fresh row.
 */
export function TaskEditor({ state, onClose, nestCandidates, hasChildren }: TaskEditorProps) {
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [priority, setPriority] = useState(0);
  const [parentId, setParentId] = useState(NO_PARENT);
  const titleRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);

  const open = state !== null;
  const mode = state?.mode ?? 'edit';
  const task = state?.mode === 'edit' ? state.task : null;
  const prefill = state?.mode === 'create' ? state.prefill : undefined;
  const label = mode === 'edit' ? EDIT_LABEL : CREATE_LABEL;
  const actionLabel = mode === 'edit' ? 'Speichern' : 'Anlegen';

  // Load the task's current values exactly once, on the closed->open transition —
  // not on every re-render, or an unrelated list update (e.g. another task
  // completing) would overwrite whatever the user is mid-typing here.
  useEffect(() => {
    if (open && !wasOpenRef.current && mode === 'edit' && task) {
      setTitle(task.title);
      setNotes(task.notes ?? '');
      setDueAt(isoToLocalInput(task.dueAt));
      setPriority(task.priority);
      setParentId(task.parentId ?? NO_PARENT);
    }
    if (open && !wasOpenRef.current && mode === 'create') {
      setTitle(prefill?.title ?? '');
      setNotes('');
      setDueAt(isoToLocalInput(prefill?.dueAt ?? null));
      setPriority(prefill?.priority ?? 0);
      setParentId(NO_PARENT);
    }
    wasOpenRef.current = open;
  }, [open, mode, task, prefill]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      titleRef.current?.focus();
      return;
    }

    const nextNotes = notes.trim() || null;
    const nextDueAt = localInputToIso(dueAt);

    if (mode === 'create') {
      const payload: Record<string, unknown> = {
        title: trimmedTitle,
        createdAt: new Date().toISOString(),
      };
      if (nextDueAt) payload.dueAt = nextDueAt;
      if (nextNotes) payload.notes = nextNotes;
      if (priority !== 0) payload.priority = priority;
      if (parentId) payload.parentId = parentId;
      onClose();
      await mutate({ table: 'tasks', op: 'upsert', payload });
      return;
    }

    if (!task) return;
    const nextParentId = hasChildren ? task.parentId : parentId || null;

    const payload: Record<string, unknown> = {};
    if (trimmedTitle !== task.title) payload.title = trimmedTitle;
    if (nextNotes !== task.notes) payload.notes = nextNotes;
    if (nextDueAt !== task.dueAt) payload.dueAt = nextDueAt;
    if (priority !== task.priority) payload.priority = priority;
    if (nextParentId !== task.parentId) payload.parentId = nextParentId;

    onClose();
    if (Object.keys(payload).length > 0) {
      await mutate({ table: 'tasks', rowId: task.id, op: 'upsert', payload });
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={label}
      initialFocusRef={titleRef}
      header={mode === 'create' ? { actionLabel, formId: FORM_ID } : undefined}
    >
      <form id={FORM_ID} className="task-editor" onSubmit={handleSubmit}>
        <input
          ref={titleRef}
          type="text"
          className="task-editor__title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          aria-label="Titel"
        />
        <textarea
          className="task-editor__notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Notiz"
          aria-label="Notiz"
        />
        <label className="task-editor__field">
          <span>Fälligkeit</span>
          <input
            type="datetime-local"
            className="task-editor__due"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
            aria-label="Fälligkeit"
          />
        </label>
        {/* Gated on `open`, unlike the fields above: its <option> text nodes are
            real DOM text (unlike an <input>'s value), so leaving this mounted
            while the sheet is closed would make every top-level task title
            match twice — once in the list, once here — and break any bare
            page-wide text query. */}
        {open && !hasChildren && (
          <label className="task-editor__field">
            <span>Unteraufgabe von</span>
            <select
              className="task-editor__parent"
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
        )}
        <fieldset className="task-editor__priority">
          <legend>Priorität</legend>
          {PRIORITIES.map((p) => (
            <label key={p.value} className="task-editor__priority-option">
              <input
                type="radio"
                name="priority"
                checked={priority === p.value}
                // A tap's default action focuses the radio, stealing focus from the
                // title field mid-typing (#138) — same effect as SegmentedControl's
                // explicit focus() call, just via the browser's native default this
                // time. Suppressing it leaves focus where it was; `onChange` still
                // fires via the click that follows.
                onPointerDown={(event) => event.preventDefault()}
                onChange={() => setPriority(p.value)}
              />
              {p.label}
            </label>
          ))}
        </fieldset>
        {mode === 'edit' && (
          <button type="submit" className="task-editor__submit">
            Speichern
          </button>
        )}
      </form>
    </Sheet>
  );
}
