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
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Donnerstag, 23. Juli');
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
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  await expect(page.locator('.weather-day__precipitation-bar')).toHaveCount(24);
  await expect(page.locator('.weather-day__precipitation-summary')).toHaveText('Insgesamt 7.5 mm');
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
});

test('ein trockener Tag zeigt "Kein Niederschlag erwartet." und ein leeres Balkenfeld (issue #156 AC3)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-20');

  await expect(page.locator('.weather-day__precipitation-summary')).toHaveText('Kein Niederschlag erwartet.');
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
});

/* -------------------------------------------------------------------------- */
/* Achsenbeschriftung beider Diagramme                                        */
/* -------------------------------------------------------------------------- */

test('beide Diagramme haben beschriftete Achsen, die Stundenachse reicht bis 24:00, gleichmäßig verteilt (issue #795)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  // 5°/15° sind Tiefst-/Höchstwert dieses Tages, dazwischen der Mittelwert.
  await expect(page.locator('.weather-day__chart .weather-day__chart-tick')).toHaveText([
    '5°',
    '10°',
    '15°',
    '00:00',
    '06:00',
    '12:00',
    '18:00',
    '24:00',
  ]);
  await expect(page.locator('.weather-day__precipitation-chart .weather-day__chart-tick')).toHaveText([
    '0 %',
    '50 %',
    '100 %',
    '00:00',
    '06:00',
    '12:00',
    '18:00',
    '24:00',
  ]);

  // Der gemeldete Fehler: die letzten beiden Uhrzeiten saßen enger zusammen als
  // der Rest, weil die Achse die Stunden 0..23 statt 0..24 abbildete. Jetzt
  // müssen alle vier Lücken zwischen den fünf Stundenlabels gleich breit sein —
  // für beide Diagramme, die sich dasselbe Stundenraster teilen. Geprüft wird
  // die `x`-Koordinate im SVG-Viewport, nicht die gerenderte Bounding-Box: das
  // letzte Label ist absichtlich rechtsbündig verankert (sonst liefe es über
  // den Rand hinaus), was seine Glyphen-Box gegenüber ihrer wahren Tick-Position
  // verschiebt, ohne dass die Achse selbst ungleichmäßig wäre.
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
  }
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

test('der Abstand zwischen Tagesverlauf- und Niederschlags-Box ist genauso klein wie der zur oberen Box mit den rohen Tageswerten (issue #381)', async ({
  page,
}) => {
  await mockForecast(page);
  await skewClock(page, NOW);
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  const summary = await page.locator('.weather-day__summary').boundingBox();
  const [tagesverlauf, niederschlag] = await page.locator('.weather-day__card').all();
  const tagesverlaufBox = await tagesverlauf.boundingBox();
  const niederschlagBox = await niederschlag.boundingBox();

  const gapToChart = tagesverlaufBox!.y - (summary!.y + summary!.height);
  const gapBetweenCharts = niederschlagBox!.y - (tagesverlaufBox!.y + tagesverlaufBox!.height);

  expect(gapBetweenCharts).toBeLessThanOrEqual(gapToChart + 0.5);
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
  const back = await page.locator('.weather-day__back').boundingBox();
  const summary = await page.locator('.weather-day__summary').boundingBox();
  const gap = summary!.y - back!.y - back!.height;
  expect(gap).toBeLessThanOrEqual(maxGapPx);
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
  await expect(page.locator('.weather-day__precipitation-summary')).toHaveText('Insgesamt 7.5 mm');
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
  const date = await page.getByRole('heading', { level: 1 }).boundingBox();
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
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Freitag, 24. Juli');
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
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mittwoch, 22. Juli');
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
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Donnerstag, 23. Juli');
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
