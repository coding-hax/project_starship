'use client';

import { useCallback, useRef, useState } from 'react';
import { mutate } from '@/local/outbox';
import type { EventView } from './use-events';

const UNDO_TIMEOUT_MS = 5000;

interface UndoState {
  eventId: string;
  title: string;
}

/**
 * Tombstone the row, then offer a window to reverse it — 1:1 mirror of
 * `use-delete-task.ts`, without the children handling (an event has none).
 * `restore` is the only op that clears `deleted_at` (src/local/outbox.ts
 * preserves an existing tombstone on upsert), so undo cannot be built from a
 * plain `upsert`. Both ops run through the outbox, so this is offline-safe
 * without any extra branching here.
 */
export function useDeleteEvent() {
  const [undo, setUndo] = useState<UndoState | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingTimeout = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const dismissUndo = useCallback(() => {
    clearPendingTimeout();
    setUndo(null);
  }, [clearPendingTimeout]);

  const deleteEvent = useCallback(
    async (event: EventView) => {
      await mutate({ table: 'events', rowId: event.id, op: 'delete' });

      clearPendingTimeout();
      setUndo({ eventId: event.id, title: event.title });
      timeoutRef.current = setTimeout(dismissUndo, UNDO_TIMEOUT_MS);
    },
    [clearPendingTimeout, dismissUndo],
  );

  const handleUndo = useCallback(async () => {
    if (!undo) return;
    const { eventId } = undo;
    dismissUndo();
    await mutate({ table: 'events', rowId: eventId, op: 'restore' });
  }, [undo, dismissUndo]);

  return { deleteEvent, undo, handleUndo, dismissUndo };
}
