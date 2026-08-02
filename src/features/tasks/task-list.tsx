'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { mutate } from '@/local/outbox';
import { Toast } from '@/ui/toast';
import { useListPresence } from '@/ui/use-list-presence';
import { TaskEditor } from './task-editor';
import { TaskItem } from './task-item';
import { useCompleteTask } from './use-complete-task';
import { useDeleteTask } from './use-delete-task';
import {
  belongsOnUebersicht,
  groupTasks,
  resolveNestTarget,
  useTasks,
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

function subscribeToOnlineStatus(callback: () => void): () => void {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

/**
 * `navigator.onLine` does not exist during SSR. Assuming "online" there and letting
 * `useSyncExternalStore` correct it after mount — rather than branching on
 * `typeof window` in a `useState` initializer — is what keeps the first client
 * render identical to the server's, so hydration never has to discard and redo it.
 */
function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeToOnlineStatus,
    () => navigator.onLine,
    () => true,
  );
}

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
  const online = useOnline();
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
    return nodes.flatMap((node) => [
      { id: node.task.id, kind: 'parent' as const, node },
      ...node.children.map((child) => ({ id: child.id, kind: 'child' as const, node, child })),
    ]);
  }, [dueTodayOnly, tasks, nodes]);
  const presenceRows = useListPresence(rows, (row) => row.id);

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
    anchoredRef.current = true;
    const anchorTask = tasks.find((task) => task.completedAt === null);
    const anchorEl = anchorTask
      ? listRef.current?.querySelector<HTMLElement>(`[data-task-id="${anchorTask.id}"]`)
      : null;
    anchorEl?.scrollIntoView({ block: 'start' });
  }, [tasks]);

  return (
    <>
      {!online && (
        // role="status" implies aria-live="polite" — a calm note, not an alert.
        <p role="status" className="task-list__offline">
          Offline — deine Aufgaben sind lokal gespeichert und werden synchronisiert, sobald du
          wieder online bist.
        </p>
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
                {...shared}
              />
            );
          })}
        </ul>
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
