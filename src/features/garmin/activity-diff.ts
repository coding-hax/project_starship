import type { ActivityHeaderFields, Track } from './activity-mapper';

/** The subset of a `garmin_activities` row this module compares against a freshly mapped candidate. */
export interface ActivitySnapshot extends ActivityHeaderFields {
  track: Track | null;
  mapImage: string | null;
}

const HEADER_FIELDS: (keyof ActivityHeaderFields)[] = [
  'activityType',
  'name',
  'startedAt',
  'distanceMeters',
  'durationSeconds',
  'elapsedSeconds',
  'elevationGain',
  'elevationLoss',
  'averageHr',
  'maxHr',
  'averageSpeed',
  'calories',
];

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return new Date(a as Date).getTime() === new Date(b as Date).getTime();
  }
  return a === b;
}

/**
 * Whether writing `candidate` over `existing` would actually change anything — the
 * gate behind "sync_seq bumps only on a real change" (issue #186, AC4). Without
 * it, every cron run would bump every activity in the window and every device
 * would re-download an unchanged row, map image included, on every pull.
 *
 * Pure and DB-free on purpose: the WHERE-clause version of this check
 * (`ON CONFLICT ... DO UPDATE ... WHERE IS DISTINCT FROM`) cannot be exercised
 * without a real Postgres, so the decision lives here instead, where a Vitest can
 * actually prove it.
 */
export function activityChanged(existing: ActivitySnapshot, candidate: ActivitySnapshot): boolean {
  for (const field of HEADER_FIELDS) {
    if (!sameValue(existing[field], candidate[field])) return true;
  }
  if (JSON.stringify(existing.track) !== JSON.stringify(candidate.track)) return true;
  if (existing.mapImage !== candidate.mapImage) return true;
  return false;
}
