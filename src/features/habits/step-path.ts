export interface StepPath {
  d: string;
  endX: number;
  endY: number;
}

function fmt(value: number): string {
  return value.toFixed(2);
}

/**
 * A daily value series → an SVG step path (issue #1040): one horizontal plateau
 * per day, a vertical edge between two days. Deliberately not `buildLinePath`,
 * which this card used before, on two counts:
 *
 * - **Step, not polyline.** The series counts routines on a streak — whole
 *   numbers with no in-between state. The diagonal a polyline draws between two
 *   days is an invention; the plateau says what actually held that day.
 * - **Fixed scale, not fitted.** `max` (the number of active routines) is always
 *   the top and 0 always the bottom, so `bottom` really is the zero line and a
 *   series that never drops to zero never touches it. `buildLinePath` fits
 *   min…max instead, which glues the curve to both edges no matter what the
 *   numbers are and turns the area underneath into a claim about nothing.
 *
 * Values above `max` are clamped rather than allowed to escape the box — the
 * count can only exceed the number of active routines if a routine is archived
 * mid-series, and a spike out of the card would be a worse lie than a plateau
 * at the top.
 */
export function stepPath(
  values: number[],
  max: number,
  width: number,
  top: number,
  bottom: number,
): StepPath | null {
  if (values.length === 0 || max <= 0) return null;

  const span = bottom - top;
  const y = (value: number): number => bottom - (Math.min(Math.max(value, 0), max) / max) * span;
  const step = width / values.length;

  let d = `M0,${fmt(y(values[0]))}`;
  for (let i = 1; i < values.length; i++) {
    const x = fmt(i * step);
    d += ` L${x},${fmt(y(values[i - 1]))} L${x},${fmt(y(values[i]))}`;
  }
  const endY = y(values[values.length - 1]);
  d += ` L${fmt(width)},${fmt(endY)}`;

  return { d, endX: width, endY };
}
