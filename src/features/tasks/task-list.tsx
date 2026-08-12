'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { mutate } from '@/local/outbox';
import { OfflineNotice } from '@/ui/offline-notice';
import { useBlockReady } from '@/ui/overview-ready';
import { Toast } from '@/ui/toast';
import { useListPresence } from '@/ui/use-list-presence';
import { useOnline } from '@/ui/use-online';
import { TaskEditor } from './task-editor';
import { TaskItem } from './task-item';
import { useCompleteTask } from './use-complete-task';
import { useDeleteTask } from './use-delete-task';
import { useHideCompletedTasks } from './use-hide-completed-tasks';
import {
  belongsOnUebersicht,
  groupTasks,
  resolveNestTarget,
  useTasks,
  visibleTaskNodes,
  type TaskNode,
  type TaskView,
} from './use-tasks';

/**
 * One `<li>` worth of row, flattened out of the parent/child tree (issue #430)
 * — `useListPresence` needs one flat, uniformly-keyed array to diff against;
 * grouped `Fragment`s per parent had no single key per row to track. `kind`
 * carries just enough of the originating node to rebuild the same props
 * `TaskItem` always got, nothing more.
 */
type TaskRow =
  | { id: string; kind: 'flat'; task: TaskView }
  | { id: string; kind: 'parent'; node: TaskNode }
  | { id: string; kind: 'child'; node: TaskNode; child: TaskView };

export interface TaskListProps {
  /**
   * Restricts the list to tasks due today or overdue, still open or checked off
   * today — the /uebersicht dashboard subset (issue #87, issue #228). Everything
   * else (editor, undo toasts, offline notice) stays the same so the two lists
   * don't drift apart.
   */
  dueTodayOnly?: boolean;
  /**
   * Id of a visible heading that already names this list (issue #157) — the list
   * is labelled by it via `aria-labelledby` instead of carrying its own
   * `aria-label`, so a screen reader doesn't announce both back to back.
   */
  headingId?: string;
}

export function TaskList({ dueTodayOnly = false, headingId }: TaskListProps = {}) {
  const allTasks = useTasks();
  // `useMemo`'d on `[allTasks, dueTodayOnly]` — `allTasks` is referentially
  // stable across renders that aren't a real live-query emission (see
  // use-live-table.ts), and `useListPresence` below needs that stability to
  // tell "the data changed" apart from "this component re-rendered for some
  // other reason" (editingTaskId, collapsed, …).
  const tasks = useMemo(
    () => (dueTodayOnly ? allTasks?.filter((task) => belongsOnUebersicht(task)) : allTasks),
    [allTasks, dueTodayOnly],
  );
  // Inert on /aufgaben, where this list is the whole screen and has nothing below
  // it to push; on /uebersicht it joins the shared reveal point (issue #642).
  useBlockReady(allTasks !== undefined);
  const online = useOnline();
  // Global device-local toggle (issue #654) — only applied below on /aufgaben
  // (`!dueTodayOnly`), never on the /uebersicht subset (AC7).
  const { hideCompleted } = useHideCompletedTasks();
  const {
    toggleComplete,
    undo: completeUndo,
    handleUndo: handleCompleteUndo,
    dismissUndo: dismissCompleteUndo,
  } = useCompleteTask();
  const {
    deleteTask,
    undo: deleteUndo,
    handleUndo: handleDeleteUndo,
    dismissUndo: dismissDeleteUndo,
  } = useDeleteTask();
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  // Ephemeral, not persisted (per-ticket decision) — default expanded, so a
  // reload never hides subtasks the user hasn't deliberately collapsed.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // What a drop would do *right now* (issue #451) — set on pick-up and on every
  // move while lifted, cleared on drop and on cancel. `targetId` is still the raw
  // row under the pointer; the one-level rule is applied below, so the preview
  // cannot drift from what `handleNest` actually does.
  const [dragPreview, setDragPreview] = useState<{
    draggedId: string;
    targetId: string | null;
  } | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const anchoredRef = useRef(false);

  const editingTask = allTasks?.find((task) => task.id === editingTaskId) ?? null;
  // Grouped from the full list, not the /uebersicht-filtered `tasks` — nesting still
  // needs the whole task graph even when the view itself renders flat (issue #89).
  const nodes = useMemo(() => groupTasks(allTasks ?? []), [allTasks]);
  const editingNode = nodes.find((node) => node.task.id === editingTaskId);
  const nestCandidates = nodes
    .filter((node) => node.task.id !== editingTaskId)
    .map((node) => node.task);

  const rows = useMemo<TaskRow[]>(() => {
    if (dueTodayOnly) {
      return (tasks ?? []).map((task) => ({ id: task.id, kind: 'flat' as const, task }));
    }
    return visibleTaskNodes(nodes, hideCompleted).flatMap((node) => [
      { id: node.task.id, kind: 'parent' as const, node },
      ...node.children.map((child) => ({ id: child.id, kind: 'child' as const, node, child })),
    ]);
  }, [dueTodayOnly, tasks, nodes, hideCompleted]);
  const presenceRows = useListPresence(rows, (row) => row.id);

  /**
   * The live drop preview (issue #451), derived through the *same*
   * `resolveNestTarget` the drop itself uses — that is what makes holding over a
   * subtask highlight its parent rather than the subtask, and what keeps a drop
   * that would change nothing (back where it started, or a top-level row over
   * empty space) from showing a promise it will not keep.
   */
  const draggedTask = dragPreview
    ? (allTasks?.find((task) => task.id === dragPreview.draggedId) ?? null)
    : null;
  const previewParentId = dragPreview
    ? resolveNestTarget(dragPreview.draggedId, dragPreview.targetId, allTasks ?? [])
    : null;
  const previewChangesSomething = draggedTask !== null && draggedTask.parentId !== previewParentId;
  const nestTargetId = previewChangesSomething ? previewParentId : null;
  const unnestingId = previewChangesSomething && previewParentId === null ? draggedTask.id : null;
  const previewParentTitle = nestTargetId
    ? (allTasks?.find((task) => task.id === nestTargetId)?.title ?? null)
    : null;
  const dropHint =
    draggedTask === null
      ? null
      : previewParentTitle !== null
        ? `„${draggedTask.title}" wird Unteraufgabe von „${previewParentTitle}"`
        : unnestingId !== null
          ? `„${draggedTask.title}" wird keiner Aufgabe zugeordnet`
          : null;

  function toggleExpanded(taskId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  }

  /**
   * Drag-to-nest drop (issue #89) — the primary path, the editor's "Unteraufgabe
   * von" field is the deterministic second one. `resolveNestTarget` encodes the
   * one-level rule (dropping on a child attaches to *its* parent); a no-op drop
   * (dropped back where it already was) skips the mutation entirely.
   */
  async function handleNest(draggedId: string, dropTargetId: string | null) {
    const dragged = allTasks?.find((task) => task.id === draggedId);
    const parentId = resolveNestTarget(draggedId, dropTargetId, allTasks ?? []);
    if (!dragged || dragged.parentId === parentId) return;
    await mutate({ table: 'tasks', rowId: draggedId, op: 'upsert', payload: { parentId } });
  }

  /**
   * Chat-style scroll anchor (issue #88): on open, land on the oldest open task
   * instead of the very top of the history. Runs once per mount, on the first
   * render that actually has tasks — re-anchoring on every list change (e.g.
   * completing a task) would fight the user's own scrolling.
   *
   * `scrollIntoView` alone gets both halves of the AC for free: the browser
   * clamps to the max scroll position, so a short list (or an anchor near the
   * bottom) never overscrolls into blank space — it just settles as far as real
   * content allows, which for a list that fits the viewport is no scroll at all.
   */
  useEffect(() => {
    if (anchoredRef.current || tasks === undefined) return;
    const anchorTask = tasks.find((task) => task.completedAt === null);
    const anchorEl = anchorTask
      ? listRef.current?.querySelector<HTMLElement>(`[data-task-id="${anchorTask.id}"]`)
      : null;
    // `useListPresence` (issue #430) seeds its `entries` state via its own effect,
    // one render behind `rows` — the real `<ul>` isn't painted yet on the render
    // where `tasks` first has content. Retry (via the `presenceRows.length`
    // dependency below) instead of marking anchored against an empty list.
    if (anchorTask && !anchorEl) return;
    anchoredRef.current = true;
    anchorEl?.scrollIntoView({ block: 'start' });
  }, [tasks, presenceRows.length]);

  return (
    <>
      {!online && (
        <OfflineNotice>
          Offline — deine Aufgaben sind lokal gespeichert und werden synchronisiert, sobald du
          wieder online bist.
        </OfflineNotice>
      )}

      {tasks === undefined ? null : presenceRows.length === 0 ? (
        <p
          className={
            dueTodayOnly ? 'task-list__empty task-list__empty--compact' : 'task-list__empty'
          }
        >
          {dueTodayOnly ? 'Nichts fällig. Genieß den Tag.' : 'Keine Aufgaben. Genieß die Ruhe.'}
        </p>
      ) : (
        <ul
          ref={listRef}
          className="task-list"
          {...(headingId
            ? { 'aria-labelledby': headingId }
            : { 'aria-label': dueTodayOnly ? 'Fällige Aufgaben' : 'Aufgaben' })}
        >
          {presenceRows.map((row) => {
            const entering = row.status === 'entering';
            const leaving = row.status === 'leaving';
            const shared = { entering, leaving, onAnimationEnd: row.onAnimationEnd };

            if (row.item.kind === 'flat') {
              const { task } = row.item;
              return (
                <TaskItem
                  key={row.key}
                  task={task}
                  onToggle={() => toggleComplete(task)}
                  onEdit={() => setEditingTaskId(task.id)}
                  onDelete={() => deleteTask(task)}
                  {...shared}
                />
              );
            }

            if (row.item.kind === 'parent') {
              const { node } = row.item;
              return (
                <TaskItem
                  key={row.key}
                  task={node.task}
                  isParent={node.total > 0}
                  progress={node.total > 0 ? { done: node.done, total: node.total } : undefined}
                  expanded={!collapsed.has(node.task.id)}
                  onToggleExpand={() => toggleExpanded(node.task.id)}
                  onToggle={() => toggleComplete(node.task)}
                  onEdit={() => setEditingTaskId(node.task.id)}
                  onDelete={() => deleteTask(node.task, node.children)}
                  onDropOnTask={(targetId) => handleNest(node.task.id, targetId)}
                  onDragOverTask={(targetId) =>
                    setDragPreview({ draggedId: node.task.id, targetId })
                  }
                  onDragEnd={() => setDragPreview(null)}
                  isNestTarget={node.task.id === nestTargetId}
                  isUnnestPreview={node.task.id === unnestingId}
                  {...shared}
                />
              );
            }

            const { node, child } = row.item;
            return (
              <TaskItem
                key={row.key}
                task={child}
                isChild
                visible={!collapsed.has(node.task.id)}
                onToggle={() => toggleComplete(child)}
                onEdit={() => setEditingTaskId(child.id)}
                onDelete={() => deleteTask(child)}
                onDropOnTask={(targetId) => handleNest(child.id, targetId)}
                onDragOverTask={(targetId) => setDragPreview({ draggedId: child.id, targetId })}
                onDragEnd={() => setDragPreview(null)}
                isNestTarget={child.id === nestTargetId}
                isUnnestPreview={child.id === unnestingId}
                {...shared}
              />
            );
          })}
        </ul>
      )}

      {/* Names the pending drop in words while a row is held (issue #451) — the
          highlighted row alone says *where*, not *what*. role="status" is polite,
          and the text only changes when the resolved target does, so it is not a
          per-pixel announcement. */}
      {dropHint && (
        <p role="status" data-testid="task-drop-hint" className="task-list__drop-hint">
          {dropHint}
        </p>
      )}

      <TaskEditor
        task={editingTask}
        onClose={() => setEditingTaskId(null)}
        nestCandidates={nestCandidates}
        hasChildren={(editingNode?.total ?? 0) > 0}
      />

      {/* Only one undo action is ever in flight — completing and deleting are
          separate gestures a user cannot trigger in the same instant. */}
      {deleteUndo ? (
        <Toast
          message={
            deleteUndo.childIds.length > 0
              ? `„${deleteUndo.title}" + ${deleteUndo.childIds.length} Unteraufgabe${deleteUndo.childIds.length === 1 ? '' : 'n'} gelöscht`
              : `„${deleteUndo.title}" gelöscht`
          }
          actionLabel="Rückgängig"
          onAction={handleDeleteUndo}
          onDismiss={dismissDeleteUndo}
        />
      ) : (
        completeUndo && (
          <Toast
            message={`„${completeUndo.title}" erledigt`}
            actionLabel="Rückgängig"
            onAction={handleCompleteUndo}
            onDismiss={dismissCompleteUndo}
          />
        )
      )}
    </>
  );
}
