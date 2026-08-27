import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  FIXED_NOW,
  installClockAt,
  openMeteoForecastBody,
  registerPasskey,
  resetAppData,
  withDb,
} from './helpers';

/**
 * Rundschrift für Titel und Zahlen (issue #859, S1 von #828, ADR-0027): zwei
 * Font-Rollen statt einer rohen Familie — `--font-ui` (Inter, Fließtext) und
 * `--font-display` (`ui-rounded`/`'SF Pro Rounded'`, Nunito als selbst
 * gehosteter Web-Fallback). Auf CI/Linux-Chromium lösen `ui-rounded` und
 * `'SF Pro Rounded'` nicht auf, also greift dort immer Nunito — genau das
 * macht `--font-display`s Wert (nicht die tatsächlich gerenderte Glyphe) zum
 * verlässlichen, plattformunabhängigen Prüfpunkt (AK3/AK4).
 */

const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';
const GARMIN_SYNC_PATTERN = '**/api/garmin-sync';
const SYNC_COUNTERS = { scanned: 0, created: 0, updated: 0, detailsFilled: 0, mapsFilled: 0 };
// Deckt FIXED_NOW (2026-07-18) ab — dieselbe Woche wie seitenkopf.spec.ts.
const FORECAST_WEEK = [
  '2026-07-15',
  '2026-07-16',
  '2026-07-17',
  '2026-07-18',
  '2026-07-19',
  '2026-07-20',
  '2026-07-21',
];

test.beforeEach(async ({ page }) => {
  await resetAppData();
  await page.route(GARMIN_SYNC_PATTERN, (route) => route.fulfill({ json: SYNC_COUNTERS }));
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

/** Trimmed one-off of aktivitaeten.spec.ts's insertGarminActivity — genug Kopfzahlen. */
async function insertGarminActivity(): Promise<void> {
  const track = {
    n: 5,
    hr: [140, 150, 160, 155, 148],
    speed: [2.6, 2.9, 3.1, 2.8, 2.7],
    elevation: [60, 65, 72, 68, 61],
  };
  await withDb((client) =>
    client.query(
      `INSERT INTO garmin_activities
        (id, updated_at, deleted_at, synced_at, sync_seq, garmin_activity_id, activity_type, name,
         started_at, distance_meters, duration_seconds, elapsed_seconds, elevation_gain, elevation_loss,
         average_hr, max_hr, average_speed, calories, track, map_image, fetched_at)
       VALUES
        ($1, now(), NULL, now(), nextval('sync_seq'), $2, 'running', 'Formsprache-Lauf',
         '2026-07-18T06:30:00Z', 5000, 1750, 1810, 120, 118,
         150, 178, 2.8, 400, $3, NULL, now())`,
      [randomUUID(), Math.floor(Math.random() * 1_000_000_000), JSON.stringify(track)],
    ),
  );
}

/** Rundschrift-Rezept (ADR-0027): dieselben vier Zeilen an jeder AK3-Stelle. */
async function assertDisplayRecipe(locator: Locator, label: string): Promise<void> {
  await expect(locator, label).toBeVisible();
  const { fontFamily, fontWeight, letterSpacing, fontSize } = await locator.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      letterSpacing: style.letterSpacing,
      fontSize: parseFloat(style.fontSize),
    };
  });
  expect(fontFamily.toLowerCase(), `${label}: font-family trägt --font-display`).toMatch(
    /ui-rounded|nunito/,
  );
  expect(fontWeight, `${label}: font-weight 600`).toBe('600');
  expect(parseFloat(letterSpacing), `${label}: letter-spacing -0.025em`).toBeCloseTo(
    -0.025 * fontSize,
    1,
  );
}

/** Gegenprobe zu assertDisplayRecipe: bleibt bei --font-ui (Inter), keine Rundschrift. */
async function assertUiFamily(locator: Locator, label: string): Promise<void> {
  await expect(locator, label).toBeVisible();
  const fontFamily = await locator.evaluate((el) => getComputedStyle(el).fontFamily);
  const lower = fontFamily.toLowerCase();
  expect(lower, `${label}: font-family bleibt Inter`).toContain('inter');
  expect(lower, `${label}: font-family trägt keine Rundschrift`).not.toMatch(/ui-rounded|nunito/);
}

/* -------------------------------------------------------------------------- */
/* AK2 — zwei Rollen als Token                                                */
/* -------------------------------------------------------------------------- */

test('AK2: --font-ui und --font-display sind eigene, unterschiedliche Rollen; body bleibt Inter', async ({
  page,
}) => {
  await registerPasskey(page);

  const { fontUi, fontDisplay, bodyFont } = await page.evaluate(() => {
    const rootStyle = getComputedStyle(document.documentElement);
    return {
      fontUi: rootStyle.getPropertyValue('--font-ui').trim(),
      fontDisplay: rootStyle.getPropertyValue('--font-display').trim(),
      bodyFont: getComputedStyle(document.body).fontFamily,
    };
  });

  expect(fontUi, '--font-ui ist gesetzt').not.toBe('');
  expect(fontDisplay, '--font-display ist gesetzt').not.toBe('');
  expect(fontUi, '--font-ui und --font-display sind verschieden').not.toBe(fontDisplay);
  expect(bodyFont.toLowerCase(), 'body greift --font-ui, nicht die Familie roh').toContain('inter');
});

/* -------------------------------------------------------------------------- */
/* AK3 — die Rundschrift trägt genau diese Stellen                            */
/* -------------------------------------------------------------------------- */

const H1_ROUTES = [
  '/uebersicht',
  '/aufgaben',
  '/kalender',
  '/routinen',
  '/journal',
  '/aktivitaeten',
  '/wetter/2026-07-18',
  '/einstellungen',
];

test('AK3: h1 trägt die Rundschrift auf acht der neun Routen', async ({ page }) => {
  await installClockAt(page, FIXED_NOW);
  await registerPasskey(page);

  for (const path of H1_ROUTES) {
    await page.goto(path);
    await assertDisplayRecipe(page.locator('h1').first(), `h1 auf ${path}`);
  }
});

test.describe('Anmelden (ausgeloggter Kontext)', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('AK3: h1 trägt die Rundschrift auch auf /anmelden', async ({ page }) => {
    await page.goto('/anmelden');
    await assertDisplayRecipe(page.locator('h1').first(), 'h1 auf /anmelden');
  });
});

test('AK3: Kartentitel, FAB, große Zahlen tragen dieselbe Rundschrift', async ({ page }) => {
  await installClockAt(page, FIXED_NOW);
  await registerPasskey(page);

  await page.goto('/einstellungen');
  await assertDisplayRecipe(page.locator('.section-card__title').first(), '.section-card__title');

  await page.goto('/aufgaben');
  await assertDisplayRecipe(page.locator('.fab__icon'), '.fab__icon');

  await seedTask(page, { title: 'Formsprache Ringzahl', dueAt: FIXED_NOW });
  await page.goto('/uebersicht');
  await assertDisplayRecipe(page.locator('.daily-progress-ring__count'), '.daily-progress-ring__count');

  await page.goto('/wetter/2026-07-18');
  await assertDisplayRecipe(page.locator('.weather-day__temp-max'), '.weather-day__temp-max');

  await insertGarminActivity();
  await page.goto('/aktivitaeten');
  await assertDisplayRecipe(
    page.locator('.activity-block__stat dd').first(),
    '.activity-block__stat dd',
  );

  await seedEvent(page, {
    title: 'Formsprache Termin',
    allDay: false,
    startsAt: `${FIXED_NOW.slice(0, 10)}T12:00:00.000Z`,
    endsAt: `${FIXED_NOW.slice(0, 10)}T13:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });
  await page.goto('/kalender');
  await assertDisplayRecipe(page.locator('.event-agenda__item-time').first(), '.event-agenda__item-time');
});

/* -------------------------------------------------------------------------- */
/* AK4 — Fließtext bleibt Inter                                               */
/* -------------------------------------------------------------------------- */

test('AK4: ein Journal-Titel hat die Rundschrift, ein Journal-Absatz nicht', async ({ page }) => {
  await installClockAt(page, FIXED_NOW);
  await registerPasskey(page);
  await page.goto('/journal');

  const passphrase = '859 formsprache passphrase';
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('Passphrase wiederholen').fill(passphrase);
  await page.getByRole('button', { name: 'Einrichten' }).click();
  await page.getByTestId('journal-recovery-key').waitFor();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();

  await page.getByRole('button', { name: 'Eintragen', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Eintragen' });
  await expect(dialog).toBeVisible();
  await page.getByLabel('Journal-Text').fill('Ein ganz normaler Fließtext-Absatz.');
  await dialog.locator('.sheet__action').click();
  await expect(dialog).toBeHidden();

  await assertDisplayRecipe(page.locator('h1', { hasText: 'Journal' }), 'h1 "Journal"');
  await assertUiFamily(page.locator('.journal-editor__entry-text').first(), '.journal-editor__entry-text');
});

/* -------------------------------------------------------------------------- */
/* AK5 — kein externer Font-Request                                          */
/* -------------------------------------------------------------------------- */

test('AK5: kein Request an fonts.gstatic.com/fonts.googleapis.com — die Schrift kommt selbst gehostet', async ({
  page,
}) => {
  const requestUrls: string[] = [];
  page.on('request', (request) => requestUrls.push(request.url()));

  await registerPasskey(page);
  await page.goto('/aufgaben');
  await expect(page.getByRole('heading', { level: 1, name: 'Aufgaben' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  const external = requestUrls.filter(
    (url) => url.includes('fonts.gstatic.com') || url.includes('fonts.googleapis.com'),
  );
  expect(external, 'kein externer Font-Request').toEqual([]);

  const selfHostedFonts = requestUrls.filter(
    (url) => url.includes('/_next/static/media/') && url.endsWith('.woff2'),
  );
  expect(selfHostedFonts.length, 'die Schrift kommt aus /_next/static/media/*.woff2').toBeGreaterThan(0);
});

/* -------------------------------------------------------------------------- */
/* AK6 — kein Layout-Shift beim Schriftwechsel                                */
/* -------------------------------------------------------------------------- */

declare global {
  interface Window {
    __fontShifts: number[];
  }
}

async function installShiftProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__fontShifts = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
      })[]) {
        if (entry.hadRecentInput) continue;
        window.__fontShifts.push(entry.value);
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
}

test('AK6: der Schriftwechsel (Fallback → Nunito via swap) erzeugt keinen Layout-Shift', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  // Anmeldung läuft VOR der Probe-Installation — ihr eigener Seitenwechsel
  // (/anmelden -> /uebersicht) soll die Messung nicht mitzählen (analog
  // tests/uebersicht-ladezustand.spec.ts).
  await registerPasskey(page);

  await installShiftProbe(page);
  await page.goto('/aufgaben');
  await expect(page.getByRole('heading', { level: 1, name: 'Aufgaben' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  const shifts = await page.evaluate(() => window.__fontShifts);
  const total = shifts.reduce((sum, value) => sum + value, 0);
  expect(total).toBe(0);
});
