export interface LinePath {
  d: string;
  min: number;
  max: number;
}

/**
 * A value series → an SVG `path` `d` string for `activity-chart.tsx` (issue #180).
 * `null` values (an ampelpause during the pace series, a dropped sensor reading)
 * break the path into a new `M` instead of drawing a straight line across the
 * gap — a lie about what happened during that stretch. A constant series (`min
 * === max`) draws a flat mid-height line instead of dividing by zero. Fewer than
 * two usable points means there is nothing to chart at all.
 */
export function buildLinePath(values: (number | null)[], width: number, height: number): LinePath | null {
  const usable = values.filter((v): v is number => v != null);
  if (usable.length < 2) return null;

  const min = Math.min(...usable);
  const max = Math.max(...usable);
  const range = max - min;

  const n = values.length;
  const stepX = n > 1 ? width / (n - 1) : 0;
  const toY = (v: number): number => (range === 0 ? height / 2 : height - ((v - min) / range) * height);

  const segments: string[] = [];
  let penDown = false;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v == null) {
      penDown = false;
      continue;
    }
    const x = (i * stepX).toFixed(2);
    const y = toY(v).toFixed(2);
    segments.push(`${penDown ? 'L' : 'M'}${x},${y}`);
    penDown = true;
  }

  return { d: segments.join(' '), min, max };
}

/**
 * `track.speed` (m/s) → seconds/km for the pace chart. A near-stopped reading
 * (≤0.5 m/s — an Ampelpause, not real pace) becomes a gap instead of a spike
 * toward infinity, exactly the case the null-breaks-the-path rule above exists for.
 */
export function paceSeries(speed: (number | null)[]): (number | null)[] {
  return speed.map((v) => (v == null || v <= 0.5 ? null : 1000 / v));
}
