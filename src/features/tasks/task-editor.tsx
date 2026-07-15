'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { mutate } from '@/local/outbox';
import { Sheet } from '@/ui/sheet';
import type { TaskView } from './use-tasks';

const LABEL = 'Aufgabe bearbeiten';

const PRIORITIES: { value: number; label: string }[] = [
  { value: 0, label: 'Normal' },
  { value: 1, label: 'Hoch' },
  { value: 2, label: 'Dringend' },
];

/** `datetime-local` works in the browser's local time, with no timezone suffix. */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localInputToIso(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}

export interface TaskEditorProps {
  /** `null` closes the sheet. The last non-null task stays rendered during the
   * closing transition, so the content does not flash empty while it fades out. */
  task: TaskView | null;
  onClose: () => void;
}

/**
 * Edits an existing task in the same bottom sheet shell as quick-add
 * (docs/DESIGN_SYSTEM.md). Only the fields that actually changed go into the
 * mutation (issue #8 AC2) — two devices touching different fields of the same row
 * must not clobber each other (ADR-0001 §3).
 */
export function TaskEditor({ task, onClose }: TaskEditorProps) {
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [priority, setPriority] = useState(0);
  const titleRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);

  const open = task !== null;

  // Load the task's current values exactly once, on the closed->open transition —
  // not on every re-render, or an unrelated list update (e.g. another task
  // completing) would overwrite whatever the user is mid-typing here.
  useEffect(() => {
    if (open && !wasOpenRef.current && task) {
      setTitle(task.title);
      setNotes(task.notes ?? '');
      setDueAt(isoToLocalInput(task.dueAt));
      setPriority(task.priority);
    }
    wasOpenRef.current = open;
  }, [open, task]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!task) return;

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      titleRef.current?.focus();
      return;
    }

    const nextNotes = notes.trim() || null;
    const nextDueAt = localInputToIso(dueAt);

    const payload: Record<string, unknown> = {};
    if (trimmedTitle !== task.title) payload.title = trimmedTitle;
    if (nextNotes !== task.notes) payload.notes = nextNotes;
    if (nextDueAt !== task.dueAt) payload.dueAt = nextDueAt;
    if (priority !== task.priority) payload.priority = priority;

    onClose();
    if (Object.keys(payload).length > 0) {
      await mutate({ table: 'tasks', rowId: task.id, op: 'upsert', payload });
    }
  }

  return (
    <Sheet open={open} onClose={onClose} label={LABEL} initialFocusRef={titleRef}>
      <form className="task-editor" onSubmit={handleSubmit}>
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
        <fieldset className="task-editor__priority">
          <legend>Priorität</legend>
          {PRIORITIES.map((p) => (
            <label key={p.value} className="task-editor__priority-option">
              <input
                type="radio"
                name="priority"
                checked={priority === p.value}
                onChange={() => setPriority(p.value)}
              />
              {p.label}
            </label>
          ))}
        </fieldset>
        <button type="submit" className="task-editor__submit">
          Speichern
        </button>
      </form>
    </Sheet>
  );
}
