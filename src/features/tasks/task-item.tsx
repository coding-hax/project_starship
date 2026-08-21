'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { TaskView } from './use-tasks';

/** Below this, releasing is a cancelled swipe — the row just springs back. */
const SWIPE_THRESHOLD_PX = 80;
/** Movement at or below this counts as a tap rather than a drag. */
const TAP_TOLERANCE_PX = 8;
/** Holding still this long picks the row up for drag-to-nest instead of a swipe.
 *  On mouse/pen a drag that travels off the row's own height picks it up right away
 *  (issue #763, see `handlePointerMove`); this hold is the touch-only pick-up and,
 *  for every input, the way to nest onto an immediately adjacent row with barely
 *  any travel. */
const LONG_PRESS_MS = 400;

/**
 * Mirrors task-editor.tsx's PRIORITIES values. `0` (Normal) has no label at all
 * — the common case stays quiet, only the two elevated levels earn one.
 */
const PRIORITY_META: Record<number, string> = {
  1: 'Hoch',
  2: 'Dringend',
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
   * long-press lift entirely — used for the /uebersicht view, which does not nest.
   */
  onDropOnTask?: (targetId: string | null) => void;
  /** Enter/exit presence (issue #430, use-list-presence.ts). `leaving` stays true
   *  for the whole exit animation — the row is kept mounted by the caller until
   *  `onAnimationEnd` fires. */
  entering?: boolean;
  leaving?: boolean;
  onAnimationEnd?: () => void;
  /**
   * Reported on every move while this row is lifted, plus once on pick-up, with
   * the same `targetId` a drop would use right now (issue #451). The list turns
   * that into the live preview; `onDragEnd` clears it on drop *and* on cancel.
   */
  onDragOverTask?: (targetId: string | null) => void;
  onDragEnd?: () => void;
  /** Releasing now would make the dragged row a subtask of *this* one. */
  isNestTarget?: boolean;
  /** This row is the lifted one and releasing now would pull it out to top level. */
  isUnnestPreview?: boolean;
}

/**
 * Belt to `preventDefault()`'s braces (issue #451): a selection the user made
 * *before* grabbing the row would otherwise still be highlighted underneath the
 * drag, and on some browsers still be the thing the gesture picks up.
 */
function clearTextSelection() {
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) selection.removeAllRanges();
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
 * Swipe right to toggle done, swipe left to delete (with undo toast, no inline
 * confirm) (both via Pointer Events rather than Touch Events — that also makes
 * the gesture driveable with a mouse and with Playwright's synthetic pointer
 * events, with no branching for input type). Tapping the row without a
 * meaningful drag opens the editor.
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
  entering = false,
  leaving = false,
  onAnimationEnd,
  onDragOverTask,
  onDragEnd,
  isNestTarget = false,
  isUnnestPreview = false,
}: TaskItemProps) {
  const [dragX, setDragX] = useState(0);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [lifted, setLifted] = useState(false);
  const [startX, setStartX] = useState<number | null>(null);
  const [startY, setStartY] = useState<number | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const itemRef = useRef<HTMLLIElement | null>(null);
  const liftedRef = useRef(false);
  /** Last pointer position, so the pick-up timer can resolve a target without an event. */
  const pointerRef = useRef({ x: 0, y: 0 });

  const isDone = task.completedAt !== null;
  const priorityLabel = PRIORITY_META[task.priority] ?? null;
  const isOverdue = task.dueAt !== null && !isDone && new Date(task.dueAt) < new Date();
  // Precedence overdue > priority > none (issue #704, AK5) — a row is never
  // both. `undefined` (not `'none'`) so the attribute is simply absent rather
  // than a third value to style around.
  const edge = isOverdue ? 'overdue' : priorityLabel ? 'priority' : undefined;
  // A parent cannot itself be nested — that would create a second level, which
  // the data model does not support (one level only, issue #89).
  const draggable = !isParent && onDropOnTask !== undefined;
  // Grip feedback (issue #706, AK8): a flat row (issue #704) reads as a grabbed
  // object exactly while it is displaced from its resting place — the same
  // condition under which the inline transform below is applied (`lifted` or a
  // non-zero `dragX`). A plain tap leaves both false, so the row stays flat even
  // while the finger rests on it; `--dragging` alone would fire on that tap too.
  const gripped = lifted || dragX !== 0;

  /**
   * `touch-action: pan-y` (task-list.css) is what lets a finger scroll the list
   * off a card, and it is latched for the whole gesture — by the time the row is
   * lifted it can no longer be narrowed to `none` via CSS. Without this listener
   * the browser would take the vertical part of a drag-to-nest as a page scroll
   * and cancel the gesture, which is exactly the direction nesting needs
   * (issue #451). React attaches `touchmove` passively at the root, so
   * `preventDefault()` only bites from a natively registered non-passive
   * listener — hence the effect rather than an `onTouchMove` prop.
   */
  useEffect(() => {
    const el = itemRef.current;
    if (!el) return;
    function blockScrollWhileLifted(event: TouchEvent) {
      if (liftedRef.current) event.preventDefault();
    }
    el.addEventListener('touchmove', blockScrollWhileLifted, { passive: false });
    return () => el.removeEventListener('touchmove', blockScrollWhileLifted);
  }, []);

  function clearLongPressTimer() {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  function setLiftedState(next: boolean) {
    liftedRef.current = next;
    setLifted(next);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLLIElement>) {
    if (event.button !== 0) return;
    // The checkbox (and its label wrap, issue #818 — the label is what makes the
    // whole 44 × 44 touch target check off, not just the visibly smaller input)
    // is its own control — capturing the pointer here would steal the click the
    // browser is about to synthesize for it.
    if ((event.target as HTMLElement).closest('input, button, label')) return;
    // Otherwise the browser starts a native text selection alongside the gesture:
    // the word under the pointer gets selected and it is *that* selection the
    // drag then moves, not the card (issue #451). Safe here because the row is
    // not a focusable control — the two elements that are have already returned.
    event.preventDefault();
    clearTextSelection();
    setStartX(event.clientX);
    setStartY(event.clientY);
    pointerRef.current = { x: event.clientX, y: event.clientY };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);

    if (draggable) {
      clearLongPressTimer();
      longPressTimerRef.current = setTimeout(() => {
        setLiftedState(true);
        navigator.vibrate?.(10);
        onDragOverTask?.(resolveDropTarget(pointerRef.current.x, pointerRef.current.y));
      }, LONG_PRESS_MS);
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLLIElement>) {
    if (!dragging || startX === null || startY === null) return;
    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;
    pointerRef.current = { x: event.clientX, y: event.clientY };

    if (lifted) {
      setDragX(deltaX);
      setDragY(deltaY);
      onDragOverTask?.(resolveDropTarget(event.clientX, event.clientY));
      return;
    }

    // Once the pointer travels off this row's own height — up onto another row, or
    // into the free space around the list — the gesture is a reach toward a drop
    // target, i.e. a nest or an un-nest, never a (horizontal) swipe. Pick the row up
    // right away instead of waiting out the long-press, which a mouse user never sits
    // still for (issue #763): before this a desktop drag either read as a swipe or,
    // moving straight up/down with `dragX` near zero, as a tap on release — so
    // drag-to-nest was unreachable without an unnatural hold. Leaving the *height*
    // (not just any vertical move) is what keeps an un-nest drag that also drifts
    // sideways toward the free space from being mistaken for a swipe. Touch is
    // excluded on purpose: there a vertical drag must still scroll the list
    // (`touch-action: pan-y`), so touch keeps the long-press as its only pick-up.
    const rect = itemRef.current?.getBoundingClientRect();
    const leftOwnRow =
      rect !== undefined && (event.clientY < rect.top || event.clientY > rect.bottom);
    if (draggable && event.pointerType !== 'touch' && leftOwnRow) {
      clearLongPressTimer();
      setLiftedState(true);
      navigator.vibrate?.(10);
      setDragX(deltaX);
      setDragY(deltaY);
      onDragOverTask?.(resolveDropTarget(event.clientX, event.clientY));
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
  function resolveDropTarget(clientX: number, clientY: number): string | null {
    const el = itemRef.current;
    if (!el) return null;
    const previous = el.style.pointerEvents;
    el.style.pointerEvents = 'none';
    const dropEl = document.elementFromPoint(clientX, clientY);
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
    setLiftedState(false);
    setStartX(null);
    setStartY(null);
    const delta = dragX;
    setDragX(0);
    setDragY(0);

    if (wasLifted) {
      const target = resolveDropTarget(event.clientX, event.clientY);
      onDragEnd?.();
      onDropOnTask?.(target);
      return;
    }

    if (delta > SWIPE_THRESHOLD_PX) {
      onToggle();
    } else if (delta < -SWIPE_THRESHOLD_PX) {
      onDelete();
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
    setLiftedState(false);
    setStartX(null);
    setStartY(null);
    setDragX(0);
    setDragY(0);
    onDragEnd?.();
  }

  return (
    <li
      ref={itemRef}
      data-task-id={task.id}
      data-edge={edge}
      data-entering={entering}
      data-leaving={leaving}
      inert={isChild && !visible}
      className={
        (isDone ? 'task-list__item task-list__item--done' : 'task-list__item') +
        ' list-motion-item' +
        (dragging ? ' task-list__item--dragging' : '') +
        (lifted ? ' task-list__item--lifted' : '') +
        (gripped ? ' task-list__item--gripped' : '') +
        (isChild ? ' task-list__item--child' : '') +
        (isChild && !visible ? ' task-list__item--collapsed' : '') +
        (isNestTarget ? ' task-list__item--nest-target' : '') +
        (isUnnestPreview ? ' task-list__item--unnest-preview' : '')
      }
      style={
        // Swipe/lift and the exit animation never overlap: onDelete only ever
        // fires from endDrag, by which point dragging/lifted are already false,
        // so this inline transform and list-exit's animated transform are never
        // both live on the same element.
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
      onAnimationEnd={onAnimationEnd}
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
      {/* A <label>, not a <span> (issue #818): wraps the input so the whole
          44 × 44 touch target checks off, not just the visibly smaller circle —
          otherwise a tap that lands in the padding around it falls through to
          the row's own tap-to-edit gesture instead. */}
      <label className="task-list__checkbox-wrap">
        <input
          type="checkbox"
          className="task-list__checkbox"
          checked={isDone}
          onChange={onToggle}
          aria-label={`${task.title} als erledigt markieren`}
        />
      </label>
      <span
        className="task-list__title"
        title={priorityLabel ? `Priorität: ${priorityLabel}` : undefined}
      >
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
