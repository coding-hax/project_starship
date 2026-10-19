import { expect, test, type Page, type Route } from '@playwright/test';
import { openMeteoForecastBody, registerPasskey, resetAppData } from './helpers';

const GEOCODING_PATTERN = 'https://geocoding-api.open-meteo.com/**';
const FORECAST_PATTERN = 'https://api.open-meteo.com/**';

const BONN = { name: 'Bonn', latitude: 50.7374, longitude: 7.0982 };
const BERLIN = { name: 'Berlin', admin1: 'Berlin', country: 'Deutschland', latitude: 52.52437, longitude: 13.41053 };

const DATES = ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-25', '2026-07-26'];
const CODES = [0, 0, 0, 0, 0, 0, 0];

function forecastBody(tempsMax: number[], tempsMin: number[]) {
  return openMeteoForecastBody({ dates: DATES, weatherCodes: CODES, tempsMax, tempsMin });
}

const BONN_FORECAST = forecastBody([24, 22, 19, 15, 26, 6, 31], [14, 12, 9, 5, 16, -2, 21]);
const BERLIN_FORECAST = forecastBody([10, 10, 10, 10, 10, 10, 10], [1, 1, 1, 1, 1, 1, 1]);

interface GeocodingFixtureResult {
  name: string;
  admin1?: string;
  country?: string;
  latitude: number;
  longitude: number;
}

/** Only responds to the queries in `byQuery` — any other query aborts, same as "no network". */
async function mockGeocoding(page: Page, byQuery: Record<string, GeocodingFixtureResult[]>) {
  await page.route(GEOCODING_PATTERN, (route: Route) => {
    const url = new URL(route.request().url());
    const name = url.searchParams.get('name') ?? '';
    const results = byQuery[name];
    if (results === undefined) return route.abort('failed');
    return route.fulfill({ json: { results } });
  });
}

interface ForecastFixtureEntry {
  latitude: number;
  longitude: number;
  body: ReturnType<typeof forecastBody>;
}

/** Only responds to the exact lat/lon pairs in `entries` — any other coordinate aborts. */
async function mockForecastByLocation(page: Page, entries: ForecastFixtureEntry[]) {
  await page.route(FORECAST_PATTERN, (route: Route) => {
    const url = new URL(route.request().url());
    const latitude = url.searchParams.get('latitude');
    const longitude = url.searchParams.get('longitude');
    const match = entries.find(
      (entry) => String(entry.latitude) === latitude && String(entry.longitude) === longitude,
    );
    if (!match) return route.abort('failed');
    return route.fulfill({ json: match.body });
  });
}

function weatherDays(page: Page) {
  return page.locator('.weather-forecast').getByRole('listitem');
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // Default: abort both Open-Meteo endpoints. Tests register a later, more specific
  // route when they need a response (Playwright: last-registered matching route wins).
  await page.route(GEOCODING_PATTERN, (route) => route.abort('failed'));
  await page.route(FORECAST_PATTERN, (route) => route.abort('failed'));
  // No target: every test in this file opens with its own goto, so loading
  // /uebersicht here would only be thrown away (issue #1075).
  await registerPasskey(page, null);
});

/* -------------------------------------------------------------------------- */
/* AK: Nach Ortswechsel zeigt Übersicht die Werte des neuen Ortes, nicht die alten */
/* -------------------------------------------------------------------------- */

test('nach einem Ortswechsel zeigt Übersicht die Werte des neuen Ortes, die alten sind verworfen (issue #159 AC3/AC4/AC5)', async ({
  page,
}) => {
  await mockForecastByLocation(page, [
    { latitude: BONN.latitude, longitude: BONN.longitude, body: BONN_FORECAST },
  ]);
  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);
  await expect(weatherDays(page).first().locator('.weather-forecast__temp-max')).toHaveText('24°');
  await expect(page.locator('.weather-forecast')).toHaveAttribute(
    'aria-label',
    'Wettervorhersage Bonn, sieben Tage',
  );

  await mockGeocoding(page, { Berlin: [BERLIN] });
  await page.goto('/einstellungen');
  await page.getByLabel('Ort suchen').fill('Berlin');
  await page.getByRole('button', { name: 'Suchen' }).click();
  await page.getByRole('button', { name: 'Berlin, Berlin, Deutschland' }).click();

  await page.unroute(FORECAST_PATTERN);
  await mockForecastByLocation(page, [
    { latitude: BERLIN.latitude, longitude: BERLIN.longitude, body: BERLIN_FORECAST },
  ]);
  await page.goto('/uebersicht');

  await expect(weatherDays(page)).toHaveCount(7);
  await expect(weatherDays(page).first().locator('.weather-forecast__temp-max')).toHaveText('10°');
  // Kein sichtbares Ortslabel mehr im Streifen (issue #973 AK1) — der Ortswechsel
  // schlägt sich stattdessen im `aria-label` der Section nieder.
  await expect(page.locator('.weather-forecast')).toHaveAttribute(
    'aria-label',
    'Wettervorhersage Berlin, sieben Tage',
  );
});
