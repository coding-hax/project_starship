/**
 * Track coordinates → an SVG `path` `d` string, the fallback for `activity-map.tsx`
 * when there is no `mapImage` (issue #180). Equirectangular projection with a
 * `cos(latMid)` correction on longitude — without it, every loop in Bonn (lat ~50°)
 * would read visibly stretched east–west, since a degree of longitude there covers
 * noticeably less ground than a degree of latitude.
 *
 * The bounding box is fit into the viewBox with a margin, scaled uniformly (never
 * stretched per axis) so the correction above survives the fit. A straight
 * north–south leg has zero longitude range — that axis is then centred instead of
 * divided by zero.
 */
export function projectTrack(
  lat: (number | null)[],
  lon: (number | null)[],
  width: number,
  height: number,
): string | null {
  const n = Math.min(lat.length, lon.length);
  const points: { lat: number; lon: number }[] = [];
  for (let i = 0; i < n; i++) {
    const la = lat[i];
    const lo = lon[i];
    if (la == null || lo == null) continue;
    points.push({ lat: la, lon: lo });
  }
  if (points.length < 2) return null;

  const lats = points.map((p) => p.lat);
  const latMid = (Math.min(...lats) + Math.max(...lats)) / 2;
  const cosLat = Math.cos((latMid * Math.PI) / 180);

  // x grows east, y grows north here — flipped to SVG's down-positive y below.
  const projected = points.map((p) => ({ x: p.lon * cosLat, y: p.lat }));

  const xs = projected.map((p) => p.x);
  const ys = projected.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeX = maxX - minX;
  const rangeY = maxY - minY;

  const margin = Math.min(width, height) * 0.08;
  const availW = width - margin * 2;
  const availH = height - margin * 2;

  let scale: number;
  if (rangeX === 0 && rangeY === 0) scale = 1;
  else if (rangeX === 0) scale = availH / rangeY;
  else if (rangeY === 0) scale = availW / rangeX;
  else scale = Math.min(availW / rangeX, availH / rangeY);

  const scaledW = rangeX * scale;
  const scaledH = rangeY * scale;
  const offsetX = (width - scaledW) / 2;
  const offsetY = (height - scaledH) / 2;

  const toSvg = (p: { x: number; y: number }): string => {
    const sx = rangeX === 0 ? width / 2 : offsetX + (p.x - minX) * scale;
    // North is up: higher y (=north) maps to a smaller SVG y.
    const sy = rangeY === 0 ? height / 2 : offsetY + (maxY - p.y) * scale;
    return `${sx.toFixed(2)},${sy.toFixed(2)}`;
  };

  const [first, ...rest] = projected;
  return `M${toSvg(first)} ${rest.map((p) => `L${toSvg(p)}`).join(' ')}`.trimEnd();
}
