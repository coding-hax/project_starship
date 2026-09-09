import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { FIXED_NOW, installClockAt, registerPasskey, resetAppData, withDb } from './helpers';

/**
 * Dritte Desktop-Stufe für /aktivitaeten (issue #1127, Teil von #1113): ab
 * 1440px stehen zwei Blöcke nebeneinander, und innerhalb eines Blocks steht die
 * Streckenkarte neben Titel/Datum/Kennzahlen statt darüber. Läuft im
 * `desktop-wide`-Messplatz (1800 × 1000, playwright.config.ts), wie
 * aufgaben.wide.spec.ts. Die gestapelte Form bei 1280px/375px bleibt
 * unverändert -- dafür bürgt weiterhin aktivitaeten.spec.ts, AK5 hier prüft nur
 * die Nicht-Regression auf denselben zwei Breiten.
 */

const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';
const GARMIN_SYNC_PATTERN = '**/api/garmin-sync';
const SYNC_COUNTERS = { scanned: 0, created: 0, updated: 0, detailsFilled: 0, mapsFilled: 0 };

const DEFAULT_TRACK = {
  n: 5,
  distance: [0, 500, 1000, 1500, 2000],
  lat: [50.7, 50.702, 50.704, 50.702, 50.7],
  lon: [7.1, 7.102, 7.1, 7.098, 7.1],
  hr: [140, 150, 160, 155, 148],
  speed: [2.6, 2.9, 3.1, 2.8, 2.7],
  elevation: [60, 65, 72, 68, 61],
};

const TINY_MAP_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

interface ActivityOverrides {
  garminActivityId?: number;
  activityType?: string;
  name?: string | null;
  startedAt?: string;
  distanceMeters?: number | null;
  averageSpeed?: number | null;
  elevationGain?: number | null;
  averageHr?: number | null;
  track?: Record<string, unknown> | null;
  mapImage?: string | null;
}

async function insertGarminActivity(overrides: ActivityOverrides = {}): Promise<string> {
  const id = randomUUID();
  const garminActivityId = overrides.garminActivityId ?? Math.floor(Math.random() * 1_000_000_000);
  const track = overrides.track === undefined ? DEFAULT_TRACK : overrides.track;

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
        overrides.activityType ?? 'running',
        overrides.name === undefined ? 'Morgenlauf' : overrides.name,
        overrides.startedAt ?? '2026-07-15T06:30:00Z',
        overrides.distanceMeters === undefined ? 5000 : overrides.distanceMeters,
        1750,
        1810,
        overrides.elevationGain === undefined ? 120 : overrides.elevationGain,
        118,
        overrides.averageHr === undefined ? 150 : overrides.averageHr,
        178,
        overrides.averageSpeed === undefined ? 2.8 : overrides.averageSpeed,
        400,
        track === null ? null : JSON.stringify(track),
        overrides.mapImage === undefined ? TINY_MAP_IMAGE : overrides.mapImage,
      ],
    );
  });

  return id;
}

async function goToAktivitaeten(page: Page) {
  await page.goto('/aktivitaeten');
  await expect(page.locator('[data-module="aktivitaeten"] h1')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // /uebersicht (registerPasskey landet dort beim allerersten Lauf) holt Wetter
  // und stößt Garmin-Sync an -- ungemockt leckt der echte Netzaufruf in jeden
  // Test (grundfarbe.spec.ts). /aktivitaeten selbst stößt denselben Garmin-Sync
  // beim Öffnen an (issue #230).
  await page.route(GARMIN_SYNC_PATTERN, (route) => route.fulfill({ json: SYNC_COUNTERS }));
  await page.route(OPEN_METEO_PATTERN, (route) =>
    route.fulfill({
      json: {
        daily: {
          time: ['2026-07-18'],
          weather_code: [0],
          temperature_2m_max: [20],
          temperature_2m_min: [10],
          precipitation_probability_max: [0],
          sunrise: ['2026-07-18T05:00'],
          sunset: ['2026-07-18T21:00'],
          wind_speed_10m_max: [10],
          wind_gusts_10m_max: [15],
        },
        hourly: {
          time: Array.from({ length: 24 }, (_, h) => `2026-07-18T${String(h).padStart(2, '0')}:00`),
          temperature_2m: Array.from({ length: 24 }, () => 15),
          precipitation_probability: Array.from({ length: 24 }, () => 0),
          precipitation: Array.from({ length: 24 }, () => 0),
        },
      },
    }),
  );
  // No target: every test opens with its own goto (issue #1075).
  await registerPasskey(page, null);
});

test('AK1: ab 1440px stehen mindestens zwei Blöcke nebeneinander, oben ausgerichtet', async ({ page }) => {
  await installClockAt(page, FIXED_NOW);
  await insertGarminActivity({ garminActivityId: 1, name: 'Block A', startedAt: '2026-07-16T06:00:00Z' });
  await insertGarminActivity({ garminActivityId: 2, name: 'Block B', startedAt: '2026-07-17T06:00:00Z' });

  await goToAktivitaeten(page);

  const list = page.locator('.activity-list');
  await expect(page.locator('.activity-block')).toHaveCount(2);

  const columns = await list.evaluate((el) =>
    getComputedStyle(el)
      .gridTemplateColumns.trim()
      .split(/\s+/)
      .map((value) => parseFloat(value)),
  );
  expect(columns).toHaveLength(2);
  expect(Math.abs(columns[0] - columns[1])).toBeLessThan(1);

  const blocks = page.locator('.activity-block');
  const boxA = await blocks.nth(0).boundingBox();
  const boxB = await blocks.nth(1).boundingBox();
  if (!boxA || !boxB) throw new Error('Block ohne Bounding-Box');

  // Oben ausgerichtet: gleiche y-Position ...
  expect(Math.abs(boxA.y - boxB.y)).toBeLessThanOrEqual(1);
  // ... aber zwei tatsächlich unterschiedliche Spalten, keine gemeinsame.
  expect(boxB.x).toBeGreaterThan(boxA.x + boxA.width - 1);
});

test('AK2: die Karte steht in einer 280px-Spalte links und überspannt Titel/Datum/Kennzahlen -- die drei Kurven laufen darunter über die volle Blockbreite', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await insertGarminActivity({ name: 'Mit Karte und Kurven' });
  await goToAktivitaeten(page);

  const block = page.locator('.activity-block', { hasText: 'Mit Karte und Kurven' });
  const map = block.locator('.activity-map');
  const head = block.locator('.activity-block__head');
  const charts = block.locator('.activity-chart');

  const mapBox = await map.boundingBox();
  const headBox = await head.boundingBox();
  if (!mapBox || !headBox) throw new Error('Karte oder Kopf ohne Bounding-Box');

  expect(Math.round(mapBox.width)).toBe(280);
  // Kopf steht rechts neben der Karte, in derselben Zeile.
  expect(headBox.x).toBeGreaterThan(mapBox.x + mapBox.width - 1);
  expect(Math.abs(headBox.y - mapBox.y)).toBeLessThanOrEqual(1);

  await expect(charts).toHaveCount(3);
  const chartCount = await charts.count();
  const headBottom = headBox.y + headBox.height;
  const mapBottom = mapBox.y + mapBox.height;
  for (let i = 0; i < chartCount; i += 1) {
    const chartBox = await charts.nth(i).boundingBox();
    if (!chartBox) throw new Error('Kurve ohne Bounding-Box');
    // Volle Blockbreite: linke Kante auf Höhe der Karte, rechte Kante auf Höhe des Kopfs.
    expect(Math.abs(chartBox.x - mapBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(chartBox.x + chartBox.width - (headBox.x + headBox.width))).toBeLessThanOrEqual(1);
    // Unterhalb von Karte UND Kopf.
    expect(chartBox.y).toBeGreaterThanOrEqual(Math.min(headBottom, mapBottom) - 1);
  }
});

test('AK3: ein Block ohne Karte (kein Bild, kein Track) bleibt einspaltig, ohne leere Spalte', async ({ page }) => {
  await installClockAt(page, FIXED_NOW);
  await insertGarminActivity({ name: 'Ohne Karte', mapImage: null, track: null });
  await goToAktivitaeten(page);

  const block = page.locator('.activity-block', { hasText: 'Ohne Karte' });
  await expect(block.locator('.activity-map')).toHaveCount(0);

  const display = await block.evaluate((el) => getComputedStyle(el).display);
  expect(display).not.toBe('grid');

  const blockBox = await block.boundingBox();
  const headBox = await block.locator('.activity-block__head').boundingBox();
  if (!blockBox || !headBox) throw new Error('Block oder Kopf ohne Bounding-Box');
  // Kein 280px-Leerraum links -- der Kopf beginnt direkt an der (gepolsterten) Blockkante.
  expect(headBox.x - blockBox.x).toBeLessThan(100);
});

test('AK4: der Kennzahl-Chip in der Kopfzeile überlappt keinen Block', async ({ page }) => {
  await installClockAt(page, FIXED_NOW);
  await insertGarminActivity({ garminActivityId: 1, name: 'Chip-Test A' });
  await insertGarminActivity({ garminActivityId: 2, name: 'Chip-Test B' });
  await goToAktivitaeten(page);

  const chip = page.locator('.page-head__chip');
  await expect(chip).toBeVisible();
  const chipBox = await chip.boundingBox();
  if (!chipBox) throw new Error('Chip ohne Bounding-Box');

  const blocks = page.locator('.activity-block');
  const blockCount = await blocks.count();
  for (let i = 0; i < blockCount; i += 1) {
    const blockBox = await blocks.nth(i).boundingBox();
    if (!blockBox) throw new Error('Block ohne Bounding-Box');
    expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(blockBox.y);
  }
});

test('AK5: bei 1280px und 375px bleibt der Block unverändert gestapelt', async ({ page }) => {
  await installClockAt(page, FIXED_NOW);
  await insertGarminActivity({ name: 'Schmalbreite' });

  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await goToAktivitaeten(page);

    const list = page.locator('.activity-list');
    expect(await list.evaluate((el) => getComputedStyle(el).display)).not.toBe('grid');

    const block = page.locator('.activity-block', { hasText: 'Schmalbreite' });
    expect(await block.evaluate((el) => getComputedStyle(el).display)).not.toBe('grid');

    const mapBox = await block.locator('.activity-map').boundingBox();
    const headBox = await block.locator('.activity-block__head').boundingBox();
    if (!mapBox || !headBox) throw new Error('Karte oder Kopf ohne Bounding-Box');
    // Gestapelt: der Kopf beginnt unterhalb der Karte, nicht daneben.
    expect(headBox.y).toBeGreaterThanOrEqual(mapBox.y + mapBox.height - 1);
  }
});
