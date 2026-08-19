'use client';

import { useCallback } from 'react';
import { mutate } from '@/local/outbox';
import type { EventView } from './use-events';

export function useDeleteEvent() {
  const deleteEvent = useCallback(async (event: EventView) => {
    await mutate({ table: 'events', rowId: event.id, op: 'delete' });
  }, []);

  return { deleteEvent };
}
