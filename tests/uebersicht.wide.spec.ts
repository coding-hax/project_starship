import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { openMeteoForecastBody, registerPasskey, resetAppData, skewClock, withDb } from './helpers';

/**
 * Dritte Desktop-Stufe (issue #1120, Nachfolger von #1020/ADR-0029): ab 1440px
 * lösen sich Wetter und Termine aus dem Zweispalten-Balancing (das bleibt bei
 * 768–1439px unverändert, siehe AK5 unten und uebersicht.desktop.spec.ts) und
 * laufen als volle Bahnen über ein dreispaltiges Grid, die übrigen Sektionen
 * darunter. Läuft im `desktop-wide`-Messplatz (1800 × 1000,
 * playwright.config.ts), wie seitenkopf.wide.spec.ts.
 */

const NOW = '2026-07-18T12:00:00.000Z';
const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';
const MODULES_OFF_KEY = 'starship:modules-off';
const FORECAST_WEEK = [
  '2026-07-15',
  '2026-07-16',
  '2026-07-17',
  '2026-07-18',
  '2026-07-19',
  '2026-07-20',
  '2026-07-21',
];

async function seedTask(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: p }),
    payload,
  );
}

async function seedEvent(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'events', op: 'upsert', payload: p }),
    payload,
  );
}

/** Trimmed one-off of aktivitaeten.spec.ts's insertGarminActivity — genug,
 * damit ActivityMonthStrip aus seinem "noch nie eine Aktivität" `return null`
 * (issue #180) heraustritt. Läuft vor der ersten Navigation, damit der erste
 * Sync-Pull der Seite die Zeile schon mitbringt (wie aktivitaeten.spec.ts). */
async function insertActivity(): Promise<void> {
  const track = { n: 3, hr: [140, 150, 145], speed: [2.6, 2.9, 2.7], elevation: [60, 65, 61] };
  await withDb((client) =>
    client.query(
      `INSERT INTO garmin_activities
        (id, updated_at, deleted_at, synced_at, sync_seq, garmin_activity_id, activity_type, name,
         started_at, distance_meters, duration_seconds, elapsed_seconds, elevation_gain, elevation_loss,
         average_hr, max_hr, average_speed, calories, track, map_image, fetched_at)
       VALUES
        ($1, now(), NULL, now(), nextval('sync_seq'), $2, 'running', 'Breite-Lauf',
         '2026-07-20T06:30:00Z', 5000, 1750, 1810, 120, 118,
         150, 178, 2.8, 400, $3, NULL, now())`,
      [randomUUID(), Math.floor(Math.random() * 1_000_000_000), JSON.stringify(track)],
    ),
  );
}

/** Wartet auf denselben gemeinsamen Enthüllungspunkt (issue #642) wie die
 * anderen /uebersicht-Specs — vorher stehen die Sektionen zwar im Layout,
 * sind aber `visibility: hidden`, und Geometrie-Messungen wären verfrüht. */
async function waitForReveal(page: Page): Promise<void> {
  await expect(page.locator('.habit-today')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  await page.route(OPEN_METEO_PATTERN, (route) =>
    route.fulfill({
      json: openMeteoForecastBody({
        dates: FORECAST_WEEK,
        tempsMax: FORECAST_WEEK.map(() => 20),
        tempsMin: FORECAST_WEEK.map(() => 10),
      }),
    }),
  );
});

test('AK1: jede Sektion trägt ihr Modul als data-section auf .overview-block (issue #1120)', async ({
  page,
}) => {
  await insertActivity();
  await registerPasskey(page, '/uebersicht');
  await skewClock(page, NOW);
  await seedTask(page, { title: 'Aufgabe', dueAt: NOW });
  await seedEvent(page, {
    title: 'Standup',
    allDay: false,
    startsAt: '2026-07-18T12:40:00.000Z',
    endsAt: '2026-07-18T13:10:00.000Z',
    startDate: null,
    endDate: null,
    category: 'arbeit',
  });

  await waitForReveal(page);
  await expect(page.locator('.overview-block[data-section="aktivitaeten"]')).toBeVisible();

  for (const id of ['wetter', 'kalender', 'aufgaben', 'aktivitaeten', 'routinen']) {
    await expect(
      page.locator(`.uebersicht__sections > .overview-block[data-section="${id}"]`),
      `Sektion ${id} trägt ihr data-section`,
    ).toHaveCount(1);
  }
});

test('AK2/AK3: ab 1440px ist .uebersicht__sections ein dreispaltiges Raster, Wetter und Termine überspannen alle drei Spalten, die übrigen Sektionen stehen in der Zeile darunter, oben ausgerichtet (issue #1120)', async ({
  page,
}) => {
  await insertActivity();
  await registerPasskey(page, '/uebersicht');
  await skewClock(page, NOW);
  await seedTask(page, { title: 'Aufgabe', dueAt: NOW });
  await seedEvent(page, {
    title: 'Standup',
    allDay: false,
    startsAt: '2026-07-18T12:40:00.000Z',
    endsAt: '2026-07-18T13:10:00.000Z',
    startDate: null,
    endDate: null,
    category: 'arbeit',
  });

  await waitForReveal(page);
  await expect(page.locator('.overview-block[data-section="aktivitaeten"]')).toBeVisible();

  const sections = page.locator('.uebersicht__sections');
  const [display, templateColumns] = await sections.evaluate((el) => {
    const style = getComputedStyle(el);
    return [style.display, style.gridTemplateColumns];
  });
  expect(display, 'AK2: dreispaltiges Raster').toBe('grid');
  expect(templateColumns.split(' ').filter(Boolean), 'AK2: drei Spalten').toHaveLength(3);

  const containerBox = await sections.boundingBox();
  const wetterBox = await page.locator('.overview-block[data-section="wetter"]').boundingBox();
  const kalenderBox = await page.locator('.overview-block[data-section="kalender"]').boundingBox();
  // AK2: Wetter und Termine überspannen alle drei Spalten — ihre Breite
  // entspricht der vollen Raster-Breite, nicht einer einzelnen Spalte.
  expect(Math.round(wetterBox!.width), 'Wetter überspannt das Raster').toBeGreaterThanOrEqual(
    Math.round(containerBox!.width) - 1,
  );
  expect(Math.round(kalenderBox!.width), 'Termine überspannen das Raster').toBeGreaterThanOrEqual(
    Math.round(containerBox!.width) - 1,
  );
  // … und stehen deckungsgleich übereinander (beide starten an derselben x-Kante).
  expect(Math.round(wetterBox!.x)).toBe(Math.round(kalenderBox!.x));
  // Termine folgen direkt unter Wetter, nicht in einer eigenen Grid-Spalte daneben.
  expect(kalenderBox!.y).toBeGreaterThanOrEqual(wetterBox!.y + wetterBox!.height - 1);

  const aufgabenBox = await page.locator('.overview-block[data-section="aufgaben"]').boundingBox();
  const aktivBox = await page.locator('.overview-block[data-section="aktivitaeten"]').boundingBox();
  const routinenBox = await page.locator('.overview-block[data-section="routinen"]').boundingBox();

  // AK3: dieselbe Zeile — oben ausgerichtet, unabhängig von der Eigenhöhe jeder Karte.
  expect(Math.round(aufgabenBox!.y)).toBe(Math.round(aktivBox!.y));
  expect(Math.round(aufgabenBox!.y)).toBe(Math.round(routinenBox!.y));
  // … unterhalb der Termine-Zeile.
  expect(aufgabenBox!.y).toBeGreaterThanOrEqual(kalenderBox!.y + kalenderBox!.height - 1);
  // AK3: drei eigene Spalten, in der DOM-Reihenfolge aus uebersicht-sections.tsx.
  expect(aufgabenBox!.x).toBeLessThan(aktivBox!.x);
  expect(aktivBox!.x).toBeLessThan(routinenBox!.x);
});

test('AK4: ein abgeschaltetes Modul lässt das Raster ohne Lücke, die verbliebenen Sektionen rücken auf (issue #1120)', async ({
  page,
}) => {
  await page.addInitScript(
    ({ key, value }) => localStorage.setItem(key, value),
    { key: MODULES_OFF_KEY, value: JSON.stringify(['aktivitaeten']) },
  );
  await registerPasskey(page, '/uebersicht');
  await skewClock(page, NOW);
  await seedTask(page, { title: 'Aufgabe', dueAt: NOW });

  await waitForReveal(page);
  await expect(page.locator('.overview-block[data-section="aktivitaeten"]')).toHaveCount(0);

  const sections = page.locator('.uebersicht__sections');
  const gapPx = await sections.evaluate((el) => parseFloat(getComputedStyle(el).columnGap));
  const containerBox = await sections.boundingBox();
  const aufgabenBox = await page.locator('.overview-block[data-section="aufgaben"]').boundingBox();
  const routinenBox = await page.locator('.overview-block[data-section="routinen"]').boundingBox();

  // Aufgaben rückt in die erste Spalte …
  expect(Math.round(aufgabenBox!.x)).toBe(Math.round(containerBox!.x));
  // … Routinen direkt in die zweite, ohne die freigewordene dritte Spalte
  // dazwischen leer zu lassen (keine Lücke).
  expect(Math.round(routinenBox!.x)).toBe(Math.round(aufgabenBox!.x + aufgabenBox!.width + gapPx));
  expect(Math.round(routinenBox!.y)).toBe(Math.round(aufgabenBox!.y));
});

test('AK6: bei Viewport 1800 ragt keine Sektion in den schwebenden Erfassen-Knopf hinein — die Bodenreserve rechnet gegen die Desktop-Fab-Position (issue #1120)', async ({
  page,
}) => {
  await registerPasskey(page, '/uebersicht');
  await skewClock(page, NOW);
  for (let i = 0; i < 20; i += 1) {
    await seedTask(page, { title: `Aufgabe ${i}`, dueAt: NOW });
  }

  await waitForReveal(page);

  const sectionsPaddingBottom = await page
    .locator('.uebersicht__sections')
    .evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
  expect(sectionsPaddingBottom, 'reserviert Bodenabstand für den Fab').toBeGreaterThan(0);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

  const blocks = page.locator('.uebersicht__sections > .overview-block');
  const count = await blocks.count();
  const boxes = await Promise.all(Array.from({ length: count }, (_, i) => blocks.nth(i).boundingBox()));
  const maxBottom = Math.max(...boxes.map((box) => box!.y + box!.height));

  const fabBox = await page.locator('.fab').boundingBox();
  expect(maxBottom, 'unterster Sektionsrand bleibt oberhalb des Fab').toBeLessThanOrEqual(fabBox!.y);
});
