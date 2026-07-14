'use client';

import { useSyncExternalStore } from 'react';
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

function formatDueAt(dueAt: string): string {
  return new Date(dueAt).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

export function TaskList() {
  const tasks = useTasks();
  const online = useOnline();

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
            <li
              key={task.id}
              className={
                task.completedAt ? 'task-list__item task-list__item--done' : 'task-list__item'
              }
            >
              <span className="task-list__title">{task.title}</span>
              {task.dueAt && <span className="task-list__due">{formatDueAt(task.dueAt)}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
