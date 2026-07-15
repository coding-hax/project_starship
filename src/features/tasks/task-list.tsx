'use client';

import { useSyncExternalStore } from 'react';
import { Toast } from '@/ui/toast';
import { TaskItem } from './task-item';
import { useCompleteTask } from './use-complete-task';
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
  const { toggleComplete, undo, handleUndo, dismissUndo } = useCompleteTask();

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
            <TaskItem key={task.id} task={task} onToggle={() => toggleComplete(task)} />
          ))}
        </ul>
      )}

      {undo && (
        <Toast
          message={`„${undo.title}" erledigt`}
          actionLabel="Rückgängig"
          onAction={handleUndo}
          onDismiss={dismissUndo}
        />
      )}
    </>
  );
}
