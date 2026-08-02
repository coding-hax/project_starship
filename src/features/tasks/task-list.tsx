'use client';

import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { mutate } from '@/local/outbox';
import { Toast } from '@/ui/toast';
import { TaskEditor } from './task-editor';
import { TaskItem } from './task-item';
import { useCompleteTask } from './use-complete-task';
import { useDeleteTask } from './use-delete-task';
import { belongsOnUebersicht, groupTasks, resolveNestTarget, useTasks } from './use-tasks';

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
  const tasks = dueTodayOnly ? allTasks?.filter((task) => belongsOnUebersicht(task)) : allTasks;
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
  const nodes = groupTasks(allTasks ?? []);
  const editingNode = nodes.find((node) => node.task.id === editingTaskId);
  const nestCandidates = nodes
    .filter((node) => node.task.id !== editingTaskId)
    .map((node) => node.task);

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

      {tasks === undefined ? null : tasks.length === 0 ? (
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
          {dueTodayOnly
            ? tasks.map((task) => (
                <TaskItem
                  key={task.id}
                  task={task}
                  onToggle={() => toggleComplete(task)}
                  onEdit={() => setEditingTaskId(task.id)}
                  onDelete={() => deleteTask(task)}
                />
              ))
            : nodes.map((node) => (
                <Fragment key={node.task.id}>
                  <TaskItem
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
                  />
                  {node.children.map((child) => (
                    <TaskItem
                      key={child.id}
                      task={child}
                      isChild
                      visible={!collapsed.has(node.task.id)}
                      onToggle={() => toggleComplete(child)}
                      onEdit={() => setEditingTaskId(child.id)}
                      onDelete={() => deleteTask(child)}
                      onDropOnTask={(targetId) => handleNest(child.id, targetId)}
                      onDragOverTask={(targetId) =>
                        setDragPreview({ draggedId: child.id, targetId })
                      }
                      onDragEnd={() => setDragPreview(null)}
                      isNestTarget={child.id === nestTargetId}
                      isUnnestPreview={child.id === unnestingId}
                    />
                  ))}
                </Fragment>
              ))}
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
