import { describe, expect, it } from 'vitest';
import { buildTrack, mapActivityListEntry } from './activity-mapper';
import type { GarminActivityDetailsResponse, GarminActivityListEntry } from './connect-api';

function listEntry(overrides: Partial<GarminActivityListEntry> = {}): GarminActivityListEntry {
  return {
    activityId: 123456789,
    activityName: 'Morgenlauf',
    activityType: { typeKey: 'running' },
    startTimeLocal: '2026-07-20 06:30:00',
    distance: 5123.4,
    duration: 1800.9,
    movingDuration: 1750.2,
    elapsedDuration: 1810.5,
    elevationGain: 42.6,
    elevationLoss: 38.1,
    averageHR: 152.4,
    maxHR: 178.9,
    averageSpeed: 2.93,
    calories: 412.8,
    ...overrides,
  };
}

describe('mapActivityListEntry', () => {
  it('maps every header field, rounding to integers where the column is one', () => {
    const fields = mapActivityListEntry(listEntry());

    expect(fields).toEqual({
      garminActivityId: 123456789,
      activityType: 'running',
      name: 'Morgenlauf',
      startedAt: new Date('2026-07-20T06:30:00'),
      distanceMeters: 5123,
      durationSeconds: 1750,
      elapsedSeconds: 1811,
      elevationGain: 43,
      elevationLoss: 38,
      averageHr: 152,
      maxHr: 179,
      averageSpeed: 2.93,
      calories: 413,
    });
  });

  it('falls back to duration when movingDuration/elapsedDuration are absent', () => {
    const fields = mapActivityListEntry(
      listEntry({ movingDuration: null, elapsedDuration: null, duration: 1800 }),
    );

    expect(fields.durationSeconds).toBe(1800);
    expect(fields.elapsedSeconds).toBe(1800);
  });

  it('leaves an unnamed activity as null, not an empty string', () => {
    expect(mapActivityListEntry(listEntry({ activityName: null })).name).toBeNull();
  });

  it('passes null metrics through as null', () => {
    const fields = mapActivityListEntry(
      listEntry({ averageHR: null, maxHR: null, elevationGain: null, elevationLoss: null }),
    );

    expect(fields.averageHr).toBeNull();
    expect(fields.maxHr).toBeNull();
    expect(fields.elevationGain).toBeNull();
    expect(fields.elevationLoss).toBeNull();
  });
});

function details(
  metricDescriptors: { metricsIndex: number; key: string }[],
  rows: (number | null)[][],
): GarminActivityDetailsResponse {
  return {
    metricDescriptors,
    activityDetailMetrics: rows.map((metrics) => ({ metrics })),
  };
}

describe('buildTrack', () => {
  it('assigns each column correctly regardless of metricDescriptors order', () => {
    // Deliberately not in the "natural" lat/lon/hr/speed/elevation/distance order.
    const descriptors = [
      { metricsIndex: 0, key: 'directHeartRate' },
      { metricsIndex: 1, key: 'sumDistance' },
      { metricsIndex: 2, key: 'directLongitude' },
      { metricsIndex: 3, key: 'directLatitude' },
      { metricsIndex: 4, key: 'directElevation' },
      { metricsIndex: 5, key: 'directSpeed' },
    ];
    const rows = [
      [150, 0, 7.1, 50.7, 60, 2.5],
      [155, 10, 7.11, 50.71, 61, 2.6],
    ];

    const track = buildTrack(details(descriptors, rows));

    expect(track).toEqual({
      n: 2,
      hr: [150, 155],
      distance: [0, 10],
      lon: [7.1, 7.11],
      lat: [50.7, 50.71],
      elevation: [60, 61],
      speed: [2.5, 2.6],
    });
  });

  it('a metric absent from metricDescriptors becomes null for the whole column, not zero', () => {
    // A cycling activity that never reports heart rate.
    const descriptors = [
      { metricsIndex: 0, key: 'sumDistance' },
      { metricsIndex: 1, key: 'directLatitude' },
      { metricsIndex: 2, key: 'directLongitude' },
      { metricsIndex: 3, key: 'directSpeed' },
      { metricsIndex: 4, key: 'directElevation' },
    ];
    const rows = [[0, 50.7, 7.1, 5.2, 60]];

    const track = buildTrack(details(descriptors, rows));

    expect(track?.hr).toBeNull();
    expect(track?.distance).toEqual([0]);
  });

  it('a single point missing within a present column stays null, not coerced to 0', () => {
    const descriptors = [
      { metricsIndex: 0, key: 'directHeartRate' },
      { metricsIndex: 1, key: 'sumDistance' },
    ];
    const rows = [
      [150, 0],
      [null, 10],
    ];

    const track = buildTrack(details(descriptors, rows));

    expect(track?.hr).toEqual([150, null]);
  });

  it('returns null when there are no detail metrics at all', () => {
    expect(buildTrack(details([], []))).toBeNull();
  });
});
