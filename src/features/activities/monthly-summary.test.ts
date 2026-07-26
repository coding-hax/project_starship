import { describe, expect, it } from 'vitest';
import { activityTypeLabel, computeMonthlySummary } from './monthly-summary';

const NOW = new Date('2026-07-26T12:00:00.000Z');

function activity(activityType: string, startedAt: string, distanceMeters: number | null = 5000) {
  return { activityType, startedAt, distanceMeters };
}

describe('computeMonthlySummary', () => {
  it('breaks down by type, sorted by count desc then km desc', () => {
    const activities = [
      activity('running', NOW.toISOString(), 5000),
      activity('running', NOW.toISOString(), 6000),
      activity('cycling', NOW.toISOString(), 20000),
    ];
    const summary = computeMonthlySummary(activities, NOW);

    expect(summary.byType).toEqual([
      { type: 'running', count: 2, meters: 11000 },
      { type: 'cycling', count: 1, meters: 20000 },
    ]);
    expect(summary.totalCount).toBe(3);
    expect(summary.totalMeters).toBe(31000);
  });

  it('breaks a count tie by kilometers descending', () => {
    const activities = [
      activity('running', NOW.toISOString(), 3000),
      activity('cycling', NOW.toISOString(), 20000),
    ];
    const summary = computeMonthlySummary(activities, NOW);
    expect(summary.byType.map((t) => t.type)).toEqual(['cycling', 'running']);
  });

  it('excludes the last day of the previous month', () => {
    const monthStart = new Date(NOW.getFullYear(), NOW.getMonth(), 1, 0, 0, 0, 0);
    const lastDayPrevMonth = new Date(monthStart.getTime() - 1000);
    const activities = [activity('running', lastDayPrevMonth.toISOString())];
    expect(computeMonthlySummary(activities, NOW).totalCount).toBe(0);
  });

  it('includes an activity exactly at the month start', () => {
    const monthStart = new Date(NOW.getFullYear(), NOW.getMonth(), 1, 0, 0, 0, 0);
    const activities = [activity('running', monthStart.toISOString())];
    expect(computeMonthlySummary(activities, NOW).totalCount).toBe(1);
  });

  it('counts an activity without distanceMeters toward count but not meters', () => {
    const activities = [activity('running', NOW.toISOString(), null)];
    const summary = computeMonthlySummary(activities, NOW);
    expect(summary.byType).toEqual([{ type: 'running', count: 1, meters: 0 }]);
  });

  it('is empty for an empty list', () => {
    expect(computeMonthlySummary([], NOW)).toEqual({ byType: [], totalCount: 0, totalMeters: 0 });
  });
});

describe('activityTypeLabel', () => {
  it('maps known Garmin type keys to German labels', () => {
    expect(activityTypeLabel('running')).toBe('Laufen');
    expect(activityTypeLabel('cycling')).toBe('Radfahren');
  });

  it('falls back to Sonstiges for an unknown key instead of swallowing it', () => {
    expect(activityTypeLabel('paddle_boarding')).toBe('Sonstiges');
  });
});
