import { describe, expect, it } from 'vitest';
import { computeRecap } from './recap';

const NOW = new Date('2026-07-26T12:00:00.000Z');

function activity(startedAt: string, distanceMeters: number | null = 5000) {
  return { startedAt, distanceMeters };
}

describe('computeRecap', () => {
  it('is 0/0 for an empty list', () => {
    expect(computeRecap([], NOW)).toEqual({ count: 0, meters: 0 });
  });

  it('includes an activity exactly at the window start, excludes one just before it', () => {
    const windowStart = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
    const justBefore = new Date(windowStart.getTime() - 1000);
    const activities = [activity(windowStart.toISOString()), activity(justBefore.toISOString())];

    expect(computeRecap(activities, NOW)).toEqual({ count: 1, meters: 5000 });
  });

  it('excludes an activity after now', () => {
    const after = new Date(NOW.getTime() + 1000);
    expect(computeRecap([activity(after.toISOString())], NOW)).toEqual({ count: 0, meters: 0 });
  });

  it('counts an activity without distanceMeters toward count but not meters', () => {
    const activities = [activity(NOW.toISOString(), null), activity(NOW.toISOString(), 2000)];
    expect(computeRecap(activities, NOW)).toEqual({ count: 2, meters: 2000 });
  });
});
