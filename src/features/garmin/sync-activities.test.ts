import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GarminActivityDetailsResponse, GarminActivityListEntry } from './connect-api';

let existingRows: unknown[] = [];

const txExecute = vi.fn().mockResolvedValue(undefined);
const insertValues = vi.fn().mockResolvedValue(undefined);
const updateWhere = vi.fn().mockResolvedValue(undefined);
const updateSet = vi.fn<(set: Record<string, unknown>) => { where: typeof updateWhere }>(
  () => ({ where: updateWhere }),
);
const tx = {
  execute: txExecute,
  insert: () => ({ values: insertValues }),
  update: () => ({ set: updateSet }),
};

vi.mock('@/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        limit: () => Promise.resolve([]), // resolveWindowDays — unused, tests always pass `days` explicitly
        where: () => Promise.resolve(existingRows),
      }),
    }),
    transaction: (fn: (tx: unknown) => Promise<void>) => fn(tx),
  },
}));

const ensureAccessTokenMock = vi.fn().mockResolvedValue('access-token');
vi.mock('./tokens', () => ({
  ensureAccessToken: () => ensureAccessTokenMock(),
}));

const fetchActivityListMock = vi.fn();
const fetchActivityDetailsMock = vi.fn();
vi.mock('./connect-api', () => ({
  fetchActivityList: (...args: unknown[]) => fetchActivityListMock(...args),
  fetchActivityDetails: (...args: unknown[]) => fetchActivityDetailsMock(...args),
}));

const fetchStaticMapMock = vi.fn();
vi.mock('./static-map', () => ({
  fetchStaticMap: (...args: unknown[]) => fetchStaticMapMock(...args),
}));

import { syncActivities } from './sync-activities';

function listEntry(overrides: Partial<GarminActivityListEntry> = {}): GarminActivityListEntry {
  return {
    activityId: 42,
    activityName: 'Morgenlauf',
    activityType: { typeKey: 'running' },
    startTimeLocal: '2026-07-20 06:30:00',
    distance: 5000,
    duration: 1800,
    movingDuration: 1750,
    elapsedDuration: 1810,
    elevationGain: 40,
    elevationLoss: 38,
    averageHR: 150,
    maxHR: 178,
    averageSpeed: 2.8,
    calories: 400,
    ...overrides,
  };
}

const details: GarminActivityDetailsResponse = {
  metricDescriptors: [
    { metricsIndex: 0, key: 'directLatitude' },
    { metricsIndex: 1, key: 'directLongitude' },
    { metricsIndex: 2, key: 'directHeartRate' },
    { metricsIndex: 3, key: 'directSpeed' },
    { metricsIndex: 4, key: 'directElevation' },
    { metricsIndex: 5, key: 'sumDistance' },
  ],
  activityDetailMetrics: [
    { metrics: [50.7, 7.1, 150, 2.8, 60, 0] },
    { metrics: [50.71, 7.11, 155, 2.9, 61, 10] },
  ],
};

const matchingExistingRow = {
  id: 'existing-uuid',
  garminActivityId: 42,
  activityType: 'running',
  name: 'Morgenlauf',
  startedAt: new Date('2026-07-20T06:30:00'),
  distanceMeters: 5000,
  durationSeconds: 1750,
  elapsedSeconds: 1810,
  elevationGain: 40,
  elevationLoss: 38,
  averageHr: 150,
  maxHr: 178, // matches listEntry()'s default maxHR
  averageSpeed: 2.8,
  calories: 400,
  track: {
    n: 2,
    lat: [50.7, 50.71],
    lon: [7.1, 7.11],
    hr: [150, 155],
    speed: [2.8, 2.9],
    elevation: [60, 61],
    distance: [0, 10],
  },
  mapImage: 'data:image/png;base64,existing',
  fetchedAt: new Date('2026-07-20T08:00:00Z'),
};

describe('syncActivities', () => {
  beforeEach(() => {
    existingRows = [];
    txExecute.mockClear();
    insertValues.mockClear();
    updateSet.mockClear();
    updateWhere.mockClear();
    ensureAccessTokenMock.mockClear().mockResolvedValue('access-token');
    fetchActivityListMock.mockReset();
    fetchActivityDetailsMock.mockReset();
    fetchStaticMapMock.mockReset().mockResolvedValue('data:image/png;base64,map');
  });

  it('creates a new activity, fetching details and the map exactly once', async () => {
    fetchActivityListMock.mockResolvedValue([listEntry()]);
    fetchActivityDetailsMock.mockResolvedValue(details);

    const result = await syncActivities({ days: 7 });

    expect(result).toEqual({ scanned: 1, created: 1, updated: 0, detailsFilled: 1, mapsFilled: 1 });
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(updateSet).not.toHaveBeenCalled();
    expect(txExecute).toHaveBeenCalledTimes(1); // the advisory lock

    const written = insertValues.mock.calls[0][0];
    expect(written.garminActivityId).toBe(42);
    expect(written.track).not.toBeNull();
    expect(written.mapImage).toBe('data:image/png;base64,map');
  });

  it('does not touch the DB for an unchanged activity — sync_seq never bumps', async () => {
    existingRows = [matchingExistingRow];
    // Same entry the fixture row was built from — mapActivityListEntry must map to
    // exactly the values already stored.
    fetchActivityListMock.mockResolvedValue([listEntry()]);

    const result = await syncActivities({ days: 7 });

    expect(result.scanned).toBe(1);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
    // Details/map are never re-fetched for an activity whose track already exists.
    expect(fetchActivityDetailsMock).not.toHaveBeenCalled();
  });

  it('updates the header and bumps sync_seq when Garmin data actually changed', async () => {
    existingRows = [matchingExistingRow];
    fetchActivityListMock.mockResolvedValue([listEntry({ activityName: 'Neuer Name' })]);

    const result = await syncActivities({ days: 7 });

    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(updateSet).toHaveBeenCalledTimes(1);
    expect(fetchActivityDetailsMock).not.toHaveBeenCalled(); // track already present — untouched
    const written = updateSet.mock.calls[0][0];
    expect(written.name).toBe('Neuer Name');
  });

  it('still writes the header when the detail fetch fails — a partial success is a success', async () => {
    fetchActivityListMock.mockResolvedValue([listEntry()]);
    fetchActivityDetailsMock.mockRejectedValue(new Error('Garmin antwortete mit 500'));

    const result = await syncActivities({ days: 7 });

    expect(result.created).toBe(1);
    expect(result.detailsFilled).toBe(0);
    expect(result.mapsFilled).toBe(0);
    expect(insertValues).toHaveBeenCalledTimes(1);
    const written = insertValues.mock.calls[0][0];
    expect(written.track).toBeNull();
    expect(written.mapImage).toBeNull();
    expect(fetchStaticMapMock).not.toHaveBeenCalled();
  });

  it('retries a previously failed detail fetch for an existing activity missing its track', async () => {
    existingRows = [{ ...matchingExistingRow, track: null, mapImage: null }];
    fetchActivityListMock.mockResolvedValue([listEntry()]);
    fetchActivityDetailsMock.mockResolvedValue(details);

    const result = await syncActivities({ days: 7 });

    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.detailsFilled).toBe(1);
    expect(result.mapsFilled).toBe(1);
    expect(updateSet).toHaveBeenCalledTimes(1);
    const written = updateSet.mock.calls[0][0];
    expect(written.track).not.toBeNull();
  });

  it('lets a GarminBootstrapRequired from ensureAccessToken propagate before touching the DB', async () => {
    ensureAccessTokenMock.mockRejectedValue(new Error('no oauth1'));

    await expect(syncActivities({ days: 7 })).rejects.toThrow('no oauth1');
    expect(fetchActivityListMock).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });
});
