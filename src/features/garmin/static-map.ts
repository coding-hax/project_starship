/**
 * One static map image per activity, fetched once and stored in Postgres
 * (ADR-0011: "Karte, einmal serverseitig"). Mapbox Static Images is the chosen
 * provider — a single `GARMIN_MAP_KEY` (Mapbox access token), no other
 * dependency. Never throws: a missing key or an unreachable map service falls
 * back to `null`, and the UI (#180) draws the plain SVG track from the
 * coordinates instead — the map service is allowed to disappear entirely.
 */

export interface TrackPoint {
  lat: number;
  lon: number;
}

/**
 * Google's encoded polyline algorithm (precision 5) — what Mapbox's `path-`
 * overlay expects. No library: this is ~15 lines, well short of the bar for a
 * new dependency (CLAUDE.md rule 3).
 */
export function encodePolyline(points: TrackPoint[]): string {
  let result = '';
  let prevLat = 0;
  let prevLon = 0;

  for (const { lat, lon } of points) {
    const latE5 = Math.round(lat * 1e5);
    const lonE5 = Math.round(lon * 1e5);
    result += encodeSignedNumber(latE5 - prevLat) + encodeSignedNumber(lonE5 - prevLon);
    prevLat = latE5;
    prevLon = lonE5;
  }

  return result;
}

function encodeSignedNumber(num: number): string {
  let sgnNum = num << 1;
  if (num < 0) sgnNum = ~sgnNum;
  return encodeNumber(sgnNum);
}

function encodeNumber(num: number): string {
  let result = '';
  while (num >= 0x20) {
    result += String.fromCharCode((0x20 | (num & 0x1f)) + 63);
    num >>= 5;
  }
  result += String.fromCharCode(num + 63);
  return result;
}

const MAP_WIDTH = 600;
const MAP_HEIGHT = 300;

function bufferToDataUrl(buffer: ArrayBuffer, contentType: string): string {
  return `data:${contentType};base64,${Buffer.from(buffer).toString('base64')}`;
}

/** `null` when `GARMIN_MAP_KEY` is unset, there are no coordinates, or Mapbox does not answer 2xx. */
export async function fetchStaticMap(points: TrackPoint[]): Promise<string | null> {
  const key = process.env.GARMIN_MAP_KEY;
  if (!key || points.length === 0) return null;

  try {
    const encoded = encodePolyline(points);
    const url =
      `https://api.mapbox.com/styles/v1/mapbox/streets-v11/static/` +
      `path-3+3b82f6-1(${encodeURIComponent(encoded)})/auto/${MAP_WIDTH}x${MAP_HEIGHT}@2x` +
      `?access_token=${key}`;

    const response = await fetch(url);
    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') ?? 'image/png';
    return bufferToDataUrl(await response.arrayBuffer(), contentType);
  } catch {
    return null;
  }
}
