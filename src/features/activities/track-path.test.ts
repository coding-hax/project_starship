import { describe, expect, it } from 'vitest';
import { projectTrack } from './track-path';

describe('projectTrack', () => {
  it('returns null for fewer than two usable points', () => {
    expect(projectTrack([], [], 100, 100)).toBeNull();
    expect(projectTrack([50.7], [7.1], 100, 100)).toBeNull();
    expect(projectTrack([50.7, null], [7.1, 7.1], 100, 100)).toBeNull();
  });

  it('projects a straight north-south leg onto a single vertical x', () => {
    const d = projectTrack([50.7, 50.705, 50.71], [7.1, 7.1, 7.1], 100, 100);
    expect(d).not.toBeNull();

    const xs = d!.match(/[ML]([\d.]+),/g)!.map((token) => parseFloat(token.slice(1, -1)));
    expect(new Set(xs.map((x) => x.toFixed(2))).size).toBe(1);
    expect(xs[0]).toBeCloseTo(50, 1);
  });

  it('projects a loop back close to its own start', () => {
    const lat = [50.7, 50.705, 50.71, 50.705, 50.7];
    const lon = [7.1, 7.105, 7.1, 7.095, 7.1];
    const d = projectTrack(lat, lon, 100, 100);
    expect(d).not.toBeNull();
    expect(d!.startsWith('M')).toBe(true);

    const points = d!.match(/[ML][\d.]+,[\d.]+/g)!;
    const [firstX, firstY] = points[0].slice(1).split(',').map(Number);
    const [lastX, lastY] = points[points.length - 1].slice(1).split(',').map(Number);
    expect(Math.hypot(lastX - firstX, lastY - firstY)).toBeLessThan(2);
  });

  it('skips a point missing lat or lon rather than breaking the projection', () => {
    const d = projectTrack([50.7, null, 50.71], [7.1, 7.1, 7.1], 100, 100);
    expect(d).not.toBeNull();
    expect(d!.match(/[ML]/g)).toHaveLength(2);
  });
});
