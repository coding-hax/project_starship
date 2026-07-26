import { describe, expect, it } from 'vitest';
import { activityChanged, type ActivitySnapshot } from './activity-diff';

function snapshot(overrides: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
  return {
    garminActivityId: 1,
    activityType: 'running',
    name: 'Morgenlauf',
    startedAt: new Date('2026-07-20T06:30:00.000Z'),
    distanceMeters: 5000,
    durationSeconds: 1800,
    elapsedSeconds: 1820,
    elevationGain: 40,
    elevationLoss: 38,
    averageHr: 150,
    maxHr: 178,
    averageSpeed: 2.8,
    calories: 400,
    track: { n: 1, distance: [0], lat: [50.7], lon: [7.1], hr: [150], speed: [2.8], elevation: [60] },
    mapImage: 'data:image/png;base64,abc',
    ...overrides,
  };
}

describe('activityChanged', () => {
  it('is false when nothing at all changed', () => {
    expect(activityChanged(snapshot(), snapshot())).toBe(false);
  });

  it('is true when a header field changed (Garmin name edit)', () => {
    expect(activityChanged(snapshot(), snapshot({ name: 'Neuer Name' }))).toBe(true);
  });

  it('is true when startedAt changed, comparing by value not by Date identity', () => {
    const same = snapshot({ startedAt: new Date('2026-07-20T06:30:00.000Z') });
    expect(activityChanged(snapshot(), same)).toBe(false);

    const different = snapshot({ startedAt: new Date('2026-07-20T06:35:00.000Z') });
    expect(activityChanged(snapshot(), different)).toBe(true);
  });

  it('is true when track goes from null to filled — a later run finishing a partial fetch', () => {
    expect(activityChanged(snapshot({ track: null }), snapshot())).toBe(true);
  });

  it('is true when the track content itself changed', () => {
    const changedTrack = snapshot({
      track: { n: 1, distance: [0], lat: [50.8], lon: [7.1], hr: [150], speed: [2.8], elevation: [60] },
    });
    expect(activityChanged(snapshot(), changedTrack)).toBe(true);
  });

  it('is true when the map image goes from null to filled', () => {
    expect(activityChanged(snapshot({ mapImage: null }), snapshot())).toBe(true);
  });

  it('is false when both sides are still missing track/map (a repeat failed fetch)', () => {
    const a = snapshot({ track: null, mapImage: null });
    const b = snapshot({ track: null, mapImage: null });
    expect(activityChanged(a, b)).toBe(false);
  });
});
