import { useLiveTable } from '@/local/use-live-table';

/**
 * The subset of an `event_exceptions` row the recurrence expansion needs —
 * mirror of `use-events.ts`'s `EventView`/`toEventView`, keyed by the same
 * natural key the sync engine uses (`NATURAL_KEYS['event_exceptions']`,
 * src/local/types.ts).
 */
export interface EventExceptionView {
  id: string;
  eventId: string;
  originalDate: string;
  cancelled: boolean;
  overrideStartsAt: string | null;
  overrideEndsAt: string | null;
  overrideStartDate: string | null;
  overrideEndDate: string | null;
}

export function toEventExceptionView(
  id: string,
  data: Record<string, unknown>,
): EventExceptionView {
  return {
    id,
    eventId: typeof data.eventId === 'string' ? data.eventId : '',
    originalDate: typeof data.originalDate === 'string' ? data.originalDate : '',
    cancelled: data.cancelled === true,
    overrideStartsAt: typeof data.overrideStartsAt === 'string' ? data.overrideStartsAt : null,
    overrideEndsAt: typeof data.overrideEndsAt === 'string' ? data.overrideEndsAt : null,
    overrideStartDate: typeof data.overrideStartDate === 'string' ? data.overrideStartDate : null,
    overrideEndDate: typeof data.overrideEndDate === 'string' ? data.overrideEndDate : null,
  };
}

/** Thin wrapper around the shared `useLiveTable` (src/local/use-live-table.ts). */
export function useEventExceptions(): EventExceptionView[] | undefined {
  return useLiveTable('event_exceptions', toEventExceptionView);
}
