import { expect, test, type Page, type Route } from '@playwright/test';
import { freezeClock, registerPasskey, resetAppData, skewClock } from './helpers';

// A Monday (issue #139) — matches the weekday labels asserted below.
const NOW = '2026-07-20T09:00:00.000Z';
const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';

// Mirrors REFRESH_INTERVAL_MS in src/features/weather/forecast.ts. Not imported —
// that module pulls in Dexie/IndexedDB bindings that do not resolve outside a
// browser context (same reasoning as PULL_INTERVAL_MS in sync.spec.ts).
const REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000;

/** Local `HH:MM` for an ISO instant — matches formatStaleSince's own local-time read,
 * so the assertion holds regardless of which timezone the test machine runs in. */
function localTime(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

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
/* AK: Wochenende bekommt einen kräftigeren Rahmen, Spaltenbreite bleibt gleich */
/* -------------------------------------------------------------------------- */

test('Samstag und Sonntag haben einen kräftigeren Rahmen, alle sieben Spalten bleiben gleich breit (issue #155 AC1)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/heute');

  const days = weatherDays(page);
  await expect(days).toHaveCount(7);

  const widths = await days.evaluateAll((elements) =>
    elements.map((el) => el.getBoundingClientRect().width),
  );
  for (const width of widths) {
    expect(width).toBeCloseTo(widths[0], 1);
  }

  // DAY_SET_A.weekdays: ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
  const monday = days.nth(0);
  const saturday = days.nth(5);
  const sunday = days.nth(6);

  await expect(monday).toHaveCSS('outline-style', 'none');
  await expect(saturday).toHaveCSS('outline-style', 'solid');
  await expect(sunday).toHaveCSS('outline-style', 'solid');
});

/* -------------------------------------------------------------------------- */
/* AK: Quellenangabe verlässt /heute (zieht in die Einstellungen, #155 AC5)    */
/* -------------------------------------------------------------------------- */

test('die Open-Meteo-Nennung steht nicht mehr auf /heute (issue #155 AC5)', async ({ page }) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/heute');
  await expect(weatherDays(page)).toHaveCount(7);

  await expect(page.getByText('Open-Meteo', { exact: false })).toHaveCount(0);
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
/* AK: Offline zeigt die letzte bekannte Vorhersage; Stand-Zeile erst ab 8h    */
/* -------------------------------------------------------------------------- */

test('offline zeigt weiterhin die zuletzt bekannte Vorhersage; die Stand-Zeile erscheint erst ab 8 Stunden Alter (issue #155 AC2/AC3)', async ({
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

  // 5h later, offline — the cached forecast is still shown, but under the 8h
  // threshold: no warning line yet.
  await skewClock(page, '2026-07-20T14:00:00.000Z');
  await page.reload();
  await expect(weatherDays(page)).toHaveCount(7);
  await expect(page.locator('.weather-forecast__caption')).toHaveCount(0);

  // 8h later, still offline — same cached forecast, now with the warning line,
  // showing the last successful fetch's local time in 24h format.
  await skewClock(page, '2026-07-20T17:00:00.000Z');
  await page.reload();
  await expect(weatherDays(page)).toHaveCount(7);
  await expect(page.locator('.weather-forecast__caption')).toHaveText(`Stand: ${localTime(NOW)}`);
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
/* AK: Das Auftauchen der Stand-Zeile verschiebt nichts darunter (issue #155)  */
/* -------------------------------------------------------------------------- */

test('das Auftauchen der Stand-Zeile verschiebt den Inhalt darunter nicht (issue #155 AC4)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/heute');
  await expect(weatherDays(page)).toHaveCount(7);
  await expect(page.locator('.weather-forecast__caption')).toHaveCount(0);

  const headingBefore = await page.locator('#heute-aufgaben-heading').boundingBox();

  // The API stays unreachable so the cache genuinely goes stale instead of a
  // background refresh quietly resetting fetchedAt back to "just now".
  await page.unroute(OPEN_METEO_PATTERN);
  await page.route(OPEN_METEO_PATTERN, (route) => route.abort('failed'));
  await skewClock(page, '2026-07-20T17:00:00.000Z'); // exactly 8h later
  await page.reload();
  await expect(page.locator('.weather-forecast__caption')).toBeVisible();

  const headingAfter = await page.locator('#heute-aufgaben-heading').boundingBox();
  expect(headingAfter?.y).toBe(headingBefore?.y);
});

/* -------------------------------------------------------------------------- */
/* AK: Nachholen bei Rückkehr aus dem Hintergrund, sonst nicht (issue #155)    */
/* -------------------------------------------------------------------------- */

test.describe('holt bei Rückkehr aus dem Hintergrund nach, solange der Stand alt genug ist (issue #155 AC6/AC7)', () => {
  test('visibilitychange auf sichtbar holt nach, wenn der Stand älter als 3 Stunden ist', async ({
    page,
  }) => {
    const callCount = await mockForecast(page, DAY_SET_A);
    await skewClock(page, NOW);
    await page.goto('/heute');
    await expect(weatherDays(page)).toHaveCount(7);
    expect(callCount()).toBe(1);

    await page.unroute(OPEN_METEO_PATTERN);
    await mockForecast(page, DAY_SET_B);
    await skewClock(page, '2026-07-20T12:30:00.000Z'); // +3h30, past the window
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await expect(weatherDays(page).first().locator('.weather-forecast__temp-max')).toHaveText(
      '10°',
    );
  });

  test('visibilitychange auf sichtbar holt NICHT nach, wenn der Stand jünger als 3 Stunden ist', async ({
    page,
  }) => {
    const callCount = await mockForecast(page, DAY_SET_A);
    await skewClock(page, NOW);
    await page.goto('/heute');
    await expect(weatherDays(page)).toHaveCount(7);
    expect(callCount()).toBe(1);

    await skewClock(page, '2026-07-20T10:00:00.000Z'); // +1h, still fresh
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // No new request ever fires for a fresh cache — polling instead of a fixed
    // wait would just reintroduce the flake it avoids elsewhere in this suite.
    await expect(weatherDays(page).first().locator('.weather-forecast__temp-max')).toHaveText(
      '24°',
    );
    expect(callCount()).toBe(1);
  });

  test('ein `focus`-Event holt sofort nach, ohne aufs Intervall zu warten', async ({ page }) => {
    await mockForecast(page, DAY_SET_A);
    await skewClock(page, NOW);
    await page.goto('/heute');
    await expect(weatherDays(page)).toHaveCount(7);

    await page.unroute(OPEN_METEO_PATTERN);
    await mockForecast(page, DAY_SET_B);
    await skewClock(page, '2026-07-20T12:00:00.000Z'); // exactly 3h later
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));

    await expect(weatherDays(page).first().locator('.weather-forecast__temp-max')).toHaveText(
      '10°',
    );
  });

  test('solange die Seite sichtbar bleibt, prüft ein Intervall weiter — auch ohne Fokus/Sichtbarkeitswechsel', async ({
    page,
  }) => {
    await page.clock.install({ time: new Date(NOW) });
    await mockForecast(page, DAY_SET_A);
    await page.goto('/heute');
    await expect(weatherDays(page)).toHaveCount(7);

    await page.unroute(OPEN_METEO_PATTERN);
    await mockForecast(page, DAY_SET_B);
    await freezeClock(page);
    await page.clock.fastForward(REFRESH_INTERVAL_MS + 1_000);

    await expect(weatherDays(page).first().locator('.weather-forecast__temp-max')).toHaveText(
      '10°',
    );
  });

  test('im Hintergrund läuft kein Intervall-Timer', async ({ page }) => {
    await page.clock.install({ time: new Date(NOW) });
    const callCount = await mockForecast(page, DAY_SET_A);
    await page.goto('/heute');
    await expect(weatherDays(page)).toHaveCount(7);
    expect(callCount()).toBe(1);

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await freezeClock(page);
    // Several interval periods' worth of time — if the interval were still
    // running despite the tab being hidden, this would have fired it repeatedly.
    await page.clock.fastForward(REFRESH_INTERVAL_MS * 3);

    expect(callCount()).toBe(1);
  });
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
