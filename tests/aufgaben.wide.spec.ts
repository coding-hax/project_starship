import { expect, test, type Page } from '@playwright/test';
import { FIXED_NOW, installClockAt, registerPasskey, resetAppData } from './helpers';

/**
 * Dritte Desktop-Stufe (issue #1118, Nachfolger von #1117): ab 1440px füllt
 * die Aufgabenliste die volle Breite — Gruppen laufen zweibahnig, „ohne
 * Datum" bekommt eine dritte Spalte statt einer leeren Restfläche. Läuft im
 * `desktop-wide`-Messplatz (1800 × 1000, playwright.config.ts), wie
 * seitenkopf.wide.spec.ts. Die zweispaltige Form bei 1280px bleibt
 * unverändert — dafür bürgt aufgaben.desktop.spec.ts weiter, die einspaltige
 * bei 375px tasks.spec.ts AK9.
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
  // No target: every test opens with its own goto (issue #1075).
  await registerPasskey(page, null);
});

async function seedTask(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: p }),
    payload,
  );
}

/** `FIXED_NOW` shifted by whole local-calendar days — mirrors tasks.spec.ts's own helper. */
function isoAt(daysFromNow: number, hours = 9): string {
  const date = new Date(FIXED_NOW);
  date.setDate(date.getDate() + daysFromNow);
  date.setHours(hours, 0, 0, 0);
  return date.toISOString();
}

function viewOption(page: Page, name: '7 Tage' | 'Alle' | 'Erledigt') {
  return page.getByRole('radiogroup', { name: 'Aufgaben-Ansicht' }).getByRole('radio', { name });
}

test('AK1/AK2: Liste wird ab 1440px dreispaltig und läuft selbst zweibahnig, ohne eine Gruppe an der Bahnengrenze zu zerreißen', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');
  // "7 Tage" kennt nur drei feste Buckets (Überfällig/Heute/7 Tage) — für
  // "mindestens vier Fälligkeitsgruppen" (AK1) taugt nur "Erledigt", die
  // einen Kopf je erledigtem Tag rendert (dieselben `.task-list__group`s).
  for (let day = 0; day < 5; day += 1) {
    await seedTask(page, { title: `Erledigt Tag ${day}`, completedAt: isoAt(-day, 10) });
  }

  await viewOption(page, 'Erledigt').click();
  await expect(viewOption(page, 'Erledigt')).toHaveAttribute('aria-checked', 'true');

  const groups = page.locator('.task-list__group');
  await expect(groups).toHaveCount(5);

  const surface = page.locator('.task-list__surface').first();
  const list = page.locator('.task-list').first();

  // AK1: Spalte 1/2 gleich breit, Spalte 3 bei 0.9fr.
  const columnWidths = await surface.evaluate((el) =>
    getComputedStyle(el)
      .gridTemplateColumns.trim()
      .split(/\s+/)
      .map((value) => parseFloat(value)),
  );
  expect(columnWidths).toHaveLength(3);
  expect(Math.abs(columnWidths[0] - columnWidths[1])).toBeLessThan(1);
  expect(columnWidths[2] / columnWidths[0]).toBeCloseTo(0.9, 1);

  // AK1: `.task-list` überspannt Spalte 1–2 und läuft selbst zweibahnig.
  const [gridColumnStart, gridColumnEnd, columnCount] = await list.evaluate((el) => {
    const style = getComputedStyle(el);
    return [style.gridColumnStart, style.gridColumnEnd, style.columnCount];
  });
  expect(gridColumnStart).toBe('1');
  expect(gridColumnEnd).toBe('3');
  expect(columnCount).toBe('2');

  // AK2: `break-inside: avoid` je Gruppe, und Kopf + erste Zeile jeder
  // Gruppe teilen tatsächlich dieselbe Bahn (gleiches x).
  const groupCount = await groups.count();
  const laneXs: number[] = [];
  for (let i = 0; i < groupCount; i += 1) {
    const group = groups.nth(i);
    expect(await group.evaluate((el) => getComputedStyle(el).breakInside)).toBe('avoid');

    const headerBox = await group.locator('.task-list__group-header').boundingBox();
    const firstRowBox = await group.locator('.task-list__item').first().boundingBox();
    if (!headerBox || !firstRowBox) throw new Error('Gruppe ohne Kopf/erste Zeile');
    expect(Math.abs(headerBox.x - firstRowBox.x)).toBeLessThanOrEqual(1);
    laneXs.push(Math.round(headerBox.x));
  }

  // Tatsächlich zwei Bahnen im Einsatz, nicht bloß eine mit Leerraum daneben.
  expect(new Set(laneXs).size).toBeGreaterThanOrEqual(2);
});

test('AK3: die "ohne Datum"-Karte steht ab 1440px in Spalte 3, Zeile 1', async ({ page }) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Fällig diese Woche', dueAt: isoAt(1) });
  await seedTask(page, { title: 'Ohne Datum A' });
  await seedTask(page, { title: 'Ohne Datum B' });

  const list = page.locator('.task-list').first();
  const undated = page.locator('.task-list__undated-card');
  await expect(undated).toBeVisible();

  const [gridColumnStart, gridRowStart] = await undated.evaluate((el) => {
    const style = getComputedStyle(el);
    return [style.gridColumnStart, style.gridRowStart];
  });
  expect(gridColumnStart).toBe('3');
  expect(gridRowStart).toBe('1');

  // Geometrisch bestätigt: rechts von der Liste, in derselben Zeile.
  const listBox = await list.boundingBox();
  const undatedBox = await undated.boundingBox();
  if (!listBox || !undatedBox) throw new Error('missing bounding box');
  expect(undatedBox.x).toBeGreaterThan(listBox.x + listBox.width);
  expect(Math.abs(undatedBox.y - listBox.y)).toBeLessThanOrEqual(1);
});
