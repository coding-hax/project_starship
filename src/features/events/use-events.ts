import type { EventData } from '@/local/types';
import { useLiveTable } from '@/local/use-live-table';

/**
 * The subset of an `events` row a read-only timeline needs. Field names match
 * what the sync engine writes into `LocalRecord.data` (SYNC_REGISTRY['events'],
 * see `EventData` in src/local/types.ts).
 */
export interface EventView {
  id: string;
  title: string;
  allDay: boolean;
  startsAt: string | null;
  endsAt: string | null;
  startDate: string | null;
  endDate: string | null;
  category: EventData['category'];
}

const CATEGORIES: NonNullable<EventData['category']>[] = [
  'privat',
  'arbeit',
  'gesundheit',
  'sport',
  'familie',
];

export function toEventView(id: string, data: Record<string, unknown>): EventView {
  return {
    id,
    title: typeof data.title === 'string' ? data.title : '',
    allDay: data.allDay === true,
    startsAt: typeof data.startsAt === 'string' ? data.startsAt : null,
    endsAt: typeof data.endsAt === 'string' ? data.endsAt : null,
    startDate: typeof data.startDate === 'string' ? data.startDate : null,
    endDate: typeof data.endDate === 'string' ? data.endDate : null,
    category: CATEGORIES.includes(data.category as never)
      ? (data.category as EventView['category'])
      : null,
  };
}

/** Earliest start first — matches the reading order of a day's timeline. */
export function compareEvents(a: EventView, b: EventView): number {
  return (a.startsAt ?? '').localeCompare(b.startsAt ?? '');
}

/** Thin wrapper around the shared `useLiveTable` (src/local/use-live-table.ts). */
export function useEvents(): EventView[] | undefined {
  return useLiveTable('events', toEventView, compareEvents);
}
