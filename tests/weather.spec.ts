import { expect, test, type Page, type Route } from '@playwright/test';
import { registerPasskey, resetAppData, skewClock } from './helpers';

// A Monday (issue #139) — matches the weekday labels asserted below.
const NOW = '2026-07-20T09:00:00.000Z';
const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';

const DAY_SET_A = {
  dates: ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-25', '2026-07-26'],
  weekdays: ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'],
  codes: [0, 2, 3, 45, 63, 73, 96],
  categories: ['Klar', 'Teils bewölkt', 'Bewölkt', 'Nebel', 'Regen', 'Schnee', 'Gewitter'],
  tempsMax: [24, 22, 19, 15, 26, 6, 31],
  tempsMin: [14, 12, 9, 5, 16, -2, 21],
};

const DAY_SET_B = {
  ...DAY_SET_A,
  tempsMax: [10, 10, 10, 10, 10, 10, 10],
  tempsMin: [1, 1, 1, 1, 1, 1, 1],
};

function forecastResponseBody(set: typeof DAY_SET_A) {
  return {
    daily: {
      time: set.dates,
      weather_code: set.codes,
      temperature_2m_max: set.tempsMax,
      temperature_2m_min: set.tempsMin,
      precipitation_probability_max: set.dates.map(() => 0),
    },
  };
}

/** Fulfils every Open-Meteo request with `set`, counting how often it was actually called. */
async function mockForecast(page: Page, set: typeof DAY_SET_A): Promise<() => number> {
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
  await registerPasskey(page);
});

/* -------------------------------------------------------------------------- */
/* AK: sieben Tage, heute zuerst, je Kürzel/Symbol/Höchst-Tiefstwert           */
/* -------------------------------------------------------------------------- */

test('sieben Tage stehen ganz oben, heute zuerst, je mit Kürzel, Symbol, Höchst- und Tiefstwert (issue #139 AC1)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/heute');

  const days = weatherDays(page);
  await expect(days).toHaveCount(7);

  for (let i = 0; i < 7; i += 1) {
    const day = days.nth(i);
    await expect(day.locator('.weather-forecast__weekday')).toHaveText(DAY_SET_A.weekdays[i]);
    await expect(day.getByRole('img', { name: DAY_SET_A.categories[i] })).toBeVisible();
    await expect(day.locator('.weather-forecast__temp-max')).toHaveText(`${DAY_SET_A.tempsMax[i]}°`);
    await expect(day.locator('.weather-forecast__temp-min')).toHaveText(`${DAY_SET_A.tempsMin[i]}°`);
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
  await page.goto('/heute');
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

test('ein zweiter Aufruf innerhalb von 3 Stunden löst keinen neuen Netzaufruf aus (issue #139 AC3)', async ({
  page,
}) => {
  const callCount = await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/heute');
  await expect(weatherDays(page)).toHaveCount(7);
  expect(callCount()).toBe(1);

  await skewClock(page, '2026-07-20T11:30:00.000Z'); // +2h30, still under the window
  await page.reload();
  await expect(weatherDays(page)).toHaveCount(7);
  expect(callCount()).toBe(1);
});

test('nach mehr als 3 Stunden löst der nächste Aufruf einen neuen Netzaufruf aus, die Anzeige aktualisiert sich (issue #139 AC3)', async ({
  page,
}) => {
  const callCount = await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/heute');
  await expect(weatherDays(page)).toHaveCount(7);
  expect(callCount()).toBe(1);

  await page.unroute(OPEN_METEO_PATTERN);
  await mockForecast(page, DAY_SET_B);
  await skewClock(page, '2026-07-20T12:00:00.000Z'); // exactly 3h later
  await page.reload();

  await expect(weatherDays(page).first().locator('.weather-forecast__temp-max')).toHaveText('10°');
});

/* -------------------------------------------------------------------------- */
/* AK: Offline zeigt die letzte bekannte Vorhersage mit Altershinweis         */
/* -------------------------------------------------------------------------- */

test('offline zeigt die zuletzt bekannte Vorhersage mit sichtbarem Altershinweis (issue #139 AC4)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/heute');
  await expect(weatherDays(page)).toHaveCount(7);

  // A full `context.setOffline(true)` would also block the reload's own request
  // against the dev server (no service worker there, unlike the prod-build
  // projects) — every offline test elsewhere in this suite avoids that exact
  // combination for the same reason (see e.g. tasks.spec.ts). Aborting only the
  // Open-Meteo request reproduces what "offline" means from this component's
  // point of view: no response ever reaches it.
  await page.unroute(OPEN_METEO_PATTERN);
  await page.route(OPEN_METEO_PATTERN, (route) => route.abort('failed'));
  await skewClock(page, '2026-07-20T14:00:00.000Z');
  await page.reload();

  await expect(weatherDays(page)).toHaveCount(7);
  await expect(page.locator('.weather-forecast__caption')).toContainText('aktualisiert vor');
});

/* -------------------------------------------------------------------------- */
/* AK: Antwortet Open-Meteo nicht — letzte Vorhersage bleibt, sonst erklärender Zustand */
/* -------------------------------------------------------------------------- */

test('antwortet Open-Meteo nicht, bleibt die zuletzt bekannte Vorhersage stehen (issue #139 AC5)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/heute');
  await expect(weatherDays(page)).toHaveCount(7);

  await page.unroute(OPEN_METEO_PATTERN);
  await page.route(OPEN_METEO_PATTERN, (route) => route.fulfill({ status: 500, body: 'boom' }));
  await skewClock(page, '2026-07-20T13:00:00.000Z'); // past the 3h window, refresh attempted and fails
  await page.reload();

  await expect(weatherDays(page)).toHaveCount(7);
  await expect(weatherDays(page).first().locator('.weather-forecast__temp-max')).toHaveText('24°');
});

test('ohne jemals erfolgreichen Abruf erscheint ein erklärender Zustand statt einer leeren Fläche (issue #139 AC5)', async ({
  page,
}) => {
  await page.route(OPEN_METEO_PATTERN, (route) => route.fulfill({ status: 500, body: 'boom' }));
  await skewClock(page, NOW);
  await page.goto('/heute');

  await expect(page.getByText('Vorhersage konnte nicht geladen werden.')).toBeVisible();
  await expect(weatherDays(page)).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* AK: reservierte Höhe vor dem ersten Abruf — kein Layout-Shift              */
/* -------------------------------------------------------------------------- */

test('reserviert vor dem allerersten Abruf schon die spätere Höhe (issue #139 AC6, DESIGN_SYSTEM Smooth-Regel 3)', async ({
  page,
}) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(OPEN_METEO_PATTERN, async (route) => {
    await gate;
    await route.fulfill({ json: forecastResponseBody(DAY_SET_A) });
  });
  await skewClock(page, NOW);
  await page.goto('/heute');

  await expect(page.locator('.weather-forecast__day--skeleton').first()).toBeVisible();
  const loadingHeight = (await page.locator('.weather-forecast').boundingBox())?.height;

  release();
  await expect(weatherDays(page)).toHaveCount(7);
  const loadedHeight = (await page.locator('.weather-forecast').boundingBox())?.height;

  expect(loadingHeight).toBe(loadedHeight);
});

/* -------------------------------------------------------------------------- */
/* AK: Wetterdaten erreichen weder Outbox noch Datenbank                     */
/* -------------------------------------------------------------------------- */

test('die Wetterdaten tauchen nie in der Outbox auf (issue #139 AC7)', async ({ page }) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/heute');
  await expect(weatherDays(page)).toHaveCount(7);

  await skewClock(page, '2026-07-20T13:00:00.000Z');
  await page.reload();
  await expect(weatherDays(page)).toHaveCount(7);

  expect(await page.evaluate(() => window.__starship.size())).toBe(0);
});

/* -------------------------------------------------------------------------- */
/* AK: 375px ohne horizontales Scrollen (läuft im mobile-Projekt automatisch) */
/* -------------------------------------------------------------------------- */

test('sieben Spalten passen ohne waagerechtes Scrollen der Seite (issue #139 AC9)', async ({ page }) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/heute');
  await expect(weatherDays(page)).toHaveCount(7);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

/* -------------------------------------------------------------------------- */
/* AK: Semantische Tokens, Dark Mode, prefers-reduced-motion                  */
/* -------------------------------------------------------------------------- */

test('eine Tageskarte nutzt den --surface-Token, auch im Dark Mode (issue #139 AC10)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/heute');

  const card = weatherDays(page).first();
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

test('bei reduzierter Bewegung steht der Lade-Puls still (issue #139 AC10)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(OPEN_METEO_PATTERN, async (route) => {
    await gate;
    await route.fulfill({ json: forecastResponseBody(DAY_SET_A) });
  });
  await skewClock(page, NOW);
  await page.goto('/heute');

  const skeleton = page.locator('.weather-forecast__day--skeleton').first();
  await expect(skeleton).toBeVisible();
  const duration = await skeleton.evaluate((el) => getComputedStyle(el).animationDuration);
  expect(parseFloat(duration)).toBeLessThan(0.001);

  release();
});
