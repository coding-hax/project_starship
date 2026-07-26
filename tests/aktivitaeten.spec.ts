import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { openMeteoForecastBody, registerPasskey, resetAppData, skewClock, withDb } from './helpers';

/**
 * Aktivitäten-Seite + Monatsstand (issue #180). Activities are server-origin,
 * read-only data (ADR-0011, #186) — `withDb()` stands in for the nightly Garmin
 * cron exactly like in garmin.spec.ts, never a real Garmin/map-service call.
 */

const NOW = '2026-07-26T12:00:00.000Z';
const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';

const DEFAULT_TRACK = {
  n: 5,
  distance: [0, 500, 1000, 1500, 2000],
  lat: [50.7, 50.702, 50.704, 50.702, 50.7],
  lon: [7.1, 7.102, 7.1, 7.098, 7.1],
  hr: [140, 150, 160, 155, 148],
  speed: [2.6, 2.9, 3.1, 2.8, 2.7],
  elevation: [60, 65, 72, 68, 61],
};

const TINY_MAP_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

interface ActivityOverrides {
  garminActivityId?: number;
  activityType?: string;
  name?: string | null;
  startedAt?: string;
  distanceMeters?: number | null;
  durationSeconds?: number | null;
  elapsedSeconds?: number | null;
  elevationGain?: number | null;
  elevationLoss?: number | null;
  averageHr?: number | null;
  maxHr?: number | null;
  averageSpeed?: number | null;
  calories?: number | null;
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
        overrides.startedAt ?? '2026-07-20T06:30:00Z',
        overrides.distanceMeters === undefined ? 5000 : overrides.distanceMeters,
        overrides.durationSeconds === undefined ? 1750 : overrides.durationSeconds,
        overrides.elapsedSeconds === undefined ? 1810 : overrides.elapsedSeconds,
        overrides.elevationGain === undefined ? 120 : overrides.elevationGain,
        overrides.elevationLoss === undefined ? 118 : overrides.elevationLoss,
        overrides.averageHr === undefined ? 150 : overrides.averageHr,
        overrides.maxHr === undefined ? 178 : overrides.maxHr,
        overrides.averageSpeed === undefined ? 2.8 : overrides.averageSpeed,
        overrides.calories === undefined ? 400 : overrides.calories,
        track === null ? null : JSON.stringify(track),
        overrides.mapImage === undefined ? TINY_MAP_IMAGE : overrides.mapImage,
      ],
    );
  });

  return id;
}

async function goToAktivitaeten(page: Page) {
  await page.goto('/aktivitaeten');
  await expect(page.getByRole('heading', { name: 'Aktivitäten', level: 1 })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // registerPasskey() below lands on /uebersicht for an already-authenticated
  // session, which mounts WeatherForecast and fires a real fetch to the open-meteo
  // API (issue #159) -- on a page this spec never otherwise touches. Unmocked,
  // that call is flaky in exactly the way AC5's console-error assertion below is
  // designed to catch. Fulfilling (not aborting, unlike uebersicht.spec.ts's
  // default) matters: an aborted fetch still makes use-weather-forecast.ts log its
  // own '[weather] refresh failed' error, which would just swap an intermittent
  // failure for a deterministic one. Built through openMeteoForecastBody() rather
  // than inline for the same reason: since issue #156 parseForecast also reads
  // `hourly`, and a body carrying only `daily` throws inside the refresh — landing
  // as exactly the console error AC5 asserts against.
  await page.route(OPEN_METEO_PATTERN, (route) =>
    route.fulfill({
      json: openMeteoForecastBody({ dates: ['2026-07-26'], tempsMax: [20], tempsMin: [10] }),
    }),
  );
  await skewClock(page, NOW);
  await registerPasskey(page);
});

/* -------------------------------------------------------------------------- */
/* AC1: Recap, Reihenfolge, Kopfzahlen inkl. Pausen                           */
/* -------------------------------------------------------------------------- */

test('Recap und zwei Blöcke, neueste zuerst, Kopfzahlen inkl. gerechneter Pausen (issue #180 AC1)', async ({
  page,
}) => {
  await insertGarminActivity({
    name: 'Morgenlauf',
    startedAt: '2026-07-20T06:30:00Z',
    distanceMeters: 5000,
    durationSeconds: 1750,
    elapsedSeconds: 1810,
  });
  await insertGarminActivity({
    name: 'Abendlauf',
    startedAt: '2026-07-22T18:00:00Z',
    distanceMeters: 3000,
    durationSeconds: 900,
    elapsedSeconds: 900,
  });

  await goToAktivitaeten(page);

  await expect(page.locator('.activity-list__recap')).toHaveText('Letzte 30 Tage: 2 Aktivitäten · 8.0 km');

  const blocks = page.locator('.activity-block');
  await expect(blocks).toHaveCount(2);
  await expect(blocks.nth(0).locator('.activity-block__title')).toHaveText('Abendlauf');
  await expect(blocks.nth(1).locator('.activity-block__title')).toHaveText('Morgenlauf');

  const morgenlauf = blocks.nth(1);
  await expect(morgenlauf.locator('.activity-block__stat', { hasText: 'Distanz' })).toContainText('5.0 km');
  await expect(morgenlauf.locator('.activity-block__stat', { hasText: 'Pausen' })).toContainText('1:00');

  const abendlauf = blocks.nth(0);
  await expect(abendlauf.locator('.activity-block__stat', { hasText: 'Pausen' })).toContainText('0:00');
});

/* -------------------------------------------------------------------------- */
/* AC2: drei Kurven mit nichtleerem Pfad                                      */
/* -------------------------------------------------------------------------- */

test('ein Block zeigt drei Kurven mit nichtleerem Pfad (issue #180 AC2)', async ({ page }) => {
  await insertGarminActivity();
  await goToAktivitaeten(page);

  const paths = page.locator('.activity-chart__svg path');
  await expect(paths).toHaveCount(3);
  for (const d of await paths.evaluateAll((els) => els.map((el) => el.getAttribute('d')))) {
    expect(d).toBeTruthy();
    expect(d!.length).toBeGreaterThan(0);
  }
});

/* -------------------------------------------------------------------------- */
/* AC3: Karte -- Bild, SVG-Rückfall, kein leerer Kasten                       */
/* -------------------------------------------------------------------------- */

test('Karte: Bild wenn vorhanden, sonst SVG-Spur aus dem Track, sonst gar nichts -- Zahlen bleiben immer da (issue #180 AC3)', async ({
  page,
}) => {
  await insertGarminActivity({ garminActivityId: 1, name: 'Mit Bild', mapImage: TINY_MAP_IMAGE });
  await insertGarminActivity({ garminActivityId: 2, name: 'Nur Track', mapImage: null });
  await insertGarminActivity({ garminActivityId: 3, name: 'Ohne beides', mapImage: null, track: null });

  await goToAktivitaeten(page);

  const withImage = page.locator('.activity-block', { hasText: 'Mit Bild' });
  await expect(withImage.locator('.activity-map__image')).toHaveCount(1);
  await expect(withImage.locator('.activity-map__svg')).toHaveCount(0);

  const withTrack = page.locator('.activity-block', { hasText: 'Nur Track' });
  await expect(withTrack.locator('.activity-map__svg')).toHaveCount(1);
  await expect(withTrack.locator('.activity-map__image')).toHaveCount(0);

  const withNeither = page.locator('.activity-block', { hasText: 'Ohne beides' });
  await expect(withNeither.locator('.activity-map')).toHaveCount(0);
  // The numbers are unaffected by a missing map -- a partial result from #186 is
  // normal, not an error.
  await expect(withNeither.locator('.activity-block__stat', { hasText: 'Distanz' })).toContainText('5.0 km');
});

/* -------------------------------------------------------------------------- */
/* AC4: fehlende Herzfrequenz -- weder Kurve noch "0 bpm"-Zeile                */
/* -------------------------------------------------------------------------- */

test('eine Radfahrt ohne Herzfrequenz zeigt weder HF-Kurve noch eine 0-bpm-Zeile (issue #180 AC4)', async ({
  page,
}) => {
  await insertGarminActivity({
    name: 'Radtour',
    activityType: 'cycling',
    averageHr: null,
    maxHr: null,
    track: { ...DEFAULT_TRACK, hr: [null, null, null, null, null] },
  });

  await goToAktivitaeten(page);

  const block = page.locator('.activity-block', { hasText: 'Radtour' });
  await expect(block.locator('.activity-chart__svg')).toHaveCount(2); // Pace + Höhenprofil, keine HF-Kurve
  await expect(block.locator('.activity-block__stat', { hasText: 'Ø-HF' })).toHaveCount(0);
  await expect(block).not.toContainText('0 bpm');
});

/* -------------------------------------------------------------------------- */
/* AC5: Leerzustand                                                           */
/* -------------------------------------------------------------------------- */

test('ohne Aktivitäten zeigt die Seite einen ruhigen Leerzustand, keine Fehlermeldung, saubere Konsole (issue #180 AC5)', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  await goToAktivitaeten(page);

  await expect(page.locator('.activity-list__empty')).toHaveText(
    'Noch keine Aktivitäten. Sobald der nächtliche Abgleich gelaufen ist, erscheinen sie hier.',
  );
  await expect(page.locator('.activity-block')).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});

/* -------------------------------------------------------------------------- */
/* AC6: offline -- Blöcke bleiben, nie in der Outbox                          */
/* -------------------------------------------------------------------------- */

test('offline gehen: die Blöcke bleiben sichtbar, die Outbox bleibt leer (issue #180 AC6)', async ({ page }) => {
  const id = await insertGarminActivity({ name: 'Offline-Lauf' });
  await goToAktivitaeten(page);
  await expect(page.locator('.activity-block', { hasText: 'Offline-Lauf' })).toBeVisible();

  // No reload while offline on purpose: this spec runs against the plain dev
  // server (no service worker, see playwright.config.ts) — only
  // offline-critical.spec.ts exercises an actual offline reload, against the prod
  // build. What matters for a read-only table (#186) is that data already in
  // IndexedDB keeps rendering once the network drops, and that nothing lands in
  // the outbox for a table the client can only ever read (garmin.spec.ts AC3).
  await page.context().setOffline(true);
  await expect(page.locator('.activity-block', { hasText: 'Offline-Lauf' })).toBeVisible();
  expect(await page.evaluate(() => window.__starship.size())).toBe(0);

  const records = await page.evaluate(() => window.__starship.debugRecords());
  expect(records.some((r) => r.id === id)).toBe(true);

  await page.context().setOffline(false);
});

/* -------------------------------------------------------------------------- */
/* AC7: Tokens, Dark Mode, prefers-reduced-motion                             */
/* -------------------------------------------------------------------------- */

test('die Karte nutzt --area-activities als Konturfarbe, auch im Dark Mode (issue #180 AC7)', async ({
  page,
}) => {
  await insertGarminActivity({ mapImage: null });
  await goToAktivitaeten(page);

  const resolveToken = () =>
    page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--area-activities)';
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });

  const svg = page.locator('.activity-map__svg');
  const lightColor = await svg.evaluate((el) => getComputedStyle(el).color);
  expect(lightColor).toBe(await resolveToken());

  await page.emulateMedia({ colorScheme: 'dark' });
  const darkColor = await svg.evaluate((el) => getComputedStyle(el).color);
  expect(darkColor).toBe(await resolveToken());
  expect(darkColor).not.toBe(lightColor);
});

test('bei reduzierter Bewegung steht der Lade-Puls der Skeletons still (issue #180 AC7)', async ({ page }) => {
  // The loading skeleton (`useActivities()` returning `undefined`) is a one-tick
  // state backed by a synchronous-ish Dexie read, not a network round trip like
  // the weather forecast's — nothing to gate it open long enough to observe on a
  // real page. A detached probe carrying the skeleton class sidesteps the race
  // entirely, the same pattern `resolveBackgroundToken` uses for tokens.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await goToAktivitaeten(page);

  const duration = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'activity-block--skeleton';
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).animationDuration;
    probe.remove();
    return value;
  });
  for (const d of duration.split(',')) {
    expect(parseFloat(d)).toBeLessThan(0.001);
  }
});

/* -------------------------------------------------------------------------- */
/* AC8: 375px und 1280px ohne horizontales Scrollen (läuft in beiden Projekten) */
/* -------------------------------------------------------------------------- */

test('die Seite passt ohne waagerechtes Scrollen von main (issue #180 AC8)', async ({ page }) => {
  await insertGarminActivity({ name: 'Breitentest' });
  await goToAktivitaeten(page);

  const overflow = await page.evaluate(() => {
    const main = document.querySelector('main');
    return main ? main.scrollWidth - main.clientWidth : 0;
  });
  expect(overflow).toBeLessThanOrEqual(0);
});

/* -------------------------------------------------------------------------- */
/* Nav: der sechste Eintrag führt auf /aktivitaeten                           */
/* -------------------------------------------------------------------------- */

test('der Nav-Eintrag "Aktivitäten" führt auf /aktivitaeten und markiert sich als aktiv (issue #180)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Aktivitäten' }).click();

  await expect(page).toHaveURL(/\/aktivitaeten$/);
  await expect(page.getByRole('heading', { name: 'Aktivitäten', level: 1 })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Aktivitäten' }),
  ).toHaveAttribute('aria-current', 'page');
});

/* -------------------------------------------------------------------------- */
/* Monatsstand auf der Übersicht                                              */
/* -------------------------------------------------------------------------- */

test('der Monatsstand zeigt die Aufschlüsselung je Aktivitätsart mit Kilometern (issue #180)', async ({
  page,
}) => {
  await insertGarminActivity({
    garminActivityId: 1,
    activityType: 'running',
    startedAt: '2026-07-05T06:00:00Z',
    distanceMeters: 5000,
  });
  await insertGarminActivity({
    garminActivityId: 2,
    activityType: 'running',
    startedAt: '2026-07-10T06:00:00Z',
    distanceMeters: 7000,
  });
  await insertGarminActivity({
    garminActivityId: 3,
    activityType: 'cycling',
    startedAt: '2026-07-15T06:00:00Z',
    distanceMeters: 25000,
  });

  await page.goto('/uebersicht');

  const strip = page.locator('.activity-month-strip');
  await expect(strip.locator('.activity-month-strip__heading')).toHaveText('Juli');
  await expect(strip.locator('.activity-month-strip__row').nth(0)).toContainText('2× Laufen');
  await expect(strip.locator('.activity-month-strip__row').nth(0)).toContainText('12.0 km');
  await expect(strip.locator('.activity-month-strip__row').nth(1)).toContainText('1× Radfahren');
  await expect(strip.locator('.activity-month-strip__row').nth(1)).toContainText('25.0 km');
});

test('Tippen auf den Monatsstand führt auf /aktivitaeten (issue #180)', async ({ page }) => {
  await insertGarminActivity({ startedAt: '2026-07-10T06:00:00Z' });
  await page.goto('/uebersicht');

  await page.locator('.activity-month-strip').click();
  await expect(page).toHaveURL(/\/aktivitaeten$/);
});

test('eine Aktivität nur im Vormonat zeigt den ruhigen Leerzustand des Monatsstands (issue #180)', async ({
  page,
}) => {
  await insertGarminActivity({ startedAt: '2026-06-15T06:00:00Z' });
  await page.goto('/uebersicht');

  const strip = page.locator('.activity-month-strip');
  await expect(strip.locator('.activity-month-strip__empty')).toHaveText(
    'Diesen Monat noch nichts aufgezeichnet.',
  );
});

test('ohne jede Aktivität erscheint der Monatsstand gar nicht im DOM (issue #180)', async ({ page }) => {
  await page.goto('/uebersicht');
  await expect(page.locator('.activity-month-strip')).toHaveCount(0);
});

test('der Monatsstand bleibt innerhalb der Seitenbreite auf 375px und 1280px (issue #180)', async ({ page }) => {
  await insertGarminActivity({ startedAt: '2026-07-10T06:00:00Z' });
  await page.goto('/uebersicht');
  await expect(page.locator('.activity-month-strip')).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('der Monatsstand respektiert Dark Mode und prefers-reduced-motion (issue #180)', async ({ page }) => {
  await insertGarminActivity({ startedAt: '2026-07-10T06:00:00Z' });
  await page.goto('/uebersicht');

  const strip = page.locator('.activity-month-strip');
  const lightColor = await strip.evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.emulateMedia({ colorScheme: 'dark' });
  const darkColor = await strip.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(darkColor).not.toBe(lightColor);

  // Probe instead of racing the real skeleton (see the Aktivitäten-page reduced-
  // motion test above) — `activity-month-strip--skeleton`'s loading window is just
  // as short-lived.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const duration = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'activity-month-strip__row--skeleton';
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).animationDuration;
    probe.remove();
    return value;
  });
  for (const d of duration.split(',')) {
    expect(parseFloat(d)).toBeLessThan(0.001);
  }
});
