'use client';

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { TaskView } from './use-tasks';

/** Below this, releasing is a cancelled swipe — the row just springs back. */
const SWIPE_THRESHOLD_PX = 80;
/** Movement at or below this counts as a tap rather than a drag. */
const TAP_TOLERANCE_PX = 8;
/** Holding still this long picks the row up for drag-to-nest instead of a swipe. */
const LONG_PRESS_MS = 400;

/**
 * Mirrors task-editor.tsx's PRIORITIES values. `0` (Normal) renders no badge at
 * all — dezent means the common case stays quiet, only the two elevated levels
 * earn a dot.
 */
const PRIORITY_META: Record<number, { label: string; className: string }> = {
  1: { label: 'Hoch', className: 'task-list__priority-dot--hoch' },
  2: { label: 'Dringend', className: 'task-list__priority-dot--dringend' },
};

export interface TaskItemProps {
  task: TaskView;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** Indented, rendered under its parent (issue #89). */
  isChild?: boolean;
  /** Whether this child is shown — false while the parent's disclosure is
   *  collapsed. Stays mounted either way so the collapse can animate; `inert`
   *  keeps it out of the tab order and the accessibility tree while hidden. */
  visible?: boolean;
  /** Has subtasks — shows the disclosure + progress, and is never draggable itself
   *  (nesting a parent would create a second level, which is not allowed). */
  isParent?: boolean;
  progress?: { done: number; total: number };
  expanded?: boolean;
  onToggleExpand?: () => void;
  /**
   * Drag-to-nest drop (issue #89). `targetId` is the task dropped onto, `null`
   * for a drop outside any row (un-nest). Omitting this prop disables the
   * long-press lift entirely — used for the /heute view, which does not nest.
   */
  onDropOnTask?: (targetId: string | null) => void;
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
export function TaskItem({
  task,
  onToggle,
  onEdit,
  onDelete,
  isChild = false,
  visible = true,
  isParent = false,
  progress,
  expanded = true,
  onToggleExpand,
  onDropOnTask,
}: TaskItemProps) {
  const [dragX, setDragX] = useState(0);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [lifted, setLifted] = useState(false);
  const [startX, setStartX] = useState<number | null>(null);
  const [startY, setStartY] = useState<number | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isDone = task.completedAt !== null;
  const priorityMeta = PRIORITY_META[task.priority];
  const isOverdue = task.dueAt !== null && !isDone && new Date(task.dueAt) < new Date();
  // A parent cannot itself be nested — that would create a second level, which
  // the data model does not support (one level only, issue #89).
  const draggable = !isParent && onDropOnTask !== undefined;

  function clearLongPressTimer() {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLLIElement>) {
    if (event.button !== 0) return;
    // The checkbox is its own control — capturing the pointer here would steal the
    // click the browser is about to synthesize for it.
    if ((event.target as HTMLElement).closest('input, button')) return;
    setStartX(event.clientX);
    setStartY(event.clientY);
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);

    if (draggable) {
      clearLongPressTimer();
      longPressTimerRef.current = setTimeout(() => {
        setLifted(true);
        navigator.vibrate?.(10);
      }, LONG_PRESS_MS);
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLLIElement>) {
    if (!dragging || startX === null || startY === null) return;
    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;

    if (lifted) {
      setDragX(deltaX);
      setDragY(deltaY);
      return;
    }

    // Any real movement before the long-press fires means this is a swipe, not a
    // pick-up — cancel the pending lift so it doesn't fire mid-swipe.
    if (Math.abs(deltaX) > TAP_TOLERANCE_PX || Math.abs(deltaY) > TAP_TOLERANCE_PX) {
      clearLongPressTimer();
    }
    setDragX(deltaX);
  }

  /** `elementFromPoint` would just hit this row itself — it is rendered right
   * under the pointer — so pointer events are switched off for the lookup. */
  function resolveDropTarget(event: ReactPointerEvent<HTMLLIElement>): string | null {
    const el = event.currentTarget;
    const previous = el.style.pointerEvents;
    el.style.pointerEvents = 'none';
    const dropEl = document.elementFromPoint(event.clientX, event.clientY);
    el.style.pointerEvents = previous;

    const targetId = dropEl?.closest<HTMLElement>('[data-task-id]')?.dataset.taskId ?? null;
    return targetId === task.id ? null : targetId;
  }

  function endDrag(event: ReactPointerEvent<HTMLLIElement>) {
    if (!dragging) return;
    clearLongPressTimer();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const wasLifted = lifted;
    setDragging(false);
    setLifted(false);
    setStartX(null);
    setStartY(null);
    const delta = dragX;
    setDragX(0);
    setDragY(0);

    if (wasLifted) {
      onDropOnTask?.(resolveDropTarget(event));
      return;
    }

    if (delta > SWIPE_THRESHOLD_PX) {
      onToggle();
    } else if (delta < -SWIPE_THRESHOLD_PX) {
      setConfirmingDelete(true);
    } else if (Math.abs(delta) <= TAP_TOLERANCE_PX) {
      onEdit();
    }
  }

  /** A cancelled gesture (e.g. the browser takes over for a scroll) does
   * nothing — never a swipe action, never a drop. */
  function cancelDrag(event: ReactPointerEvent<HTMLLIElement>) {
    if (!dragging) return;
    clearLongPressTimer();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
    setLifted(false);
    setStartX(null);
    setStartY(null);
    setDragX(0);
    setDragY(0);
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
      data-task-id={task.id}
      inert={isChild && !visible}
      className={
        (isDone ? 'task-list__item task-list__item--done' : 'task-list__item') +
        (dragging ? ' task-list__item--dragging' : '') +
        (lifted ? ' task-list__item--lifted' : '') +
        (isChild ? ' task-list__item--child' : '') +
        (isChild && !visible ? ' task-list__item--collapsed' : '')
      }
      style={
        lifted
          ? { transform: `translate(${dragX}px, ${dragY}px) scale(1.03)` }
          : dragX
            ? { transform: `translateX(${dragX}px)` }
            : undefined
      }
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={cancelDrag}
    >
      {isParent && (
        <button
          type="button"
          className="task-list__disclosure"
          aria-expanded={expanded}
          aria-label={expanded ? 'Unteraufgaben einklappen' : 'Unteraufgaben ausklappen'}
          onClick={onToggleExpand}
        >
          <span className="task-list__disclosure-icon" aria-hidden="true" />
        </button>
      )}
      <span className="task-list__checkbox-wrap">
        <input
          type="checkbox"
          className="task-list__checkbox"
          checked={isDone}
          onChange={onToggle}
          aria-label={`${task.title} als erledigt markieren`}
        />
      </span>
      <span className="task-list__title">
        {priorityMeta && (
          <span
            className={`task-list__priority-dot ${priorityMeta.className}`}
            role="img"
            aria-label={`Priorität: ${priorityMeta.label}`}
          />
        )}
        {task.title}
      </span>
      {progress && (
        <span className="task-list__progress">
          {progress.done}/{progress.total}
        </span>
      )}
      {task.dueAt && (
        <span
          className={
            isOverdue ? 'task-list__due task-list__due--overdue' : 'task-list__due'
          }
        >
          {formatDueAt(task.dueAt)}
        </span>
      )}
    </li>
  );
}
