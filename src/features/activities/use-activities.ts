import { useLiveTable } from '@/local/use-live-table';
import type { Track } from '@/features/garmin/activity-mapper';

/**
 * The subset of a `garmin_activities` row the UI needs. Field names match what
 * `#186`'s sync writes into `LocalRecord.data` — this ticket reads the contract,
 * it does not renegotiate it.
 */
export interface ActivityView {
  id: string;
  garminActivityId: number;
  activityType: string;
  name: string | null;
  startedAt: string;
  distanceMeters: number | null;
  durationSeconds: number | null;
  elapsedSeconds: number | null;
  elevationGain: number | null;
  elevationLoss: number | null;
  averageHr: number | null;
  maxHr: number | null;
  averageSpeed: number | null;
  calories: number | null;
  track: Track | null;
  mapImage: string | null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function toActivityView(id: string, data: Record<string, unknown>): ActivityView {
  return {
    id,
    garminActivityId: typeof data.garminActivityId === 'number' ? data.garminActivityId : 0,
    activityType: typeof data.activityType === 'string' ? data.activityType : 'other',
    name: stringOrNull(data.name),
    startedAt: typeof data.startedAt === 'string' ? data.startedAt : new Date(0).toISOString(),
    distanceMeters: numberOrNull(data.distanceMeters),
    durationSeconds: numberOrNull(data.durationSeconds),
    elapsedSeconds: numberOrNull(data.elapsedSeconds),
    elevationGain: numberOrNull(data.elevationGain),
    elevationLoss: numberOrNull(data.elevationLoss),
    averageHr: numberOrNull(data.averageHr),
    maxHr: numberOrNull(data.maxHr),
    averageSpeed: numberOrNull(data.averageSpeed),
    calories: numberOrNull(data.calories),
    track: (data.track as Track | null | undefined) ?? null,
    mapImage: stringOrNull(data.mapImage),
  };
}

/** Neueste zuerst — der Recap und die Blockliste teilen sich diese Sortierung. */
export function byStartedAtDesc(a: ActivityView, b: ActivityView): number {
  return b.startedAt.localeCompare(a.startedAt);
}

/** Thin wrapper around the shared `useLiveTable` (issue #177), like use-habits.ts. */
export function useActivities(): ActivityView[] | undefined {
  return useLiveTable('garmin_activities', toActivityView, byStartedAtDesc);
}
