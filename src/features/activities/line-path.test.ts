import { describe, expect, it } from 'vitest';
import { buildLinePath, paceSeries } from './line-path';

describe('buildLinePath', () => {
  it('returns null for fewer than two usable points', () => {
    expect(buildLinePath([], 100, 32)).toBeNull();
    expect(buildLinePath([5], 100, 32)).toBeNull();
    expect(buildLinePath([5, null, null], 100, 32)).toBeNull();
  });

  it('reports the min and max of the usable values', () => {
    const result = buildLinePath([130, 150, 170], 100, 32);
    expect(result?.min).toBe(130);
    expect(result?.max).toBe(170);
  });

  it('breaks the path at a null instead of drawing a straight line across it', () => {
    const result = buildLinePath([130, null, 170], 100, 32);
    expect(result?.d).toMatch(/^M[\d.]+,[\d.]+ M[\d.]+,[\d.]+$/);
  });

  it('draws a flat mid-height line for a constant series instead of dividing by zero', () => {
    const result = buildLinePath([150, 150, 150], 100, 32);
    expect(result?.d).toBe('M0.00,16.00 L50.00,16.00 L100.00,16.00');
  });

  it('is null when only one usable point survives the gaps around it', () => {
    expect(buildLinePath([null, 150, null], 100, 32)).toBeNull();
  });
});

describe('paceSeries', () => {
  it('converts m/s to seconds/km', () => {
    expect(paceSeries([4])).toEqual([250]);
  });

  it('turns a stopped/near-zero reading into a gap instead of a spike toward infinity', () => {
    expect(paceSeries([4, 0.5, 0, null])).toEqual([250, null, null, null]);
  });
});
