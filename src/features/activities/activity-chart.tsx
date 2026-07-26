import { buildLinePath } from './line-path';

interface ActivityChartProps {
  label: string;
  values: (number | null)[];
  formatValue: (value: number) => string;
}

/**
 * One of the three per-activity curves (issue #180) — heart rate, pace, elevation
 * profile, all the same shape. `viewBox="0 0 100 32"` with
 * `preserveAspectRatio="none"` lets the container's CSS width/height dictate the
 * final size without any JS measuring. `role="img"` carries the span in its
 * `aria-label` — a screen reader gets "132 bis 171 bpm", not the raw path — the
 * same span is also shown visibly next to the heading, not just to assistive tech.
 * `null` (no data at all for this metric — a cycling activity without a HR strap)
 * means no chart and no heading, not an empty box.
 */
export function ActivityChart({ label, values, formatValue }: ActivityChartProps) {
  const result = buildLinePath(values, 100, 32);
  if (!result) return null;

  const { d, min, max } = result;
  const span = min === max ? formatValue(min) : `${formatValue(min)} bis ${formatValue(max)}`;

  return (
    <div className="activity-chart">
      <p className="activity-chart__heading">
        {label}
        <span className="activity-chart__span">{span}</span>
      </p>
      <svg
        className="activity-chart__svg"
        viewBox="0 0 100 32"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}, ${span}`}
      >
        <path d={d} fill="none" stroke="currentColor" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}
