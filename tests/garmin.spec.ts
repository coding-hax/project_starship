import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { registerPasskey, resetAppData, withDb } from './helpers';

/**
 * Garmin-Aktivitäten (ADR-0011, issue #186): read-only Server-Origin-Daten. Der
 * Cron schreibt nie über die App — er schreibt direkt in Postgres, genau wie
 * `/api/garmin-sync` es täte. `withDb()` steht hier stellvertretend für den Cron,
 * exakt wie bei den Wetter-Tests für Open-Meteo.
 */
async function insertGarminActivity(overrides: {
  garminActivityId?: number;
  name?: string;
  distanceMeters?: number;
} = {}): Promise<string> {
  const id = randomUUID();
  const garminActivityId = overrides.garminActivityId ?? Math.floor(Math.random() * 1_000_000_000);
  const track = {
    n: 2,
    lat: [50.7, 50.71],
    lon: [7.1, 7.11],
    hr: [150, 155],
    speed: [2.8, 2.9],
    elevation: [60, 61],
    distance: [0, 10],
  };

  await withDb(async (client) => {
    await client.query(
      `INSERT INTO garmin_activities
        (id, updated_at, deleted_at, synced_at, sync_seq, garmin_activity_id, activity_type, name,
         started_at, distance_meters, duration_seconds, elapsed_seconds, elevation_gain, elevation_loss,
         average_hr, max_hr, average_speed, calories, track, map_image, fetched_at)
       VALUES
        ($1, now(), NULL, now(), nextval('sync_seq'), $2, $3, $4,
         $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, now())`,
      [
        id,
        garminActivityId,
        'running',
        overrides.name ?? 'Morgenlauf',
        '2026-07-20T06:30:00Z',
        overrides.distanceMeters ?? 5000,
        1750,
        1810,
        40,
        38,
        150,
        178,
        2.8,
        400,
        JSON.stringify(track),
        null,
      ],
    );
  });

  return id;
}

async function garminRecords(page: import('@playwright/test').Page) {
  const rows = await page.evaluate(() => window.__starship.debugRecords());
  return rows.filter((r) => r.table === 'garmin_activities');
}

test.beforeEach(async () => {
  await resetAppData();
});

test('eine vom Cron geschriebene Aktivität landet über den normalen Pull im IndexedDB, mit Kopfzahlen und Track (issue #186 AC2)', async ({
  page,
}) => {
  await registerPasskey(page);
  const id = await insertGarminActivity({ distanceMeters: 5432 });

  await expect.poll(async () => {
    await page.evaluate(() => window.__starship.sync());
    return (await garminRecords(page)).some((r) => r.id === id);
  }).toBe(true);

  const record = (await garminRecords(page)).find((r) => r.id === id);
  expect(record?.data.distanceMeters).toBe(5432);
  expect(record?.data.activityType).toBe('running');
  expect((record?.data.track as { n: number }).n).toBe(2);
  expect((record?.data.track as { lat: number[] }).lat).toEqual([50.7, 50.71]);
});

test('offline angelegt, online geholt: Aktivitäten kommen ausschließlich über den normalen Pull, nie über die Outbox (issue #186 AC3)', async ({
  page,
}) => {
  await registerPasskey(page);

  await page.context().setOffline(true);
  const id = await insertGarminActivity();

  // Nothing to push while offline — a read-only table never produces a client mutation.
  expect(await page.evaluate(() => window.__starship.size())).toBe(0);

  await page.context().setOffline(false);

  await expect.poll(async () => {
    await page.evaluate(() => window.__starship.sync());
    return (await garminRecords(page)).some((r) => r.id === id);
  }).toBe(true);

  // Still nothing in the outbox once the row has arrived.
  expect(await page.evaluate(() => window.__starship.size())).toBe(0);
});

test('eine Mutation auf garmin_activities wird clientseitig abgewiesen, bevor sie die Outbox erreicht (issue #186 AC3)', async ({
  page,
}) => {
  await registerPasskey(page);

  await expect(
    page.evaluate(() =>
      window.__starship.mutate({
        table: 'garmin_activities',
        op: 'upsert',
        payload: { name: 'Fälschung' },
      }),
    ),
  ).rejects.toThrow();

  expect(await page.evaluate(() => window.__starship.size())).toBe(0);
});

test('der Client ruft /api/garmin-sync nie auf, und garmin_tokens erscheint nirgends im IndexedDB (issue #186 AC4)', async ({
  page,
}) => {
  const garminSyncCalls: string[] = [];
  await page.route('**/*', (route) => {
    if (route.request().url().includes('/api/garmin-sync')) {
      garminSyncCalls.push(route.request().url());
    }
    return route.continue();
  });

  await registerPasskey(page);
  const id = await insertGarminActivity();

  await expect.poll(async () => {
    await page.evaluate(() => window.__starship.sync());
    return (await garminRecords(page)).some((r) => r.id === id);
  }).toBe(true);

  expect(garminSyncCalls).toEqual([]);

  const rows = await page.evaluate(() => window.__starship.debugRecords());
  expect(rows.some((r) => r.table === 'garmin_tokens')).toBe(false);
});
