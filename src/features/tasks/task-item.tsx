'use client';

import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { TaskView } from './use-tasks';

/** Below this, releasing is a cancelled swipe — the row just springs back. */
const SWIPE_THRESHOLD_PX = 80;
/** Movement at or below this counts as a tap rather than a drag. */
const TAP_TOLERANCE_PX = 8;

export interface TaskItemProps {
  task: TaskView;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function formatDueAt(dueAt: string): string {
  const date = new Date(dueAt);
  const day = date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  const time = date.toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${day} ${time}`;
}

/**
 * Swipe right to toggle done, swipe left to reveal a delete confirmation (both via
 * Pointer Events rather than Touch Events — that also makes the gesture driveable
 * with a mouse and with Playwright's synthetic pointer events, with no branching
 * for input type). Tapping the row without a meaningful drag opens the editor.
 *
 * Moving (docs/DESIGN_SYSTEM.md: "verschieben/löschen") is a separate, later ticket —
 * a left swipe here only ever leads to delete.
 */
export function TaskItem({ task, onToggle, onEdit, onDelete }: TaskItemProps) {
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [startX, setStartX] = useState<number | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const isDone = task.completedAt !== null;

  function handlePointerDown(event: ReactPointerEvent<HTMLLIElement>) {
    if (event.button !== 0) return;
    // The checkbox is its own control — capturing the pointer here would steal the
    // click the browser is about to synthesize for it.
    if ((event.target as HTMLElement).closest('input')) return;
    setStartX(event.clientX);
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLLIElement>) {
    if (!dragging || startX === null) return;
    setDragX(event.clientX - startX);
  }

  function endDrag(event: ReactPointerEvent<HTMLLIElement>) {
    if (!dragging) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
    setStartX(null);
    const delta = dragX;
    setDragX(0);

    if (delta > SWIPE_THRESHOLD_PX) {
      onToggle();
    } else if (delta < -SWIPE_THRESHOLD_PX) {
      setConfirmingDelete(true);
    } else if (Math.abs(delta) <= TAP_TOLERANCE_PX) {
      onEdit();
    }
  }

  if (confirmingDelete) {
    return (
      <li
        className="task-list__item task-list__item--confirm-delete"
        onClick={() => setConfirmingDelete(false)}
      >
        <span className="task-list__confirm-text">{`„${task.title}" löschen?`}</span>
        <button
          type="button"
          className="task-list__confirm-delete"
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
        >
          Löschen
        </button>
      </li>
    );
  }

  return (
    <li
      className={
        (isDone ? 'task-list__item task-list__item--done' : 'task-list__item') +
        (dragging ? ' task-list__item--dragging' : '')
      }
      style={dragX ? { transform: `translateX(${dragX}px)` } : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <span className="task-list__checkbox-wrap">
        <input
          type="checkbox"
          className="task-list__checkbox"
          checked={isDone}
          onChange={onToggle}
          aria-label={`${task.title} als erledigt markieren`}
        />
      </span>
      <span className="task-list__title">{task.title}</span>
      {task.dueAt && <span className="task-list__due">{formatDueAt(task.dueAt)}</span>}
    </li>
  );
}
