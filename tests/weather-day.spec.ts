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
// issue #927 — one degree colder than tempMax, so "Gefühlt" is visibly its own
// number rather than an accidental echo of temp-max.
const APPARENT_TEMPS_MAX = TEMPS_MAX.map((value) => value - 1);
// West for every day (issue #927) — matches the ticket's own "12 km/h · West" example.
const WIND_DIRECTIONS = DATES.map(() => 270);

function hourlyBlock(includeWeatherCode = true) {
  const time: string[] = [];
  const temperature_2m: number[] = [];
  const precipitation_probability: number[] = [];
  const precipitation: number[] = [];
  const weather_code: number[] = [];
  DATES.forEach((date, i) => {
    for (let h = 0; h < 24; h += 1) {
      time.push(`${date}T${String(h).padStart(2, '0')}:00`);
      temperature_2m.push(TEMPS_MIN[i] + ((TEMPS_MAX[i] - TEMPS_MIN[i]) * h) / 23);
      // Day 3 (2026-07-23) rains from 14:00 to 16:00 — the one window this suite
      // asserts real precipitation numbers against.
      const raining = i === 3 && h >= 14 && h <= 16;
      precipitation_probability.push(raining ? 80 : 0);
      precipitation.push(raining ? 2.5 : 0);
      weather_code.push(CODES[i]);
    }
  });
  return includeWeatherCode
    ? { time, temperature_2m, precipitation_probability, precipitation, weather_code }
    : { time, temperature_2m, precipitation_probability, precipitation };
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
      apparent_temperature_max: APPARENT_TEMPS_MAX,
      wind_direction_10m_dominant: WIND_DIRECTIONS,
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

/**
 * Drives the same Pointer Events the swipe container listens to (issue #267) —
 * same reasoning as tasks.spec.ts's own swipeLeft/swipeRight, just against the
 * whole day-detail screen instead of a single list row. `verticalDriftPx` lets
 * a test dial in a mostly-vertical gesture (AC4) without a second helper.
 */
async function swipeLeft(page: Page, distancePx: number, verticalDriftPx = 0) {
  const container = page.locator('.weather-day-screen');
  const box = (await container.boundingBox())!;
  const clientY = box.y + box.height / 2;
  const startX = box.x + box.width - 20;

  await container.dispatchEvent('pointerdown', {
    pointerId: 1,
    clientX: startX,
    clientY,
    button: 0,
    bubbles: true,
  });
  await container.dispatchEvent('pointermove', {
    pointerId: 1,
    clientX: startX - distancePx,
    clientY: clientY + verticalDriftPx,
    bubbles: true,
  });
  await container.dispatchEvent('pointerup', {
    pointerId: 1,
    clientX: startX - distancePx,
    clientY: clientY + verticalDriftPx,
    bubbles: true,
  });
}

/**
 * Loads /uebersicht once so the overview strip's refresh fills the cache.
 *
 * Every test that navigates straight to `/wetter/<datum>` needs this first: the
 * detail page deliberately has no refresh trigger of its own (AC4), so the strip
 * is the only thing that ever writes the cache. `registerPasskey` in `beforeEach`
 * does land on /uebersicht, but that happens while the default `abort('failed')`
 * route is still in place — that visit only ever produces a failed refresh.
 * Without warming, those pages are legitimately in their no-data state, which is
 * its own assertion further down ("ohne jemals gecachte Vorhersage").
 *
 * Call after `skewClock`, never before: `refreshIfStale` stamps `fetchedAt` from
 * the page clock, and the staleness assertions downstream count on that being the
 * pinned time rather than the wall clock.
 */
async function warmForecastCache(page: Page) {
  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);
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
  await expect(page.locator('.weather-day__date')).toHaveText('Donnerstag, 23. Juli');
  await expect(page.locator('.weather-day__temp-max')).toHaveText('15°');
  // Nachtwert (issue #269), nicht mehr der Tages-Tiefstwert (der wäre 5°) — dass er
  // hier zufällig auf denselben Wert wie der Höchstwert rundet, ist Zufall der
  // linearen Testkurve (00:00 = Tagesminimum, 23:00 = Tagesmaximum je Tag); die
  // dedizierten Tests unten in "issue #269" wählen Tage, an denen sich Höchst-,
  // Tages-Tiefst- und Nachtwert klar unterscheiden.
  await expect(page.locator('.weather-day__temp-min')).toHaveText('15°');
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
  await expect(page.locator('.weather-day__precipitation-total')).toHaveText('Insgesamt 7.5 mm');
});

/* -------------------------------------------------------------------------- */
/* AK: Wisch nach links/rechts wechselt den Tag (issue #267)                  */
/* -------------------------------------------------------------------------- */

test('Wisch nach links zeigt den nächsten Tag, Inhalt und Datumskopfzeile wechseln mit (issue #267 AC1)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');
  await expect(page.locator('.weather-day__temp-max')).toHaveText('15°');

  await swipeLeft(page, 120);

  await expect(page).toHaveURL('/wetter/2026-07-24');
  await expect(page.locator('.weather-day__date')).toHaveText('Freitag, 24. Juli');
  await expect(page.locator('.weather-day__temp-max')).toHaveText('26°');
  // Nachtwert (issue #269): das Fenster reicht bis in die Frühstunden des 25. Juli
  // hinein, dessen Tagesminimum (-2°) weit unter dem 24.7. eigenem Tiefstwert
  // (16°) liegt — zeigt, dass der Kopf beim Tageswechsel wirklich neu rechnet.
  await expect(page.locator('.weather-day__temp-min')).toHaveText('-2°');
});
