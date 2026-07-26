/**
 * Formatters for the Aktivitäten page (issue #180). Every function returns the en
 * dash below for `null` instead of `0` — the most common silent bug in a screen
 * like this, since a missing HR sensor and a genuine 0 bpm reading must never look
 * the same.
 */

const DASH = '–';

export function formatDistance(meters: number | null): string {
  if (meters == null) return DASH;
  return `${(meters / 1000).toFixed(1)} km`;
}

/** `1:04:12` above an hour, `4:12` below — never a leading `0:`. */
export function formatDuration(seconds: number | null): string {
  if (seconds == null) return DASH;
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Same shape as `formatDuration` — pauses are just another duration. */
export function formatPause(seconds: number | null): string {
  return formatDuration(seconds);
}

/** `metersPerSecond` → minutes:seconds per km, e.g. `5:12 min/km`. */
export function formatPace(metersPerSecond: number | null): string {
  if (metersPerSecond == null || metersPerSecond <= 0) return DASH;
  const secPerKm = 1000 / metersPerSecond;
  let m = Math.floor(secPerKm / 60);
  let s = Math.round(secPerKm % 60);
  if (s === 60) {
    s = 0;
    m += 1;
  }
  return `${m}:${String(s).padStart(2, '0')} min/km`;
}

export function formatHr(bpm: number | null): string {
  if (bpm == null) return DASH;
  return `${Math.round(bpm)} bpm`;
}

export function formatElevation(meters: number | null): string {
  if (meters == null) return DASH;
  return `${Math.round(meters)} m`;
}
