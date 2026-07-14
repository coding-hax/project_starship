'use client';

import { useEffect, useState } from 'react';
import { useTasks } from './use-tasks';

/** No network round trip involved, so this only ever reflects the browser's own state. */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
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
