'use client';

import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { TaskView } from './use-tasks';

/** Below this, releasing is a cancelled swipe — the row just springs back. */
const SWIPE_THRESHOLD_PX = 80;

export interface TaskItemProps {
  task: TaskView;
  onToggle: () => void;
}

function formatDueAt(dueAt: string): string {
  return new Date(dueAt).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

/**
 * Swipe right to toggle done (docs/DESIGN_SYSTEM.md: "Swipe-Gesten"), always via
 * Pointer Events rather than Touch Events — that also makes the gesture driveable
 * with a mouse and with Playwright's synthetic pointer events, with no branching
 * for input type.
 *
 * Left swipe (move/delete) is a separate, later ticket — this component only ever
 * reads a positive delta.
 */
export function TaskItem({ task, onToggle }: TaskItemProps) {
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [startX, setStartX] = useState<number | null>(null);

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
    setDragX(Math.max(0, event.clientX - startX));
  }

  function endDrag(event: ReactPointerEvent<HTMLLIElement>) {
    if (!dragging) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
    setStartX(null);
    if (dragX > SWIPE_THRESHOLD_PX) onToggle();
    setDragX(0);
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
