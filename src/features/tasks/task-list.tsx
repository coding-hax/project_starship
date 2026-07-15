'use client';

import { useState, useSyncExternalStore } from 'react';
import { Toast } from '@/ui/toast';
import { TaskEditor } from './task-editor';
import { TaskItem } from './task-item';
import { useCompleteTask } from './use-complete-task';
import { useDeleteTask } from './use-delete-task';
import { useTasks } from './use-tasks';

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

export function TaskList() {
  const tasks = useTasks();
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

  const editingTask = tasks?.find((task) => task.id === editingTaskId) ?? null;

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
        <p className="task-list__empty">Keine Aufgaben. Genieß die Ruhe.</p>
      ) : (
        <ul className="task-list" aria-label="Aufgaben">
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
