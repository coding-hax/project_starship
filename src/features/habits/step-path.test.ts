import { describe, expect, it } from 'vitest';
import { stepPath } from './step-path';

/** The card's own geometry (habit-history-card.tsx) — the numbers the assertions
 *  below are read against, so a change to the box shows up here first. */
const WIDTH = 293;
const TOP = 8;
const BOTTOM = 76;

describe('stepPath', () => {
  it('draws a plateau per value and a vertical edge between two values', () => {
    const path = stepPath([0, 2], 2, 100, 0, 100);

    // M at the first value, then: extend the plateau to x=50, drop, extend to
    // the right edge. No diagonal anywhere — every segment is axis-parallel.
    expect(path?.d).toBe('M0,100.00 L50.00,100.00 L50.00,0.00 L100.00,0.00');
  });

  it('puts 0 on the baseline and max on the cap line, whatever the series does', () => {
    const path = stepPath([3, 0, 5], 5, WIDTH, TOP, BOTTOM);

    expect(path?.d).toContain(`,${BOTTOM.toFixed(2)}`); // die Null
    expect(path?.d).toContain(`,${TOP.toFixed(2)}`); // alle fünf
  });

  it('keeps a series without a zero off the baseline (issue #1040)', () => {
    // Der alte buildLinePath skalierte auf min…max und klebte diese Reihe an
    // beide Kanten; auf fester Skala liegt ihr Tiefpunkt bei 2 von 5.
    const path = stepPath([4, 2, 3], 5, WIDTH, TOP, BOTTOM);

    expect(path?.d).not.toContain(`,${BOTTOM.toFixed(2)}`);
    expect(path?.endY).toBeGreaterThan(TOP);
    expect(path?.endY).toBeLessThan(BOTTOM);
  });

  it('spans the full box for a single routine, without dividing by zero', () => {
    const done = stepPath([1, 1], 1, WIDTH, TOP, BOTTOM);
    const open = stepPath([0, 0], 1, WIDTH, TOP, BOTTOM);

    expect(done?.endY).toBe(TOP);
    expect(open?.endY).toBe(BOTTOM);
  });

  it('reports the end point at the right edge of the plot box', () => {
    const path = stepPath([1, 2, 3], 3, WIDTH, TOP, BOTTOM);

    expect(path?.endX).toBe(WIDTH);
    expect(path?.endY).toBe(TOP);
  });

  it('clamps a value above max instead of letting it escape the box', () => {
    // Wird eine Routine mitten in der Reihe archiviert, kann ein alter Tageswert
    // über der heutigen Anzahl liegen.
    const path = stepPath([9, 1], 2, WIDTH, TOP, BOTTOM);

    expect(path?.d.startsWith(`M0,${TOP.toFixed(2)}`)).toBe(true);
  });

  it('has nothing to draw without values or without an active routine', () => {
    expect(stepPath([], 3, WIDTH, TOP, BOTTOM)).toBeNull();
    expect(stepPath([1, 2], 0, WIDTH, TOP, BOTTOM)).toBeNull();
  });
});
