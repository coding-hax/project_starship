import { expect, test, type Page, type Route } from '@playwright/test';
import { registerPasskey, resetAppData, skewClock } from './helpers';

// A Monday (issue #139) — matches the weekday labels asserted below.
const NOW = '2026-07-20T09:00:00.000Z';
const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';

interface DaySet {
  dates: string[];
  weekdays: string[];
  codes: number[];
  categories: string[];
  tempsMax: number[];
  tempsMin: number[];
  /** Defaults to 12 km/h for every day — under both isWindy thresholds (issue #695). */
  windSpeedsMax?: number[];
  /** Defaults to 20 km/h for every day — same reasoning as `windSpeedsMax`. */
  windGustsMax?: number[];
  /** Defaults to `tempsMax` for every day (issue #927). */
  apparentTempsMax?: number[];
  /** Degrees, defaults to 270 (West) for every day (issue #927). */
  windDirections?: number[];
}

const DAY_SET_A: DaySet = {
  dates: [
    '2026-07-20',
    '2026-07-21',
    '2026-07-22',
    '2026-07-23',
    '2026-07-24',
    '2026-07-25',
    '2026-07-26',
  ],
  weekdays: ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'],
  codes: [0, 2, 3, 45, 63, 73, 96],
  categories: ['Klar', 'Teils bewölkt', 'Bewölkt', 'Nebel', 'Regen', 'Schnee', 'Gewitter'],
  tempsMax: [24, 22, 19, 15, 26, 6, 31],
  tempsMin: [14, 12, 9, 5, 16, -2, 21],
};

const DAY_SET_B: DaySet = {
  ...DAY_SET_A,
  tempsMax: [10, 10, 10, 10, 10, 10, 10],
  tempsMin: [1, 1, 1, 1, 1, 1, 1],
};

// issue #156: parseForecast also reads `hourly` and a few more `daily` columns
// (sunrise/sunset/wind) — present here so the fixture matches the real response
// shape, even though this suite's own assertions stay on the 7-day strip.
function hourlyBlock(set: DaySet) {
  const time: string[] = [];
  const temperature_2m: number[] = [];
  const precipitation_probability: number[] = [];
  const precipitation: number[] = [];
  const weather_code: number[] = [];
  set.dates.forEach((date, i) => {
    for (let h = 0; h < 24; h += 1) {
      time.push(`${date}T${String(h).padStart(2, '0')}:00`);
      temperature_2m.push(set.tempsMin[i] + ((set.tempsMax[i] - set.tempsMin[i]) * h) / 23);
      precipitation_probability.push(0);
      precipitation.push(0);
      weather_code.push(set.codes[i]);
    }
  });
  return { time, temperature_2m, precipitation_probability, precipitation, weather_code };
}

function forecastResponseBody(set: DaySet) {
  return {
    daily: {
      time: set.dates,
      weather_code: set.codes,
      temperature_2m_max: set.tempsMax,
      temperature_2m_min: set.tempsMin,
      precipitation_probability_max: set.dates.map(() => 0),
      sunrise: set.dates.map((date) => `${date}T05:53`),
      sunset: set.dates.map((date) => `${date}T21:12`),
      wind_speed_10m_max: set.windSpeedsMax ?? set.dates.map(() => 12),
      wind_gusts_10m_max: set.windGustsMax ?? set.dates.map(() => 20),
      apparent_temperature_max: set.apparentTempsMax ?? set.tempsMax,
      wind_direction_10m_dominant: set.windDirections ?? set.dates.map(() => 270),
    },
    hourly: hourlyBlock(set),
  };
}

/** Fulfils every Open-Meteo request with `set`, counting how often it was actually called. */
async function mockForecast(page: Page, set: DaySet): Promise<() => number> {
  let calls = 0;
  await page.route(OPEN_METEO_PATTERN, (route: Route) => {
    calls += 1;
    return route.fulfill({ json: forecastResponseBody(set) });
  });
  return () => calls;
}

function weatherDays(page: Page) {
  return page.locator('.weather-forecast').getByRole('listitem');
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // Default: abort. Tests that need a response override this via mockForecast(),
  // which registers a later route and therefore wins (Playwright: last-registered
  // matching route intercepts first). The real API is never reachable from this
  // suite either way (AC "echte API nie angerufen").
  await page.route(OPEN_METEO_PATTERN, (route) => route.abort('failed'));
  // No target: every test in this file opens with its own goto, so loading
  // /uebersicht here would only be thrown away (issue #1075).
  await registerPasskey(page, null);
});

/* -------------------------------------------------------------------------- */
/* AK: sieben Tage, heute zuerst, je Kürzel/Symbol/Höchst-Tiefstwert           */
/* -------------------------------------------------------------------------- */

test('sieben Tage stehen ganz oben, heute zuerst, je mit Kürzel, Symbol, Höchst- und Tiefstwert (issue #139 AC1)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');

  const days = weatherDays(page);
  await expect(days).toHaveCount(7);

  for (let i = 0; i < 7; i += 1) {
    const day = days.nth(i);
    await expect(day.locator('.weather-forecast__weekday')).toHaveText(DAY_SET_A.weekdays[i]);
    await expect(day.getByRole('img', { name: DAY_SET_A.categories[i] })).toBeVisible();
    await expect(day.locator('.weather-forecast__temp-max')).toHaveText(
      `${DAY_SET_A.tempsMax[i]}°`,
    );
    await expect(day.locator('.weather-forecast__temp-min')).toHaveText(
      `${DAY_SET_A.tempsMin[i]}°`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* AK: Live-Query aus IndexedDB, kein fetch im UI-Pfad                        */
/* -------------------------------------------------------------------------- */

test('nach dem ersten Laden rendert die Ansicht auch ohne erreichbares Netz aus der lokalen Ablage (issue #139 AC2)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);

  // Cut the network entirely and remount the page. If the component read via
  // `fetch` in its render path it would now show the error/empty state; reading
  // from IndexedDB via a live query keeps showing the same forecast.
  await page.unroute(OPEN_METEO_PATTERN);
  await page.route(OPEN_METEO_PATTERN, (route) => route.abort('failed'));
  await skewClock(page, NOW);
  await page.reload();

  await expect(weatherDays(page)).toHaveCount(7);
  await expect(weatherDays(page).first().locator('.weather-forecast__temp-max')).toHaveText('24°');
});

/* -------------------------------------------------------------------------- */
/* AK: 3-Stunden-Fenster steuert, ob ein neuer Netzaufruf ausgelöst wird      */
/* -------------------------------------------------------------------------- */

test('nach mehr als 3 Stunden löst der nächste Aufruf einen neuen Netzaufruf aus, die Anzeige aktualisiert sich (issue #139 AC3)', async ({
  page,
}) => {
  const callCount = await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);
  expect(callCount()).toBe(1);

  await page.unroute(OPEN_METEO_PATTERN);
  await mockForecast(page, DAY_SET_B);
  await skewClock(page, '2026-07-20T12:00:00.000Z'); // exactly 3h later
  await page.reload();

  await expect(weatherDays(page).first().locator('.weather-forecast__temp-max')).toHaveText('10°');
});

/* -------------------------------------------------------------------------- */
/* AK: Antwortet Open-Meteo nicht — letzte Vorhersage bleibt, sonst erklärender Zustand */
/* -------------------------------------------------------------------------- */

test('antwortet Open-Meteo nicht, bleibt die zuletzt bekannte Vorhersage stehen (issue #139 AC5)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);

  await page.unroute(OPEN_METEO_PATTERN);
  await page.route(OPEN_METEO_PATTERN, (route) => route.fulfill({ status: 500, body: 'boom' }));
  await skewClock(page, '2026-07-20T13:00:00.000Z'); // past the 3h window, refresh attempted and fails
  await page.reload();

  await expect(weatherDays(page)).toHaveCount(7);
  await expect(weatherDays(page).first().locator('.weather-forecast__temp-max')).toHaveText('24°');
});
