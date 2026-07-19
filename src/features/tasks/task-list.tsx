'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Toast } from '@/ui/toast';
import { TaskEditor } from './task-editor';
import { TaskItem } from './task-item';
import { useCompleteTask } from './use-complete-task';
import { useDeleteTask } from './use-delete-task';
import { isDueTodayOrOverdue, useTasks } from './use-tasks';

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
   * Restricts the list to open tasks due today or overdue — the /heute dashboard
   * subset (issue #87). Everything else (editor, undo toasts, offline notice)
   * stays the same so the two lists don't drift apart.
   */
  dueTodayOnly?: boolean;
}

export function TaskList({ dueTodayOnly = false }: TaskListProps = {}) {
  const allTasks = useTasks();
  const tasks = dueTodayOnly ? allTasks?.filter((task) => isDueTodayOrOverdue(task)) : allTasks;
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
  const listRef = useRef<HTMLUListElement | null>(null);
  const anchoredRef = useRef(false);

  const editingTask = allTasks?.find((task) => task.id === editingTaskId) ?? null;

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
        <p className="task-list__empty">
          {dueTodayOnly ? 'Nichts fällig. Genieß den Tag.' : 'Keine Aufgaben. Genieß die Ruhe.'}
        </p>
      ) : (
        <ul
          ref={listRef}
          className="task-list"
          aria-label={dueTodayOnly ? 'Fällige Aufgaben' : 'Aufgaben'}
        >
          {tasks.map((task) => (
            <TaskItem
              key={task.id}
              task={task}
              onToggle={() => toggleComplete(task)}
              onEdit={() => setEditingTaskId(task.id)}
              onDelete={() => deleteTask(task)}
            />
          ))}
        </ul>
      )}

      <TaskEditor task={editingTask} onClose={() => setEditingTaskId(null)} />

      {/* Only one undo action is ever in flight — completing and deleting are
          separate gestures a user cannot trigger in the same instant. */}
      {deleteUndo ? (
        <Toast
          message={`„${deleteUndo.title}" gelöscht`}
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
