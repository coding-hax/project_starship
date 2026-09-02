import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
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

// issue #927 AC2 — a cache row written before this ticket: none of the three new
// columns exist at all, not even as an empty array.
function legacyForecastResponseBody() {
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
    hourly: hourlyBlock(false),
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

/** Same as `mockForecast`, but the response predates issue #927's three columns. */
async function mockLegacyForecast(page: Page): Promise<() => number> {
  let calls = 0;
  await page.route(OPEN_METEO_PATTERN, (route: Route) => {
    calls += 1;
    return route.fulfill({ json: legacyForecastResponseBody() });
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

/** Same as `swipeLeft`, other direction. */
async function swipeRight(page: Page, distancePx: number, verticalDriftPx = 0) {
  const container = page.locator('.weather-day-screen');
  const box = (await container.boundingBox())!;
  const clientY = box.y + box.height / 2;
  const startX = box.x + 20;

  await container.dispatchEvent('pointerdown', {
    pointerId: 1,
    clientX: startX,
    clientY,
    button: 0,
    bubbles: true,
  });
  await container.dispatchEvent('pointermove', {
    pointerId: 1,
    clientX: startX + distancePx,
    clientY: clientY + verticalDriftPx,
    bubbles: true,
  });
  await container.dispatchEvent('pointerup', {
    pointerId: 1,
    clientX: startX + distancePx,
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
/* AK: stündlicher Temperaturverlauf über 24 Stunden                          */
/* -------------------------------------------------------------------------- */

test('die Seite zeigt einen stündlichen Temperaturverlauf über 24 Stunden (issue #156 AC2)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  const d = await page.locator('.weather-day__chart-line').getAttribute('d');
  expect(d?.startsWith('M')).toBe(true);
  expect(d?.match(/C/g)).toHaveLength(23);
  await expect(page.locator('.weather-day__chart')).toHaveAttribute(
    'aria-label',
    'Temperaturverlauf von 5° bis 15°, stündlich',
  );

  const areaD = await page.locator('.weather-day__chart-area').getAttribute('d');
  expect(areaD?.endsWith('Z')).toBe(true);
});

/* -------------------------------------------------------------------------- */
/* AK3: Jetzt-Punkt auf der Temperaturkurve, nur am heutigen Tag              */
/* -------------------------------------------------------------------------- */

test('am heutigen Tag zeigt die Kurve einen Jetzt-Punkt mit Temperatur-Beschriftung (issue #939 AK3)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW); // 2026-07-20T09:00Z = 11:00 Berlin.
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-20');

  await expect(page.locator('.weather-day__now-dot')).toHaveCount(1);
  // TEMPS_MIN[0]=14, TEMPS_MAX[0]=24 -> 14 + 10*11/23 ≈ 18.8 -> 19°.
  await expect(page.locator('.weather-day__now-label')).toHaveText('19°');

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('an einem anderen Tag als heute entfällt der Jetzt-Punkt (issue #939 AK3)', async ({ page }) => {
  await mockForecast(page);
  await skewClock(page, NOW); // heute = 2026-07-20.
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  await expect(page.locator('.weather-day__now-dot')).toHaveCount(0);
  await expect(page.locator('.weather-day__now-label')).toHaveCount(0);
});

test('Flächenverlauf und Jetzt-Punkt laufen nie dauerhaft, unabhängig von reduzierter Bewegung (issue #939 AK6)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW); // 2026-07-20T09:00Z = 11:00 Berlin.
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-20');
  await expect(page.locator('.weather-day__now-dot')).toHaveCount(1);

  const animationName = (locator: Locator) =>
    locator.evaluate((el) => getComputedStyle(el).animationName);
  expect(await animationName(page.locator('.weather-day__chart-area'))).toBe('none');
  expect(await animationName(page.locator('.weather-day__now-dot'))).toBe('none');
});

/* -------------------------------------------------------------------------- */
/* AK: Höchst- und Tiefstwert der Temperaturkurve tragen ihren Wert           */
/* (issue #998 AK12-AK18)                                                     */
/* -------------------------------------------------------------------------- */

test('die Temperaturkurve beschriftet ihren eigenen höchsten und tiefsten Punkt, nicht die Tagesaggregate (issue #998 AK12/AK13)', async ({
  page,
}) => {
  const body = forecastResponseBody();
  const dayIndex = 3; // 2026-07-23
  const dateOffset = dayIndex * 24;
  // Weit über/unter dem Tagesaggregat (TEMPS_MAX[3]=15, TEMPS_MIN[3]=5) — die
  // Beschriftung muss der gezeichneten Kurve (day.hours) folgen, nicht
  // day.tempMax/day.tempMin.
  body.hourly.temperature_2m[dateOffset + 12] = 30;
  body.hourly.temperature_2m[dateOffset + 2] = -5;
  await page.route(OPEN_METEO_PATTERN, (route) => route.fulfill({ json: body }));
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  const labels = page.locator('.weather-day__extreme-label');
  await expect(labels).toHaveText(['30°', '-5°']);
  await expect(labels.first()).toHaveAttribute('aria-hidden', 'true');
});

test('bei Gleichstand des Höchstwerts trägt die früheste Stunde die Beschriftung (issue #998 AK14)', async ({
  page,
}) => {
  const body = forecastResponseBody();
  const dayIndex = 3;
  const dateOffset = dayIndex * 24;
  body.hourly.temperature_2m[dateOffset + 5] = 25;
  body.hourly.temperature_2m[dateOffset + 20] = 25; // gleicher Höchstwert, spätere Stunde
  await page.route(OPEN_METEO_PATTERN, (route) => route.fulfill({ json: body }));
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  const maxLabel = page.locator('.weather-day__extreme-label').first();
  await expect(maxLabel).toHaveText('25°');
  const x = await maxLabel.evaluate((el) => Number(el.getAttribute('x')));
  expect(x).toBeCloseTo((5 / 24) * 320, 1); // Stunde 5, nicht Stunde 20.
});

test('an einem flachen Tag mit gleicher Höchst- und Tiefsttemperatur steht nur eine Beschriftung (issue #998 AK14)', async ({
  page,
}) => {
  const body = forecastResponseBody();
  const dayIndex = 3;
  const dateOffset = dayIndex * 24;
  for (let h = 0; h < 24; h += 1) {
    body.hourly.temperature_2m[dateOffset + h] = 18;
  }
  await page.route(OPEN_METEO_PATTERN, (route) => route.fulfill({ json: body }));
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  await expect(page.locator('.weather-day__extreme-label')).toHaveCount(1);
  await expect(page.locator('.weather-day__extreme-label')).toHaveText('18°');
});

test('fällt der Jetzt-Punkt mit dem Höchstwert zusammen, erscheint der Wert nur einmal (issue #998 AK15)', async ({
  page,
}) => {
  const body = forecastResponseBody();
  // Tag 0 = 2026-07-20 = "heute" unter NOW (11:00 Berlin) — Stunde 11 wird zum
  // Tageshöchstwert gemacht, genau am Jetzt-Punkt.
  body.hourly.temperature_2m[11] = 40;
  await page.route(OPEN_METEO_PATTERN, (route) => route.fulfill({ json: body }));
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-20');

  await expect(page.locator('.weather-day__now-label')).toHaveText('40°');
  // Nur der Tiefstwert bekommt noch eine eigene Beschriftung — der Höchstwert
  // fällt mit dem Jetzt-Punkt zusammen und wird nicht doppelt gezeichnet.
  await expect(page.locator('.weather-day__extreme-label')).toHaveCount(1);
});

test('liegt ein Extremwert auf Stunde 0 oder 23, bleibt die Beschriftung innerhalb der Karte (issue #998 AK16)', async ({
  page,
}) => {
  const body = forecastResponseBody();
  const dayIndex = 3;
  const dateOffset = dayIndex * 24;
  body.hourly.temperature_2m[dateOffset + 0] = 30; // Stunde 0 -> neuer Höchstwert
  body.hourly.temperature_2m[dateOffset + 23] = -10; // Stunde 23 -> neuer Tiefstwert
  await page.route(OPEN_METEO_PATTERN, (route) => route.fulfill({ json: body }));
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  const card = page.locator('.weather-day__card', { hasText: 'Tagesverlauf' });
  const cardBox = await card.boundingBox();
  const labels = page.locator('.weather-day__extreme-label');
  await expect(labels).toHaveCount(2);
  // Linksbündig am linken, rechtsbündig am rechten Rand (wie die Stundenachse
  // selbst, issue #998 AK3) statt mittig über den Rand hinauszuragen.
  await expect(labels.first()).toHaveAttribute('text-anchor', 'start');
  await expect(labels.last()).toHaveAttribute('text-anchor', 'end');
  for (const label of await labels.all()) {
    const box = await label.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(cardBox!.x - 0.5);
    expect(box!.x + box!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 0.5);
  }
});

test('die Extremwert-Beschriftungen sind optisch schwächer als der Jetzt-Punkt, ohne eigenen Punkt-Marker (issue #998 AK17)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-20');

  // Nur der Jetzt-Punkt bekommt einen gefüllten Kreis mit Ring — die
  // Extremwerte bleiben reiner Text, kein eigener Marker.
  await expect(page.locator('.weather-day__now-dot')).toHaveCount(1);
  await expect(page.locator('.weather-day__chart circle')).toHaveCount(1);

  const extremeColor = await page
    .locator('.weather-day__extreme-label')
    .first()
    .evaluate((el) => getComputedStyle(el).fill);
  const nowColor = await page.locator('.weather-day__now-label').evaluate((el) => getComputedStyle(el).fill);
  expect(extremeColor).not.toBe(nowColor);
});

/* -------------------------------------------------------------------------- */
/* AK: Niederschlag, Wind, Sonnenauf- und -untergang sichtbar                 */
/* -------------------------------------------------------------------------- */

test('Niederschlag, Wind sowie Sonnenauf- und -untergang sind sichtbar (issue #156 AC3)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  await expect(page.locator('.weather-day__precipitation-bar')).toHaveCount(24);
  await expect(page.locator('.weather-day__precipitation-total')).toHaveText('Insgesamt 7.5 mm');
  await expect(page.locator('.weather-day__precipitation-chart')).toHaveAttribute(
    'aria-label',
    'Regenwahrscheinlichkeit je Stunde, höchstens 80 %',
  );

  await expect(page.getByText('Wind', { exact: true })).toBeVisible();
  await expect(page.getByText('14 km/h')).toBeVisible();
  await expect(page.getByText('Böen', { exact: true })).toBeVisible();
  await expect(page.getByText('27 km/h')).toBeVisible();

  await expect(page.getByText('Aufgang')).toBeVisible();
  await expect(page.getByText(SUNRISE)).toBeVisible();
  await expect(page.getByText('Untergang')).toBeVisible();
  await expect(page.getByText(SUNSET)).toBeVisible();

  // Spitzenwert beschriftet (issue #998 AK5) — Stunden 14/15/16 sind zu gleichen
  // Teilen die höchste Wahrscheinlichkeit des Tages (80 %), die früheste der
  // drei trägt die Beschriftung (AK6).
  const peakLabel = page.locator('.weather-day__precip-peak-label');
  await expect(peakLabel).toHaveCount(1);
  await expect(peakLabel).toHaveText('80 %');
  const bar14 = page.locator('.weather-day__precipitation-bar').nth(14);
  const [peakX, bar14CentreX] = await Promise.all([
    peakLabel.evaluate((el) => Number(el.getAttribute('x'))),
    bar14.evaluate((el) => Number(el.getAttribute('x')) + Number(el.getAttribute('width')) / 2),
  ]);
  expect(peakX).toBeCloseTo(bar14CentreX, 1);
});

test('ein trockener Tag zeigt "Kein Niederschlag erwartet." und ein leeres Balkenfeld (issue #156 AC3)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-20');

  await expect(page.locator('.weather-day__precipitation-total')).toHaveText('Kein Niederschlag erwartet.');
  await expect(page.locator('.weather-day__precipitation-chart')).toHaveAttribute(
    'aria-label',
    'Regenwahrscheinlichkeit je Stunde, höchstens 0 %',
  );
  // Die Achse steht weiterhin da, nur ohne Ausschlag — kein Balken hat Höhe.
  const heights = await page
    .locator('.weather-day__precipitation-bar')
    .evaluateAll((bars) => bars.map((bar) => Number(bar.getAttribute('height'))));
  expect(heights).toHaveLength(24);
  expect(heights.every((height) => height === 0)).toBe(true);

  // Keine Beschriftung über einer leeren Grundlinie (issue #998 AK7).
  await expect(page.locator('.weather-day__precip-peak-label')).toHaveCount(0);
});

test('die Niederschlagssumme steht im Kartenkopf-Slot, nicht mehr als eigener Absatz, die Balken sind abgerundet (issue #938 AK5)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  await expect(
    page.locator('.section-card__head .weather-day__precipitation-total'),
  ).toHaveText('Insgesamt 7.5 mm');

  const radii = await page
    .locator('.weather-day__precipitation-bar')
    .evaluateAll((bars) => bars.map((bar) => Number(bar.getAttribute('rx'))));
  expect(radii.length).toBeGreaterThan(0);
  expect(radii.every((rx) => rx > 0)).toBe(true);
});

test('bei 100 % Regenwahrscheinlichkeit bleibt die Spitzenwert-Beschriftung innerhalb der Karte, im Rezept des Jetzt-Werts, für Vorleser verborgen (issue #998 AK8/AK9/AK11)', async ({
  page,
}) => {
  const body = forecastResponseBody();
  const dayIndex = 3; // 2026-07-23
  const dateOffset = dayIndex * 24;
  body.hourly.precipitation_probability[dateOffset + 15] = 100;
  await page.route(OPEN_METEO_PATTERN, (route) => route.fulfill({ json: body }));
  // "Heute" = derselbe Tag, damit Jetzt-Punkt und Spitzenwert-Beschriftung
  // gleichzeitig existieren und ihr Rezept verglichen werden kann.
  await skewClock(page, '2026-07-23T09:00:00.000Z');
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  const peakLabel = page.locator('.weather-day__precip-peak-label');
  await expect(peakLabel).toHaveText('100 %');
  // Verborgen für Screenreader (AK11) — das aria-label des Diagramms nennt den
  // Höchstwert bereits selbst ("höchstens 100 %").
  await expect(peakLabel).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('.weather-day__precipitation-chart')).toHaveAttribute(
    'aria-label',
    'Regenwahrscheinlichkeit je Stunde, höchstens 100 %',
  );

  // Auch bei vollem Balken bleibt die Beschriftung oberhalb nicht abgeschnitten
  // und ragt nicht in den Kartenkopf (AK8): ihre Oberkante bleibt unterhalb der
  // Oberkante der Karte.
  const card = page.locator('.weather-day__card', { hasText: 'Niederschlag' });
  const cardBox = await card.boundingBox();
  const labelBox = await peakLabel.boundingBox();
  expect(labelBox!.y).toBeGreaterThanOrEqual(cardBox!.y);

  // Optisch dasselbe Rezept wie der Jetzt-Wert der Temperaturkurve (AK9).
  const style = (locator: Locator) =>
    locator.evaluate((el) => {
      const computed = getComputedStyle(el);
      return {
        fill: computed.fill,
        fontSize: computed.fontSize,
        fontVariantNumeric: computed.fontVariantNumeric,
        textAnchor: computed.textAnchor,
      };
    });
  expect(await style(peakLabel)).toEqual(await style(page.locator('.weather-day__now-label')));
});

/* -------------------------------------------------------------------------- */
/* AK: beide Diagramme nutzen die volle Zeichenfläche, kein linker Zwischenraum */
/* (issue #998 AK1)                                                            */
/* -------------------------------------------------------------------------- */

test('Temperaturkurve und Niederschlagsbalken nutzen die volle Zeichenfläche, kein linker Zwischenraum mehr (issue #998 AK1)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  // Die Achse beider Diagramme reicht von der linken bis zur rechten Kante der
  // 320 Einheiten breiten viewBox — der frühere 38-Einheiten-Zwischenraum links
  // (einst für y-Beschriftungen, seit #939 AK4 nicht mehr vorhanden) ist weg.
  for (const selector of ['.weather-day__chart', '.weather-day__precipitation-chart']) {
    const axis = page.locator(`${selector} .weather-day__chart-axis`);
    await expect(axis).toHaveAttribute('x1', '0');
    await expect(axis).toHaveAttribute('x2', '320');
  }
});

/* -------------------------------------------------------------------------- */
/* Achsenbeschriftung beider Diagramme                                        */
/* -------------------------------------------------------------------------- */

test('beide Diagramme haben beschriftete Achsen, die Stundenachse reicht bis 24:00, gleichmäßig verteilt (issue #795, ohne y-Gitter seit #939 AK4)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  // Kein y-Gitter/-Label mehr (issue #939 AK4) — nur die Stundenachse bleibt.
  await expect(page.locator('.weather-day__chart .weather-day__chart-tick')).toHaveText([
    '00:00',
    '06:00',
    '12:00',
    '18:00',
    '24:00',
  ]);
  await expect(page.locator('.weather-day__precipitation-chart .weather-day__chart-tick')).toHaveText([
    '00:00',
    '06:00',
    '12:00',
    '18:00',
    '24:00',
  ]);
  await expect(page.locator('.weather-day__chart .weather-day__chart-grid')).toHaveCount(0);
  await expect(page.locator('.weather-day__precipitation-chart .weather-day__chart-grid')).toHaveCount(0);

  // Der gemeldete Fehler: die letzten beiden Uhrzeiten saßen enger zusammen als
  // der Rest, weil die Achse die Stunden 0..23 statt 0..24 abbildete. Jetzt
  // müssen alle vier Lücken zwischen den fünf Stundenlabels gleich breit sein —
  // für beide Diagramme, die sich dasselbe Stundenraster teilen. Geprüft wird
  // die `x`-Koordinate im SVG-Viewport, nicht die gerenderte Bounding-Box: das
  // letzte Label ist absichtlich rechtsbündig verankert (sonst liefe es über
  // den Rand hinaus), was seine Glyphen-Box gegenüber ihrer wahren Tick-Position
  // verschiebt, ohne dass die Achse selbst ungleichmäßig wäre.
  const xsBySelector: number[][] = [];
  for (const selector of ['.weather-day__chart', '.weather-day__precipitation-chart']) {
    const ticks = page.locator(`${selector} .weather-day__chart-tick`, {
      hasText: /^\d{2}:00$/,
    });
    const xs = await ticks.evaluateAll((elements) =>
      elements.map((element) => Number(element.getAttribute('x'))),
    );
    expect(xs).toHaveLength(5);
    const gaps = xs.slice(1).map((x, i) => x - xs[i]);
    for (const gap of gaps) {
      expect(Math.abs(gap - gaps[0])).toBeLessThan(0.01);
    }
    xsBySelector.push(xs);

    // Erste Beschriftung linksbündig, letzte rechtsbündig (issue #998 AK3) —
    // beide bleiben dadurch innerhalb der Kartenkante statt über sie hinauszuragen.
    await expect(ticks.first()).toHaveAttribute('text-anchor', 'start');
    await expect(ticks.last()).toHaveAttribute('text-anchor', 'end');
  }
  // Beide Diagramme teilen sich dasselbe Stundenraster (issue #998 AK2) — Stunde
  // n sitzt in Kurve und Balken an genau derselben x-Koordinate.
  expect(xsBySelector[0]).toEqual(xsBySelector[1]);
});

test('die Diagramm-Karten sind kompakter gepolstert als die Standard-SectionCard (issue #288 AC2)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  const expectedPadding = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--space-3').trim(),
  );
  const paddings = await page
    .locator('.weather-day__card')
    .evaluateAll((cards) => cards.map((card) => getComputedStyle(card).paddingTop));
  expect(paddings).toHaveLength(2);
  for (const padding of paddings) {
    expect(padding).toBe(expectedPadding);
  }
});

test('der Abstand zwischen Tagesverlauf- und Niederschlags-Box ist genauso klein wie der zur Werte-Karte darunter (issue #381)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  const [tagesverlauf, niederschlag] = await page.locator('.weather-day__card').all();
  const tagesverlaufBox = await tagesverlauf.boundingBox();
  const niederschlagBox = await niederschlag.boundingBox();
  const values = await page.locator('.weather-day__values').boundingBox();

  const gapBetweenCharts = niederschlagBox!.y - (tagesverlaufBox!.y + tagesverlaufBox!.height);
  const gapToValues = values!.y - (niederschlagBox!.y + niederschlagBox!.height);

  expect(Math.abs(gapToValues - gapBetweenCharts)).toBeLessThanOrEqual(0.5);
});

test('die Überschriften „Tagesverlauf" und „Niederschlag" sitzen dicht unter der Oberkante ihrer Box', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  // Über der Überschrift darf nur das Kartenpolster stehen — nicht zusätzlich die
  // globale h2-Marge (--space-6), die den Titel früher ~24px nach unten schob.
  const padding = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-3')),
  );

  for (const title of ['Tagesverlauf', 'Niederschlag']) {
    const card = page.locator('.weather-day__card', { hasText: title });
    const cardBox = await card.boundingBox();
    const titleBox = await card.getByRole('heading', { name: title }).boundingBox();
    expect(titleBox!.y - cardBox!.y).toBeLessThanOrEqual(padding + 0.5);
  }
});

test('die Kopfzeile sitzt dicht über der ersten Box, nicht mit großem Spalt (issue #344)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  const maxMarginPx = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-2')),
  );
  const marginBottom = await page
    .locator('.weather-day__topbar')
    .evaluate((el) => parseFloat(getComputedStyle(el).marginBottom));
  expect(marginBottom).toBeLessThanOrEqual(maxMarginPx);
});

test('der Spalt zwischen Kopfzeile und Box ist nach #353 noch kleiner als nach #344', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  const maxGapPx = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-1')),
  );
  // Seit issue #870 (T3) ist der Kopf drei Zonen hoch (Augenbraue/Titel/Zusatz)
  // statt einer flachen Zeile — der Zurück-Link sitzt jetzt oben, nicht mehr am
  // unteren Rand des Kopfes. Der Spalt gilt deshalb dem ganzen Kopf-Container,
  // nicht mehr nur dem Zurück-Link (dessen eigenes margin-bottom das Maß trägt).
  const topbar = await page.locator('.weather-day__topbar').boundingBox();
  const firstCard = await page.locator('.weather-day__card').first().boundingBox();
  const gap = firstCard!.y - topbar!.y - topbar!.height;
  expect(gap).toBeLessThanOrEqual(maxGapPx);
});

/* -------------------------------------------------------------------------- */
/* AK: Werte-Karte (Wind/Böen/Aufgang/Untergang) steht als letzte Karte der    */
/* Seite (issue #938 AK1)                                                     */
/* -------------------------------------------------------------------------- */

test('die Werte-Karte mit Wind, Böen, Aufgang und Untergang steht als letzte Karte der Seite (issue #938 AK1)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  const cards = page.locator('.weather-day > .weather-day__card, .weather-day > .weather-day__values');
  await expect(cards).toHaveCount(3);
  await expect(cards.last()).toHaveClass(/weather-day__values/);

  // <dl>-Semantik bleibt erhalten (AK1) — kein div-Ersatz.
  await expect(page.locator('.weather-day__values dl.weather-day__stats')).toHaveCount(1);
  await expect(page.locator('.weather-day__values dl.weather-day__stats > div')).toHaveCount(4);
  for (const row of await page.locator('.weather-day__values .weather-day__stat').all()) {
    await expect(row.locator('> dt')).toHaveCount(1);
    await expect(row.locator('> dd')).toHaveCount(1);
  }

  // Böen bleiben erhalten (#861 AK4) — die App kennt sie, das Blatt nicht.
  await expect(page.getByText('Böen', { exact: true })).toBeVisible();
  await expect(page.getByText('27 km/h')).toBeVisible();

  // Label gedämpft links, Wert fett rechts, in derselben Zeile.
  const row = page.locator('.weather-day__stat', { hasText: 'Wind' });
  const dt = await row.locator('dt').boundingBox();
  const dd = await row.locator('dd').boundingBox();
  expect(dt!.x).toBeLessThan(dd!.x);
});

/* -------------------------------------------------------------------------- */
/* AK: die Zusammenfassungs-Kachel entfällt, Nachtwert + Fallback bleiben     */
/* erhalten (issue #938 AK2)                                                  */
/* -------------------------------------------------------------------------- */

test('die alte Zusammenfassungs-Kachel ist weg, der Nachtwert mit Mond, aria-Label und Fallback bleibt erhalten (issue #938 AK2)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);

  // 2026-07-22: eigener Nachtwert mit Mond + aria-Label (issue #269 AC1).
  await page.goto('/wetter/2026-07-22');
  await expect(page.locator('.weather-day__summary')).toHaveCount(0);
  await expect(page.locator('.weather-day__temp-min')).toHaveText('5°');
  await expect(page.locator('.weather-day__temp-min')).toHaveAttribute(
    'aria-label',
    'nachts, 21:12 bis 05:53: 5 Grad',
  );
  await expect(page.locator('.weather-day__temp-min svg')).toHaveCount(1);

  // Letzter Vorhersagetag: Tiefstwert-Fallback statt Mond (issue #269 AC3).
  await page.goto('/wetter/2026-07-26');
  await expect(page.locator('.weather-day__summary')).toHaveCount(0);
  await expect(page.locator('.weather-day__temp-fallback-label')).toHaveText('Tiefstwert');
  await expect(page.locator('.weather-day__temp-min')).toHaveText('21°');
  await expect(page.locator('.weather-day__temp-min svg')).toHaveCount(0);
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

test('offline zeigt Kurve und Jetzt-Punkt weiterhin, ganz aus der Ablage (issue #939 AK7)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW); // 2026-07-20T09:00Z = 11:00 Berlin.
  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);

  // Netz komplett kappen, wie im Offline-Test oben — der Jetzt-Punkt muss
  // trotzdem aus dem Dexie-Cache entstehen, kein eigener Netzaufruf.
  await page.unroute(OPEN_METEO_PATTERN);
  await page.route(OPEN_METEO_PATTERN, (route) => route.abort('failed'));
  await skewClock(page, NOW);
  await page.goto('/wetter/2026-07-20');

  const d = await page.locator('.weather-day__chart-line').getAttribute('d');
  expect(d?.startsWith('M')).toBe(true);
  await expect(page.locator('.weather-day__now-dot')).toHaveCount(1);
  await expect(page.locator('.weather-day__now-label')).toHaveText('19°');
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
  await expect(page.locator('.weather-day__back')).toHaveText('Übersicht');

  await page.locator('.weather-day__back').click();
  await expect(page).toHaveURL('/uebersicht');
});

test('nach dem Öffnen aus der Übersicht liegt kein Fokusring auf dem Zurück-Link', async ({ page }) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);

  await weatherDays(page).nth(3).getByRole('link').click();
  await expect(page.locator('.weather-day__back')).toBeVisible();

  // Der App-Router fokussiert nach der Navigation das erste Element des neuen
  // Segments. Solange das der Zurück-Link war, blieb dessen Akzent-Fokusring
  // stehen, bis irgendwo anders hin geklickt wurde.
  await expect(page.locator('.weather-day__back')).not.toBeFocused();
  const focusRing = await page
    .locator('.weather-day__back')
    .evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(focusRing).toBe('none');
});

test('das Datum steht oben rechts auf Höhe des Zurück-Links (issue #156 AC7)', async ({ page }) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  const back = await page.locator('.weather-day__back').boundingBox();
  const date = await page.locator('.weather-day__date').boundingBox();
  expect(date!.x).toBeGreaterThan(back!.x + back!.width);
  // „auf gleicher Höhe" heißt: die Mitten liegen übereinander, nicht untereinander.
  expect(Math.abs(date!.y + date!.height / 2 - (back!.y + back!.height / 2))).toBeLessThan(8);
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
  await warmForecastCache(page);
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
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');
  await expect(page.locator('.weather-day__temp-max')).toHaveText('15°');

  const card = page.locator('.weather-day__values');
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

test('Wisch nach rechts zeigt den vorherigen Tag (issue #267 AC1)', async ({ page }) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');
  await expect(page.locator('.weather-day__temp-max')).toHaveText('15°');

  await swipeRight(page, 120);

  await expect(page).toHaveURL('/wetter/2026-07-22');
  await expect(page.locator('.weather-day__date')).toHaveText('Mittwoch, 22. Juli');
  await expect(page.locator('.weather-day__temp-max')).toHaveText('19°');
});

/* -------------------------------------------------------------------------- */
/* AK: die URL wechselt mit, Browser-Zurück führt zum vorher gezeigten Tag     */
/* -------------------------------------------------------------------------- */

test('der Browser-Zurück-Schritt führt zurück auf den vorher gezeigten Tag (issue #267 AC2)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  await swipeLeft(page, 120);
  await expect(page).toHaveURL('/wetter/2026-07-24');

  await page.goBack();

  await expect(page).toHaveURL('/wetter/2026-07-23');
  await expect(page.locator('.weather-day__date')).toHaveText('Donnerstag, 23. Juli');
  await expect(page.locator('.weather-day__temp-max')).toHaveText('15°');
});

/* -------------------------------------------------------------------------- */
/* AK: am Rand der Vorhersage passiert nichts, die Seite federt zurück        */
/* -------------------------------------------------------------------------- */

test('auf dem letzten verfügbaren Tag erzeugt ein Weiterwischen keinen no-data-Zustand (issue #267 AC3)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-26'); // letzter Tag der 7-Tage-Vorhersage
  await expect(page.locator('.weather-day__temp-max')).toHaveText('31°');

  await swipeLeft(page, 120);

  await expect(page).toHaveURL('/wetter/2026-07-26');
  await expect(page.locator('.weather-day__empty')).toHaveCount(0);
  await expect(page.locator('.weather-day__temp-max')).toHaveText('31°');

  // "federt zurück": der Transform der Inhaltsspalte landet wieder bei 0, statt
  // dauerhaft verschoben stehen zu bleiben.
  await expect
    .poll(() =>
      page
        .locator('.weather-day-screen__content')
        .evaluate((el) => getComputedStyle(el).transform),
    )
    .toBe('none');
});

test('auf dem ersten verfügbaren Tag erzeugt ein Zurückwischen ebenfalls keine Änderung (issue #267 AC3)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-20'); // erster Tag der 7-Tage-Vorhersage
  await expect(page.locator('.weather-day__temp-max')).toHaveText('24°');

  await swipeRight(page, 120);

  await expect(page).toHaveURL('/wetter/2026-07-20');
  await expect(page.locator('.weather-day__empty')).toHaveCount(0);
  await expect(page.locator('.weather-day__temp-max')).toHaveText('24°');
});

/* -------------------------------------------------------------------------- */
/* AK: zu kurze oder überwiegend senkrechte Gesten wechseln den Tag nicht     */
/* -------------------------------------------------------------------------- */

test('eine zu kurze Wischgeste wechselt den Tag nicht (issue #267 AC4)', async ({ page }) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  await swipeLeft(page, 20); // unterhalb der 80px-Schwelle

  await expect(page).toHaveURL('/wetter/2026-07-23');
  await expect(page.locator('.weather-day__temp-max')).toHaveText('15°');
});

test('eine überwiegend senkrechte Geste wechselt den Tag nicht, auch nicht über der Temperaturkurve (issue #267 AC4/AC5)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  const chart = page.locator('.weather-day__chart');
  const box = (await chart.boundingBox())!;
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  // Weiter senkrecht als waagerecht — trotz 120px horizontalem Anteil, der für
  // sich genommen die Schwelle überschritten hätte.
  await chart.dispatchEvent('pointerdown', { pointerId: 1, clientX: startX, clientY: startY, button: 0, bubbles: true });
  await chart.dispatchEvent('pointermove', {
    pointerId: 1,
    clientX: startX - 120,
    clientY: startY - 200,
    bubbles: true,
  });
  await chart.dispatchEvent('pointerup', {
    pointerId: 1,
    clientX: startX - 120,
    clientY: startY - 200,
    bubbles: true,
  });

  await expect(page).toHaveURL('/wetter/2026-07-23');
  await expect(page.locator('.weather-day__temp-max')).toHaveText('15°');
});

/* -------------------------------------------------------------------------- */
/* AK: senkrechtes Scrollen bleibt uneingeschränkt möglich                    */
/* -------------------------------------------------------------------------- */

test('die Seite erlaubt weiterhin senkrechtes Scrollen (touch-action: pan-y, issue #267 AC5)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  const touchAction = await page
    .locator('.weather-day-screen')
    .evaluate((el) => getComputedStyle(el).touchAction);
  expect(touchAction).toBe('pan-y');
});

/* -------------------------------------------------------------------------- */
/* AK: Tastatur-Äquivalent Pfeil links/rechts                                 */
/* -------------------------------------------------------------------------- */

test('Pfeil links/rechts wechselt denselben Tag wie die Geste (issue #267 AC6)', async ({ page }) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  await page.keyboard.press('ArrowLeft');
  await expect(page).toHaveURL('/wetter/2026-07-24');
  await expect(page.locator('.weather-day__temp-max')).toHaveText('26°');

  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL('/wetter/2026-07-23');
  await expect(page.locator('.weather-day__temp-max')).toHaveText('15°');
});

/* -------------------------------------------------------------------------- */
/* AK: prefers-reduced-motion — kein gleitender Übergang beim Tageswechsel,   */
/* der Rückstoß am Rand bleibt ohne Sprung-Animation                          */
/* -------------------------------------------------------------------------- */

test('bei reduzierter Bewegung wechselt der Tag ohne Übergang, der Rückstoß hat keine Sprung-Animation (issue #267 AC7)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-26'); // letzter Tag — der Rückstoß-Pfad

  await swipeLeft(page, 120);

  const transitionDuration = await page
    .locator('.weather-day-screen__content')
    .evaluate((el) => getComputedStyle(el).transitionDuration);
  // Chromium serialisiert sehr kleine Werte in Exponentialschreibweise (z. B. "1e-05s").
  expect(parseFloat(transitionDuration)).toBeLessThan(0.001);
});

/* -------------------------------------------------------------------------- */
/* AK: kein eigener Netzaufruf durch den Tageswechsel, auch offline           */
/* -------------------------------------------------------------------------- */

test('ein Tageswechsel per Wisch löst keinen eigenen Netzaufruf aus und funktioniert offline (issue #267 AC8)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);

  // Netz komplett kappen, sobald die Ablage warm ist — derselbe Aufbau wie beim
  // bestehenden Offline-Test oben: der Wechsel muss rein aus der Ablage kommen.
  await page.unroute(OPEN_METEO_PATTERN);
  await page.route(OPEN_METEO_PATTERN, (route) => route.abort('failed'));
  await page.goto('/wetter/2026-07-23');
  await expect(page.locator('.weather-day__temp-max')).toHaveText('15°');

  const requestUrls: string[] = [];
  page.on('request', (request) => requestUrls.push(request.url()));

  await swipeLeft(page, 120);

  await expect(page).toHaveURL('/wetter/2026-07-24');
  await expect(page.locator('.weather-day__temp-max')).toHaveText('26°');
  expect(requestUrls).toEqual([]);
});

/* -------------------------------------------------------------------------- */
/* AK: Temperatur der kommenden Nacht statt Tages-Tiefstwert, mit Mond-Symbol */
/* (issue #269)                                                               */
/* -------------------------------------------------------------------------- */

test('der Kopf zeigt Sonne + Höchstwert und Mond + Nachttemperatur, beide mit Beschriftung für Screenreader (issue #269 AC1/AC4/AC5/AC9)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  // 2026-07-22: Höchstwert 19°, Tages-Tiefstwert 9°, Nachtwert (Fenster Sonnenuntergang
  // 22.7. bis Sonnenaufgang 23.7.) 5° — alle drei Zahlen liegen bewusst auseinander.
  await page.goto('/wetter/2026-07-22');

  await expect(page.locator('.weather-day__temp-max')).toHaveText('19°');
  await expect(page.locator('.weather-day__temp-max')).toHaveAttribute('aria-label', 'Höchstwert: 19 Grad');
  await expect(page.locator('.weather-day__temp-max svg')).toHaveCount(1);

  await expect(page.locator('.weather-day__temp-min')).toHaveText('5°');
  await expect(page.locator('.weather-day__temp-min')).toHaveAttribute(
    'aria-label',
    'nachts, 21:12 bis 05:53: 5 Grad',
  );
  await expect(page.locator('.weather-day__temp-min svg')).toHaveCount(1);
  await expect(page.locator('.weather-day__temp-fallback-label')).toHaveCount(0);
});

test('am letzten Vorhersagetag fällt der Nachtwert sichtbar auf den Tages-Tiefstwert zurück, ohne Mond (issue #269 AC3)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-26'); // letzter Tag der 7-Tage-Vorhersage, kein Folgetag

  await expect(page.locator('.weather-day__temp-min')).toHaveText('21°'); // Tages-Tiefstwert
  await expect(page.locator('.weather-day__temp-min')).toHaveAttribute('aria-label', 'Tiefstwert: 21 Grad');
  await expect(page.locator('.weather-day__temp-min svg')).toHaveCount(0); // kein Mond ohne Nachtdaten
  await expect(page.getByText('Tiefstwert', { exact: true })).toBeVisible();
});

test('die Temperaturkurve bleibt beim Kalendertag, auch wenn der Nachtwert stark abweicht (issue #269 AC6)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  // 2026-07-24: Tages-Tiefstwert 16°, Nachtwert -2° (die Nacht zum 25.7. ist der
  // kälteste Tag der Woche) — die Kurve und ihr aria-label dürfen trotzdem beim
  // Kalendertag (16°–26°) bleiben.
  await page.goto('/wetter/2026-07-24');

  await expect(page.locator('.weather-day__temp-min')).toHaveText('-2°');
  await expect(page.locator('.weather-day__chart')).toHaveAttribute(
    'aria-label',
    'Temperaturverlauf von 16° bis 26°, stündlich',
  );
});

/* -------------------------------------------------------------------------- */
/* AK: dieselbe dauerhafte Icon-Bewegung wie im Streifen (issue #661 AK3)     */
/* -------------------------------------------------------------------------- */

test('auf der Tagesdetailseite läuft dieselbe Wetter-Icon-Animation wie im Streifen (issue #661 AK3)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  // 2026-07-23 = CODES[3] = 61 -> Regen.
  await page.goto('/wetter/2026-07-23');

  const drop = page.locator('.weather-day__icon .weather-icon__drop').first();
  const { name, iterationCount } = await drop.evaluate((el) => {
    const style = getComputedStyle(el);
    return { name: style.animationName, iterationCount: style.animationIterationCount };
  });
  expect(name).not.toBe('none');
  expect(iterationCount).toBe('infinite');
});

test('der Nachtwert kommt ohne eigenen Netzaufruf aus der Ablage (issue #269 AC8)', async ({ page }) => {
  const callCount = await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  expect(callCount()).toBe(1);

  await page.unroute(OPEN_METEO_PATTERN);
  await page.route(OPEN_METEO_PATTERN, (route) => route.abort('failed'));
  await page.goto('/wetter/2026-07-22');

  await expect(page.locator('.weather-day__temp-min')).toHaveText('5°');
  expect(callCount()).toBe(1);
});

test('der Kopf mit dem Tiefstwert-Rückfall passt bei 375px ohne waagerechtes Scrollen (issue #269 AC3/AC10)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-26');
  await expect(page.getByText('Tiefstwert', { exact: true })).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

/* -------------------------------------------------------------------------- */
/* AK4a: „Gefühlt" im Kartenkopf der Tagesverlauf-Box (issue #927)            */
/* -------------------------------------------------------------------------- */

test('die Tagesverlauf-Karte zeigt "Gefühlt" mit der gefühlten Höchsttemperatur im Kopf (issue #927 AK4a)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  // TEMPS_MAX[3] = 15, APPARENT_TEMPS_MAX[3] = 14.
  await expect(page.locator('.weather-day__card', { hasText: 'Tagesverlauf' })).toContainText('Gefühlt 14°');
});

/* -------------------------------------------------------------------------- */
/* AK4b: Windrichtung als Himmelsrichtung an der Wind-Zeile (issue #927)      */
/* -------------------------------------------------------------------------- */

test('die Wind-Zeile zeigt zusätzlich die Himmelsrichtung (issue #927 AK4b)', async ({ page }) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  // WIND_DIRECTIONS = 270° für jeden Tag = West.
  await expect(page.locator('.weather-day__wind-direction')).toHaveText('West');
});

/* -------------------------------------------------------------------------- */
/* AK4c: Stundenreihe mit Wetter-Icons unter der Tagesverlauf-Kurve (issue #927) */
/* -------------------------------------------------------------------------- */

test('unter der Tagesverlauf-Kurve läuft eine scrollbare Stundenreihe mit 24 Wetter-Icons (issue #927 AK4c)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  const row = page.locator('.weather-day__hourly');
  await expect(row.locator('.weather-day__hourly-cell')).toHaveCount(24);
  // CODES[3] = 61 -> Regen, für jede Stunde dieses Tages gleich.
  await expect(row.locator('.weather-day__hourly-icon').first()).toHaveAttribute('aria-label', 'Regen');

  const { scrollWidth, clientWidth, overflowX } = await row.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    overflowX: getComputedStyle(el).overflowX,
  }));
  expect(overflowX).toBe('auto');
  expect(scrollWidth).toBeGreaterThan(clientWidth);
});

/* -------------------------------------------------------------------------- */
/* AK2: eine gecachte Alt-Zeile ohne die drei neuen Spalten bleibt lesbar,    */
/* die drei neuen Stellen bleiben einfach weg (issue #927)                   */
/* -------------------------------------------------------------------------- */

test('eine gecachte Alt-Zeile ohne die drei neuen Spalten rendert unverändert, ohne Fehler und ohne die neuen Stellen (issue #927 AK2)', async ({
  page,
}) => {
  await mockLegacyForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  // Die längst vorhandenen Werte rendern weiterhin ohne Fehler.
  await expect(page.locator('.weather-day__temp-max')).toHaveText('15°');
  await expect(page.getByText('Für diesen Tag liegen keine Wetterdaten vor.')).toHaveCount(0);

  // Die drei freigeschalteten Stellen bleiben ab, statt zu crashen.
  await expect(page.locator('.weather-day__card', { hasText: 'Tagesverlauf' })).not.toContainText('Gefühlt');
  await expect(page.locator('.weather-day__wind-direction')).toHaveCount(0);
  await expect(page.locator('.weather-day__hourly')).toHaveCount(0);
});
