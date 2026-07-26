import { expect, test, type Page, type Route } from '@playwright/test';
import { registerPasskey, resetAppData, skewClock } from './helpers';

// A Monday (matches weather.spec.ts's NOW, same DAY_SET shape).
const NOW = '2026-07-20T09:00:00.000Z';
const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';
const DATES = ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-25', '2026-07-26'];

// Day index 3 (2026-07-23) carries real precipitation/wind so its detail page has
// something to show; every other day stays dry so the "kein Niederschlag" and
// "kein Regen" paths both get exercised across the suite.
const CODES = [0, 2, 3, 61, 63, 73, 96];
const TEMPS_MAX = [24, 22, 19, 15, 26, 6, 31];
const TEMPS_MIN = [14, 12, 9, 5, 16, -2, 21];
const SUNRISE = '05:53';
const SUNSET = '21:12';
const WIND_SPEED_MAX = [10, 11, 9, 14, 22, 8, 12];
const WIND_GUSTS_MAX = [18, 19, 16, 27, 38, 15, 21];

function hourlyBlock() {
  const time: string[] = [];
  const temperature_2m: number[] = [];
  const precipitation_probability: number[] = [];
  const precipitation: number[] = [];
  DATES.forEach((date, i) => {
    for (let h = 0; h < 24; h += 1) {
      time.push(`${date}T${String(h).padStart(2, '0')}:00`);
      temperature_2m.push(TEMPS_MIN[i] + ((TEMPS_MAX[i] - TEMPS_MIN[i]) * h) / 23);
      // Day 3 (2026-07-23) rains from 14:00 to 16:00 — the one window this suite
      // asserts real precipitation numbers against.
      const raining = i === 3 && h >= 14 && h <= 16;
      precipitation_probability.push(raining ? 80 : 0);
      precipitation.push(raining ? 2.5 : 0);
    }
  });
  return { time, temperature_2m, precipitation_probability, precipitation };
}

function forecastResponseBody() {
  return {
    daily: {
      time: DATES,
      weather_code: CODES,
      temperature_2m_max: TEMPS_MAX,
      temperature_2m_min: TEMPS_MIN,
      precipitation_probability_max: DATES.map((_, i) => (i === 3 ? 80 : 0)),
      sunrise: DATES.map((date) => `${date}T${SUNRISE}`),
      sunset: DATES.map((date) => `${date}T${SUNSET}`),
      wind_speed_10m_max: WIND_SPEED_MAX,
      wind_gusts_10m_max: WIND_GUSTS_MAX,
    },
    hourly: hourlyBlock(),
  };
}

/** Fulfils every Open-Meteo request, counting how often it was actually called. */
async function mockForecast(page: Page): Promise<() => number> {
  let calls = 0;
  await page.route(OPEN_METEO_PATTERN, (route: Route) => {
    calls += 1;
    return route.fulfill({ json: forecastResponseBody() });
  });
  return () => calls;
}

function weatherDays(page: Page) {
  return page.locator('.weather-forecast').getByRole('listitem');
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // Default: abort, same reasoning as weather.spec.ts — the real API is never
  // reachable from this suite (AC "kein eigener Netzaufruf" would be meaningless
  // otherwise). Tests that need data override this via mockForecast().
  await page.route(OPEN_METEO_PATTERN, (route) => route.abort('failed'));
  await registerPasskey(page);
});

/* -------------------------------------------------------------------------- */
/* AK: Tippen auf eine Tagesspalte öffnet /wetter/<datum> mit den Daten dieses Tages */
/* -------------------------------------------------------------------------- */

test('Tippen auf eine Tagesspalte öffnet die Detailseite mit den Daten genau dieses Tages (issue #156 AC1)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);

  // Index 3 = 2026-07-23, the rainy day.
  await weatherDays(page).nth(3).getByRole('link').click();

  await expect(page).toHaveURL('/wetter/2026-07-23');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Donnerstag, 23. Juli');
  await expect(page.locator('.weather-day__temp-max')).toHaveText('15°');
  await expect(page.locator('.weather-day__temp-min')).toHaveText('5°');
});

/* -------------------------------------------------------------------------- */
/* AK: stündlicher Temperaturverlauf über 24 Stunden                          */
/* -------------------------------------------------------------------------- */

test('die Seite zeigt einen stündlichen Temperaturverlauf über 24 Stunden (issue #156 AC2)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await page.goto('/wetter/2026-07-23');

  const points = await page.locator('.weather-day__chart-line').getAttribute('points');
  expect(points?.trim().split(' ')).toHaveLength(24);
  await expect(page.locator('.weather-day__chart')).toHaveAttribute(
    'aria-label',
    'Temperaturverlauf von 5° bis 15°, stündlich',
  );
});

/* -------------------------------------------------------------------------- */
/* AK: Niederschlag, Wind, Sonnenauf- und -untergang sichtbar                 */
/* -------------------------------------------------------------------------- */

test('Niederschlag, Wind sowie Sonnenauf- und -untergang sind sichtbar (issue #156 AC3)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await page.goto('/wetter/2026-07-23');

  await expect(page.locator('.weather-day__precipitation-bars').getByRole('listitem')).toHaveCount(24);
  await expect(page.locator('.weather-day__precipitation-summary')).toHaveText('Insgesamt 7.5 mm');
  await expect(page.getByText('14:00 · 2.5 mm (80%)')).toBeVisible();

  await expect(page.getByText('Geschwindigkeit')).toBeVisible();
  await expect(page.getByText('14 km/h')).toBeVisible();
  await expect(page.getByText('Böen bis')).toBeVisible();
  await expect(page.getByText('27 km/h')).toBeVisible();

  await expect(page.getByText('Aufgang')).toBeVisible();
  await expect(page.getByText(SUNRISE)).toBeVisible();
  await expect(page.getByText('Untergang')).toBeVisible();
  await expect(page.getByText(SUNSET)).toBeVisible();
});

test('ein trockener Tag zeigt "Kein Niederschlag erwartet." statt einer leeren Stundenliste (issue #156 AC3)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await page.goto('/wetter/2026-07-20');

  await expect(page.locator('.weather-day__precipitation-summary')).toHaveText('Kein Niederschlag erwartet.');
  await expect(page.locator('.weather-day__precipitation-hours')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* AK: kein eigener Netzaufruf beim Öffnen der Detailseite                    */
/* -------------------------------------------------------------------------- */

test('die Seite löst keinen eigenen Netzaufruf aus, auch nicht bei einem längst veralteten Stand (issue #156 AC4)', async ({
  page,
}) => {
  const callCount = await mockForecast(page);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);
  expect(callCount()).toBe(1);

  // Deliberately past REFRESH_INTERVAL_MS/isStaleWarning — /uebersicht would
  // trigger a refresh on its own next mount, the day detail page must not.
  await skewClock(page, '2026-07-21T09:00:00.000Z');
  await page.goto('/wetter/2026-07-20');
  await expect(page.locator('.weather-day__temp-max')).toHaveText('24°');
  expect(callCount()).toBe(1);

  await page.reload();
  await expect(page.locator('.weather-day__temp-max')).toHaveText('24°');
  expect(callCount()).toBe(1);
});

/* -------------------------------------------------------------------------- */
/* AK: offline mit dem zuletzt bekannten Stand                                */
/* -------------------------------------------------------------------------- */

test('offline zeigt die Detailseite weiterhin mit dem zuletzt bekannten Stand (issue #156 AC5)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);

  // Cut the network entirely, same reasoning as weather.spec.ts's offline test —
  // a full context.setOffline(true) would also block the dev server's own request.
  await page.unroute(OPEN_METEO_PATTERN);
  await page.route(OPEN_METEO_PATTERN, (route) => route.abort('failed'));
  await skewClock(page, NOW);
  await page.goto('/wetter/2026-07-23');

  await expect(page.locator('.weather-day__temp-max')).toHaveText('15°');
  await expect(page.getByText('14:00 · 2.5 mm (80%)')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* AK: ein Datum ohne Daten führt zu einem erklärenden Zustand                */
/* -------------------------------------------------------------------------- */

test('ein Datum außerhalb der 7-Tage-Vorhersage zeigt einen erklärenden Zustand, keinen Fehler (issue #156 AC6)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);

  await page.goto('/wetter/2026-08-15');

  await expect(page.getByText('Für diesen Tag liegen keine Wetterdaten vor.')).toBeVisible();
  await expect(page.locator('.weather-day__temp-max')).toHaveCount(0);
});

test('ohne jemals gecachte Vorhersage zeigt die Detailseite denselben erklärenden Zustand (issue #156 AC6)', async ({
  page,
}) => {
  await skewClock(page, NOW);
  await page.goto('/wetter/2026-07-20');

  await expect(page.getByText('Für diesen Tag liegen keine Wetterdaten vor.')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* AK: der Weg zurück ist offensichtlich, die Bottom-Navigation bleibt bedienbar */
/* -------------------------------------------------------------------------- */

test('ein Zurück-Weg führt zur Übersicht, die Bottom-Navigation bleibt bedienbar (issue #156 AC7)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await page.goto('/wetter/2026-07-23');

  await expect(page.locator('nav[aria-label="Hauptnavigation"]')).toBeVisible();

  await page.locator('.weather-day__back').click();
  await expect(page).toHaveURL('/uebersicht');
});

/* -------------------------------------------------------------------------- */
/* AK: die Tagesspalte ist als Bedienelement erkennbar und ≥ 44×44 px          */
/* -------------------------------------------------------------------------- */

test('die Tagesspalte ist mindestens 44×44 px groß (issue #156 AC8)', async ({ page }) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);

  const box = await weatherDays(page).first().getByRole('link').boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
});

/* -------------------------------------------------------------------------- */
/* AK: 375px ohne waagerechtes Scrollen (läuft im mobile-Projekt automatisch)  */
/* -------------------------------------------------------------------------- */

test('die Detailseite passt ohne waagerechtes Scrollen (issue #156 AC10)', async ({ page }) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await page.goto('/wetter/2026-07-23');
  await expect(page.locator('.weather-day__temp-max')).toHaveText('15°');

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

/* -------------------------------------------------------------------------- */
/* AK: Semantische Tokens, Dark Mode, prefers-reduced-motion                  */
/* -------------------------------------------------------------------------- */

test('die Kopfzeile nutzt den --surface-Token, auch im Dark Mode (issue #156 AC10)', async ({ page }) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await page.goto('/wetter/2026-07-23');
  await expect(page.locator('.weather-day__temp-max')).toHaveText('15°');

  const card = page.locator('.weather-day__summary');
  const resolveToken = () =>
    page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--surface)';
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });

  const lightBg = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(lightBg).toBe(await resolveToken());

  await page.emulateMedia({ colorScheme: 'dark' });
  const darkBg = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(darkBg).toBe(await resolveToken());
  expect(darkBg).not.toBe(lightBg);
});

// No dedicated reduced-motion test: this page's `loading` state clears within a
// tick (pure IndexedDB read, issue #156) and nothing else here animates, so
// there is nothing a `prefers-reduced-motion: reduce` emulation could observe —
// unlike weather-forecast.css's skeleton, which stays open for as long as its
// gated network mock does.
