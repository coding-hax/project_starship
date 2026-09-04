import { expect, test, type Locator, type Page } from '@playwright/test';
import { FIXED_NOW, installClockAt, registerPasskey, resetAppData } from './helpers';

/**
 * Aufgaben ab 768px in zwei Spalten (issue #1022, Teil 7 von #1015). Desktop-only
 * (1280×800, `desktop`-Projekt) — die 375×812-Suite (tasks.spec.ts u. a.) bleibt
 * unverändert grün und deckt die mobile Einspalter-Geometrie weiterhin ab.
 */

const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';
const GARMIN_SYNC_PATTERN = '**/api/garmin-sync';

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // /uebersicht (registerPasskey landet dort) holt Wetter und stößt Garmin-Sync
  // an — ungemockt leckt der echte Netzaufruf in jeden Test (grundfarbe.spec.ts).
  await page.route(GARMIN_SYNC_PATTERN, (route) =>
    route.fulfill({
      json: { scanned: 0, created: 0, updated: 0, detailsFilled: 0, mapsFilled: 0 },
    }),
  );
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
  // No target: every test in this file opens with its own goto, so loading
  // /uebersicht here would only be thrown away (issue #1075).
  await registerPasskey(page, null);
});

async function seedTask(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: p }),
    payload,
  );
}

/** `FIXED_NOW` shifted by whole local-calendar days, at a fixed local clock
 *  time — mirrors tasks.spec.ts's/aufgaben-kartenrhythmus.spec.ts's own helper. */
function isoAt(daysFromNow: number, hours = 9): string {
  const date = new Date(FIXED_NOW);
  date.setDate(date.getDate() + daysFromNow);
  date.setHours(hours, 0, 0, 0);
  return date.toISOString();
}

/** Text-node-tight bounding box, not the flex item's own (possibly stretched)
 *  box — same technique as seitenkopf.spec.ts's/kalender.spec.ts's `textBoundingBox`. */
async function textBoundingBox(locator: Locator): Promise<{ x: number; right: number }> {
  return locator.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, right: rect.right };
  });
}

async function seedOneDueAndTwoUndated(page: Page) {
  await seedTask(page, { title: 'Fällig diese Woche', dueAt: isoAt(1) });
  await seedTask(page, { title: 'Ohne Datum A' });
  await seedTask(page, { title: 'Ohne Datum B' });
}

test('AK1: fällige Liste und "ohne Datum"-Karte stehen ab 768px nebeneinander, nicht untereinander', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');
  await seedOneDueAndTwoUndated(page);

  const list = page.getByRole('list', { name: 'Aufgaben' });
  const undated = page.locator('.task-list__undated-card');
  await expect(list).toBeVisible();
  await expect(undated).toBeVisible();

  const listBox = await list.boundingBox();
  const undatedBox = await undated.boundingBox();
  if (!listBox || !undatedBox) throw new Error('missing bounding box');

  // Nebeneinander (Spalte 2 rechts von Spalte 1), nicht untereinander.
  expect(undatedBox.x).toBeGreaterThanOrEqual(listBox.x + listBox.width);
  // Gleiche Reihe: vertikal überlappend statt versetzt.
  const verticalOverlap =
    Math.min(listBox.y + listBox.height, undatedBox.y + undatedBox.height) -
    Math.max(listBox.y, undatedBox.y);
  expect(verticalOverlap).toBeGreaterThan(0);
});

test('AK2: die "ohne Datum"-Karte bekommt in ihrer Spalte wieder eine eigene Fläche', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');
  await seedOneDueAndTwoUndated(page);

  const undated = page.locator('.task-list__undated-card');
  await expect(undated).toBeVisible();
  expect(await undated.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
    'rgba(0, 0, 0, 0)',
  );
  expect(await undated.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');
  expect(await undated.evaluate((el) => getComputedStyle(el).borderRadius)).not.toBe('0px');
});

test('AK3: die Seitenfigur steht ab 768px direkt neben dem Titelwort statt am rechten Rand', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');

  const row = page.locator('.aufgaben-page__title-row');
  const heading = page.getByRole('heading', { level: 1, name: 'Aufgaben' });
  const face = row.locator('.face');
  const rowBox = await row.boundingBox();
  const textBox = await textBoundingBox(heading);
  const faceBox = await face.boundingBox();
  if (!rowBox || !faceBox) throw new Error('missing bounding box');

  const textToFace = faceBox.x - textBox.right;
  const faceToRightEdge = rowBox.x + rowBox.width - (faceBox.x + faceBox.width);
  expect(textToFace).toBeLessThan(10);
  expect(faceToRightEdge).toBeGreaterThan(textToFace + 10);
});

test('AK4: der schwebende Erfassen-Knopf verdeckt keine Zeile am Seitenende', async ({ page }) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');
  // Genug fällige Aufgaben, damit die linke Spalte über die Viewporthöhe hinausreicht.
  for (let i = 0; i < 15; i += 1) {
    await seedTask(page, { title: `Fällig-Sonde ${i}`, dueAt: isoAt(1, 8 + (i % 12)) });
  }

  const items = page.getByRole('list', { name: 'Aufgaben' }).getByRole('listitem');
  await expect(items).toHaveCount(15);
  await items.last().scrollIntoViewIfNeeded();

  const lastRowBox = await items.last().boundingBox();
  const fabBox = await page.locator('.fab').boundingBox();
  if (!lastRowBox || !fabBox) throw new Error('missing bounding box');

  expect(lastRowBox.y + lastRowBox.height).toBeLessThanOrEqual(fabBox.y);
});
