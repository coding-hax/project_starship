import type { GarminActivityDetailsResponse, GarminActivityListEntry } from './connect-api';

/**
 * Pure mapping from Garmin's wire shapes to what `garmin_activities` stores.
 * Netz- and DB-free on purpose (see CODEMAP) — this is the one place that breaks
 * when Garmin renames a field, and it should break here, with a unit test, not
 * mid-sync.
 */

export interface ActivityHeaderFields {
  garminActivityId: number;
  activityType: string;
  name: string | null;
  startedAt: Date;
  distanceMeters: number | null;
  durationSeconds: number | null;
  elapsedSeconds: number | null;
  elevationGain: number | null;
  elevationLoss: number | null;
  averageHr: number | null;
  maxHr: number | null;
  averageSpeed: number | null;
  calories: number | null;
}

function roundOrNull(value: number | null | undefined): number | null {
  return value == null ? null : Math.round(value);
}

/**
 * `startTimeLocal` arrives as `"YYYY-MM-DD HH:mm:ss"` — already local time, no
 * offset. `new Date()` does not reliably parse the space-separated form across
 * engines, so the space is normalised to the `T` ISO expects.
 */
function parseGarminLocalTime(value: string): Date {
  return new Date(value.replace(' ', 'T'));
}

/** One `/activitylist-service` entry → the header row `garmin-sync` upserts. */
export function mapActivityListEntry(entry: GarminActivityListEntry): ActivityHeaderFields {
  return {
    garminActivityId: entry.activityId,
    activityType: entry.activityType.typeKey,
    name: entry.activityName ?? null,
    startedAt: parseGarminLocalTime(entry.startTimeLocal),
    distanceMeters: roundOrNull(entry.distance),
    // Moving time, not clock time — pauses live in elapsedSeconds - durationSeconds
    // (computed in the UI, not stored). Falls back to `duration` for an activity
    // type that never reports movingDuration.
    durationSeconds: roundOrNull(entry.movingDuration ?? entry.duration),
    elapsedSeconds: roundOrNull(entry.elapsedDuration ?? entry.duration),
    elevationGain: roundOrNull(entry.elevationGain),
    elevationLoss: roundOrNull(entry.elevationLoss),
    averageHr: roundOrNull(entry.averageHR),
    maxHr: roundOrNull(entry.maxHR),
    averageSpeed: entry.averageSpeed ?? null,
    calories: roundOrNull(entry.calories),
  };
}

export interface Track {
  n: number;
  distance: (number | null)[] | null;
  lat: (number | null)[] | null;
  lon: (number | null)[] | null;
  hr: (number | null)[] | null;
  speed: (number | null)[] | null;
  elevation: (number | null)[] | null;
}

/** Our column name → Garmin's `metricDescriptors[].key`. */
const METRIC_KEYS: Record<'distance' | 'lat' | 'lon' | 'hr' | 'speed' | 'elevation', string> = {
  distance: 'sumDistance',
  lat: 'directLatitude',
  lon: 'directLongitude',
  hr: 'directHeartRate',
  speed: 'directSpeed',
  elevation: 'directElevation',
};

/**
 * `/activity-service/.../details` → the column-wise `track` stored in
 * `garmin_activities`. `metricDescriptors` gives the column *order for this
 * response* — it is not guaranteed to match the previous call, so every column is
 * looked up by key, never by a fixed index. A metric a given activity type never
 * reports (heart rate on a strength session, say) is `null` for that whole column,
 * not an array of zeros — zero would read as "recorded, zero bpm".
 */
export function buildTrack(details: GarminActivityDetailsResponse): Track | null {
  const points = details.activityDetailMetrics;
  if (!points || points.length === 0) return null;

  const indexByKey = new Map(details.metricDescriptors.map((d) => [d.key, d.metricsIndex]));

  const columns = {} as Record<keyof typeof METRIC_KEYS, (number | null)[] | null>;
  for (const [ourKey, garminKey] of Object.entries(METRIC_KEYS) as [
    keyof typeof METRIC_KEYS,
    string,
  ][]) {
    const index = indexByKey.get(garminKey);
    columns[ourKey] = index === undefined ? null : points.map((p) => p.metrics[index] ?? null);
  }

  return {
    n: points.length,
    distance: columns.distance,
    lat: columns.lat,
    lon: columns.lon,
    hr: columns.hr,
    speed: columns.speed,
    elevation: columns.elevation,
  };
}
