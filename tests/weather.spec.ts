import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
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

async function resolveColorToken(page: Page, token: string): Promise<string> {
  return page.evaluate((cssVar) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${cssVar})`;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

/** Same idea as `resolveColorToken`, for any other property — `border-radius`,
 * `box-shadow`, `padding-top`/`padding-left` (issue #973 AK2). Longhand padding
 * properties, not the shorthand — `getComputedStyle` only normalizes that
 * reliably back to a string for longhands. */
async function resolveToken(page: Page, property: string, token: string): Promise<string> {
  return page.evaluate(
    ({ property, token }) => {
      const probe = document.createElement('span');
      probe.style.setProperty(property, `var(${token})`);
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).getPropertyValue(property);
      probe.remove();
      return value;
    },
    { property, token },
  );
}

/** Resolves a colour token in the context of `locator` rather than `document.body`.
 * The columns reset `--text`/`--border` to their neutral `-base` anchors (issue
 * #846), so a `resolveColorToken` on the body would read the ground mix instead. */
async function resolveColorTokenWithin(locator: Locator, token: string): Promise<string> {
  return locator.evaluate((el, cssVar) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${cssVar})`;
    el.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

/** The weekday label of one column — since issue #1003 this, not a frame around
 * the column, is what marks Sa/So. */
function weekdayLabel(day: Locator) {
  return day.locator('.weather-forecast__weekday');
}

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

/** Arms a Layout Instability API observer scoped to `selector` — issue #973 AK4
 * wants height parity across loading/ready/empty-error proven via the real
 * `previousRect`/`currentRect` of a Layout-Shift entry, not just a before/after
 * `boundingBox()` snapshot diff ("nicht per Augenmaß"). Must run before the
 * phase transition it observes. */
async function observeLayoutShifts(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const win = window as unknown as {
      __weatherShifts: { previousHeight: number; currentHeight: number }[];
    };
    win.__weatherShifts = [];
    const target = document.querySelector(sel);
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as {
        sources?: {
          node?: Node | null;
          previousRect: DOMRectReadOnly;
          currentRect: DOMRectReadOnly;
        }[];
      }[]) {
        for (const source of entry.sources ?? []) {
          if (source.node && target && (source.node === target || target.contains(source.node))) {
            win.__weatherShifts.push({
              previousHeight: source.previousRect.height,
              currentHeight: source.currentRect.height,
            });
          }
        }
      }
    });
    observer.observe({ type: 'layout-shift', buffered: true });
  }, selector);
}

/** Reads back the entries `observeLayoutShifts` collected so far. */
async function readLayoutShifts(
  page: Page,
): Promise<{ previousHeight: number; currentHeight: number }[]> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __weatherShifts: { previousHeight: number; currentHeight: number }[];
        }
      ).__weatherShifts,
  );
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
/* AK: Gewitter-Icon wird oben nicht abgeschnitten (issue #330)               */
/* -------------------------------------------------------------------------- */

test('Gewitter-Wolke wird oben nicht abgeschnitten (issue #330)', async ({ page }) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');

  const gewitterCloud = weatherDays(page)
    .filter({ has: page.locator('[aria-label="Gewitter"]') })
    .locator('.weather-forecast__icon svg path')
    .first();
  await expect(gewitterCloud).toBeVisible();

  const box = await gewitterCloud.evaluate((el) => {
    const b = (el as SVGGraphicsElement).getBBox();
    return { y: b.y, bottom: b.y + b.height };
  });
  // Oberkante innerhalb der viewBox (vorher ca. -0,9 -> abgeschnitten), Unterkante drin.
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.bottom).toBeLessThanOrEqual(24);
});

/* -------------------------------------------------------------------------- */
/* AK: Wochenende bekommt einen kräftigeren Rahmen, Spaltenbreite bleibt gleich */
/* -------------------------------------------------------------------------- */

test('Samstag und Sonntag heben sich über den Wochentag ab, alle sieben Spalten bleiben gleich breit und rahmenlos (issue #223 AC1–AC2, issue #268 AC1–AC3, issue #1003 AK1/AK3)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');

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

  // AK1 (issue #1003): keine Spalte trägt noch einen Rahmen — genau der Strich,
  // von dem bei `gap: 0` zwei nebeneinander lagen.
  const dayLinks = await days.locator('.weather-forecast__day-link').all();
  expect(dayLinks).toHaveLength(7);
  for (const link of dayLinks) {
    await expect(link).toHaveCSS('border-width', '0px');
  }

  // AK3: Sa/So tragen den Wochentag ungedämpft und kräftiger als ein Werktag.
  const mondayColor = await weekdayLabel(monday).evaluate((el) => getComputedStyle(el).color);
  const saturdayColor = await weekdayLabel(saturday).evaluate((el) => getComputedStyle(el).color);
  const sundayColor = await weekdayLabel(sunday).evaluate((el) => getComputedStyle(el).color);

  expect(saturdayColor).not.toBe(mondayColor);
  expect(sundayColor).not.toBe(mondayColor);
  expect(saturdayColor).toBe(sundayColor);

  // Der Ton ist tatsächlich an --text gebunden, der Werktag an --text-muted —
  // beide innerhalb der Spalte aufgelöst, weil die Karte sie auf ihre neutralen
  // -base-Anker zurücksetzt (issue #846).
  expect(saturdayColor).toBe(await resolveColorTokenWithin(saturday, '--text'));
  expect(mondayColor).toBe(await resolveColorTokenWithin(monday, '--text-muted'));

  // Zweites Signal, nicht nur Farbe: das Gewicht.
  const emphasisWeight = await resolveToken(page, 'font-weight', '--weight-emphasis');
  const mondayWeight = await weekdayLabel(monday).evaluate((el) => getComputedStyle(el).fontWeight);
  const saturdayWeight = await weekdayLabel(saturday).evaluate(
    (el) => getComputedStyle(el).fontWeight,
  );
  const sundayWeight = await weekdayLabel(sunday).evaluate((el) => getComputedStyle(el).fontWeight);

  expect(saturdayWeight).toBe(emphasisWeight);
  expect(sundayWeight).toBe(emphasisWeight);
  expect(saturdayWeight).not.toBe(mondayWeight);
});

test('die sieben Spalten teilen die Streifenbreite lückenlos auf und zeichnen keine eigene Zelle (issue #1003 AK2)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/uebersicht');

  const days = weatherDays(page);
  await expect(days).toHaveCount(7);

  const list = page.locator('.weather-forecast__days');
  const listBox = await list.boundingBox();
  expect(listBox).toBeTruthy();

  const boxes = await days.evaluateAll((elements) =>
    elements.map((el) => {
      const rect = el.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    }),
  );

  // Bündig an beiden Enden und Kante an Kante dazwischen: keine Spalte überlappt
  // ihre Nachbarin, keine lässt eine Lücke. Das ist die Geometrie, in der zwei
  // 2px-Rahmen vorher zu einem 4px-Strich verschmolzen sind.
  expect(boxes[0].left).toBeCloseTo(listBox!.x, 1);
  expect(boxes[6].right).toBeCloseTo(listBox!.x + listBox!.width, 1);
  for (let i = 0; i < 6; i += 1) {
    expect(boxes[i + 1].left).toBeCloseTo(boxes[i].right, 1);
  }

  // Und weil keine Spalte eine vom Kartengrund abweichende Fläche oder einen
  // Rahmen malt, ist an diesen Kanten auch nichts zu sehen.
  const cardBackground = await page
    .locator('.weather-forecast')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  for (let i = 0; i < 7; i += 1) {
    const day = days.nth(i);
    await expect(day).toHaveCSS('border-width', '0px');
    expect(await day.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(cardBackground);
  }
});

test('der Wochenend-Wochentag ist auch im Dark Mode vom Werktag unterscheidbar (issue #223 AC3, issue #1003 AK3)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);

  // Dark Mode aktivieren
  await page.addInitScript(() => {
    document.documentElement.setAttribute('data-theme', 'dunkel');
  });

  await page.goto('/uebersicht');

  const days = weatherDays(page);
  await expect(days).toHaveCount(7);

  const monday = days.nth(0);
  const saturday = days.nth(5);

  const mondayColor = await weekdayLabel(monday).evaluate((el) => getComputedStyle(el).color);
  const saturdayColor = await weekdayLabel(saturday).evaluate((el) => getComputedStyle(el).color);

  expect(saturdayColor).not.toBe(mondayColor);
  expect(saturdayColor).toBe(await resolveColorTokenWithin(saturday, '--text'));

  // Das Gewicht trägt im Dunkelmodus genauso (issue #1003 AK3) — der Ton allein
  // steht dort auf dunklem Grund unter mehr Druck.
  const emphasisWeight = await resolveToken(page, 'font-weight', '--weight-emphasis');
  expect(await weekdayLabel(saturday).evaluate((el) => getComputedStyle(el).fontWeight)).toBe(
    emphasisWeight,
  );
});

test('focus-visible auf Karten-Link zeigt Accent-Outline nach innen, auch ohne Spaltenrahmen (issue #223 AC4, issue #1003 AK5)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');

  const days = weatherDays(page);
  const saturday = days.nth(5);
  const saturdayLink = saturday.locator('.weather-forecast__day-link');

  await saturdayLink.focus();

  // Negativer Offset: der Ring liegt innerhalb der Spalte und ragt damit nicht in
  // die Nachbarspalte, die seit issue #1003 unmittelbar anschließt.
  await expect(saturdayLink).toHaveCSS('outline-offset', '-2px');
  await expect(saturdayLink).toHaveCSS('outline-width', '2px');
  await expect(saturdayLink).toHaveCSS('border-width', '0px');
  const outlineColor = await saturdayLink.evaluate((el) => getComputedStyle(el).outlineColor);
  expect(outlineColor).toBe(await resolveColorTokenWithin(saturday, '--accent'));
});

test('Tap-Ziel weather-forecast__day-link bleibt bei 375px ≥ 44×44px (issue #268 AC4)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  // 375px is the minimum mobile width
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/uebersicht');

  const days = weatherDays(page);
  await expect(days).toHaveCount(7);

  const dayLinks = await days.locator('.weather-forecast__day-link').all();
  for (const link of dayLinks) {
    const box = await link.boundingBox();
    expect(box).toBeTruthy();
    // Check both width and height are at least 44px
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
});

test('die Wochenendspalte bleibt auch bei 1280px (Desktop) am Wochentag erkennbar und rahmenlos (issue #268 AC6, issue #1003 AK1/AK3)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  // 1280px is a standard desktop width
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/uebersicht');

  const days = weatherDays(page);
  await expect(days).toHaveCount(7);

  const monday = days.nth(0);
  const saturday = days.nth(5);
  const sunday = days.nth(6);

  // Rahmenlos auch hier — die Breite ändert daran nichts (issue #1003 AK1)
  await expect(monday.locator('.weather-forecast__day-link')).toHaveCSS('border-width', '0px');
  await expect(saturday.locator('.weather-forecast__day-link')).toHaveCSS('border-width', '0px');
  await expect(sunday.locator('.weather-forecast__day-link')).toHaveCSS('border-width', '0px');

  // Sa/So bleiben über den Wochentag erkennbar
  const mondayColor = await weekdayLabel(monday).evaluate((el) => getComputedStyle(el).color);
  const saturdayColor = await weekdayLabel(saturday).evaluate((el) => getComputedStyle(el).color);
  const sundayColor = await weekdayLabel(sunday).evaluate((el) => getComputedStyle(el).color);

  expect(saturdayColor).not.toBe(mondayColor);
  expect(sundayColor).not.toBe(mondayColor);
  expect(saturdayColor).toBe(sundayColor);
});

/* -------------------------------------------------------------------------- */
/* AK: Quellenangabe verlässt /uebersicht (zieht in die Einstellungen, #155 AC5) */
/* -------------------------------------------------------------------------- */

test('die Open-Meteo-Nennung steht nicht mehr auf /uebersicht (issue #155 AC5)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');
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

test('ein zweiter Aufruf innerhalb von 3 Stunden löst keinen neuen Netzaufruf aus (issue #139 AC3)', async ({
  page,
}) => {
  const callCount = await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');
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
/* AK: Offline zeigt die letzte bekannte Vorhersage; Stand-Zeile erst ab 8h    */
/* -------------------------------------------------------------------------- */

test('offline zeigt weiterhin die zuletzt bekannte Vorhersage; die Stand-Zeile erscheint erst ab 8 Stunden Alter (issue #155 AC2/AC3)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');
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
  await page.goto('/uebersicht');
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
  await page.goto('/uebersicht');

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
  await page.goto('/uebersicht');

  await expect(page.locator('.weather-forecast__day--skeleton').first()).toBeVisible();
  const loadingHeight = (await page.locator('.weather-forecast').boundingBox())?.height;
  await observeLayoutShifts(page, '.weather-forecast');

  release();
  await expect(weatherDays(page)).toHaveCount(7);
  const loadedHeight = (await page.locator('.weather-forecast').boundingBox())?.height;

  expect(loadingHeight).toBe(loadedHeight);

  // issue #973 AK4: derselbe Übergang zusätzlich über den Layout-Shift-Eintrag
  // belegt (previousRect/currentRect), nicht nur per boundingBox()-Diff.
  for (const shift of await readLayoutShifts(page)) {
    expect(shift.currentHeight).toBe(shift.previousHeight);
  }
});

test('reserviert auch beim endgültigen Fehlschlag dieselbe Höhe wie loading/ready (issue #652 AC1)', async ({
  page,
}) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(OPEN_METEO_PATTERN, async (route) => {
    await gate;
    await route.abort('failed');
  });
  await skewClock(page, NOW);
  await page.goto('/uebersicht');

  await expect(page.locator('.weather-forecast__day--skeleton').first()).toBeVisible();
  const loadingHeight = (await page.locator('.weather-forecast').boundingBox())?.height;
  await observeLayoutShifts(page, '.weather-forecast');

  release();
  await expect(page.getByText('Vorhersage konnte nicht geladen werden.')).toBeVisible();
  const errorHeight = (await page.locator('.weather-forecast').boundingBox())?.height;

  expect(errorHeight).toBe(loadingHeight);

  // issue #973 AK4: derselbe Übergang zusätzlich über den Layout-Shift-Eintrag
  // belegt (previousRect/currentRect), nicht nur per boundingBox()-Diff.
  for (const shift of await readLayoutShifts(page)) {
    expect(shift.currentHeight).toBe(shift.previousHeight);
  }
});

/* -------------------------------------------------------------------------- */
/* AK: Das Auftauchen der Stand-Zeile verschiebt nichts darunter (issue #155)  */
/* -------------------------------------------------------------------------- */

test('das Auftauchen der Stand-Zeile verschiebt den Inhalt darunter nicht (issue #155 AC4)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);
  await expect(page.locator('.weather-forecast__caption')).toHaveCount(0);

  const headingBefore = await page.locator('#uebersicht-aufgaben-heading').boundingBox();

  // The API stays unreachable so the cache genuinely goes stale instead of a
  // background refresh quietly resetting fetchedAt back to "just now".
  await page.unroute(OPEN_METEO_PATTERN);
  await page.route(OPEN_METEO_PATTERN, (route) => route.abort('failed'));
  await skewClock(page, '2026-07-20T17:00:00.000Z'); // exactly 8h later
  await page.reload();
  await expect(page.locator('.weather-forecast__caption')).toBeVisible();

  const headingAfter = await page.locator('#uebersicht-aufgaben-heading').boundingBox();
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
    await page.goto('/uebersicht');
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
    await page.goto('/uebersicht');
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
    await page.goto('/uebersicht');
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
    await page.goto('/uebersicht');
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
    await page.goto('/uebersicht');
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
  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);

  await skewClock(page, '2026-07-20T13:00:00.000Z');
  await page.reload();
  await expect(weatherDays(page)).toHaveCount(7);

  expect(await page.evaluate(() => window.__starship.size())).toBe(0);
});

/* -------------------------------------------------------------------------- */
/* AK: 375px ohne horizontales Scrollen (läuft im mobile-Projekt automatisch) */
/* -------------------------------------------------------------------------- */

test('sieben Spalten passen ohne waagerechtes Scrollen der Seite (issue #139 AC9)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');
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
  await page.goto('/uebersicht');

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

test('die Schmalkarte selbst trägt --surface/--radius-surface/--shadow-raised und Polsterung in Token-Schritten (issue #973 AK2)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');

  const card = page.locator('.weather-forecast');
  await expect(card).toBeVisible();

  const surfaceToken = await resolveColorToken(page, '--surface');
  const radiusToken = await resolveToken(page, 'border-radius', '--radius-surface');
  const shadowToken = await resolveToken(page, 'box-shadow', '--shadow-raised');
  // 13px/16px im Blatt (issue #973 AK2) — --space-3 (12px) oben/unten, --space-4
  // (16px) seitlich, keine rohen Pixelwerte.
  const paddingBlockToken = await resolveToken(page, 'padding-top', '--space-3');
  const paddingInlineToken = await resolveToken(page, 'padding-left', '--space-4');

  expect(await card.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(surfaceToken);
  expect(await card.evaluate((el) => getComputedStyle(el).borderRadius)).toBe(radiusToken);
  expect(await card.evaluate((el) => getComputedStyle(el).boxShadow)).toBe(shadowToken);
  expect(await card.evaluate((el) => getComputedStyle(el).paddingTop)).toBe(paddingBlockToken);
  expect(await card.evaluate((el) => getComputedStyle(el).paddingBottom)).toBe(paddingBlockToken);
  expect(await card.evaluate((el) => getComputedStyle(el).paddingLeft)).toBe(paddingInlineToken);
  expect(await card.evaluate((el) => getComputedStyle(el).paddingRight)).toBe(paddingInlineToken);
});

test('Icon ~26px, Höchstwert in --font-display/--weight-emphasis mit tabular-nums (issue #973 AK3)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');

  const firstDay = weatherDays(page).first();
  const icon = firstDay.locator('.weather-forecast__icon svg');
  await expect(icon).toBeVisible();
  const iconSize = await icon.evaluate((el) => {
    const style = getComputedStyle(el);
    return { width: style.width, height: style.height };
  });
  expect(iconSize.width).toBe('26px');
  expect(iconSize.height).toBe('26px');

  const tempMax = firstDay.locator('.weather-forecast__temp-max');
  const { fontFamily, fontWeight, fontVariantNumeric } = await tempMax.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      fontVariantNumeric: style.fontVariantNumeric,
    };
  });
  const displayFamilyToken = await resolveToken(page, 'font-family', '--font-display');
  const emphasisWeightToken = await resolveToken(page, 'font-weight', '--weight-emphasis');
  expect(fontFamily).toBe(displayFamilyToken);
  expect(fontWeight).toBe(emphasisWeightToken);
  expect(fontVariantNumeric).toContain('tabular-nums');
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
  await page.goto('/uebersicht');

  const skeleton = page.locator('.weather-forecast__day--skeleton').first();
  await expect(skeleton).toBeVisible();
  const duration = await skeleton.evaluate((el) => getComputedStyle(el).animationDuration);
  expect(parseFloat(duration)).toBeLessThan(0.001);

  release();
});

/* -------------------------------------------------------------------------- */
/* AK: dauerhafte kleine Umgebungsbewegung der sieben Wetter-Icons (issue #661) */
/* -------------------------------------------------------------------------- */

// Je Kategorie ein Element, dessen Animation direkt geprüft werden kann — Reihenfolge
// deckt sich mit DAY_SET_A.codes/.categories (issue #139 NOW ist ein Montag).
const WEATHER_ICON_ANIMATED_SELECTOR: Record<string, string> = {
  Klar: '.weather-icon__disc',
  'Teils bewölkt': '.weather-icon__sun',
  Bewölkt: '.weather-icon__cloud',
  Nebel: '.weather-icon__fog-line--1',
  Regen: '.weather-icon__drop',
  Schnee: '.weather-icon__flake',
  Gewitter: '.weather-icon__bolt',
};

async function animationState(locator: Locator) {
  return locator.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      name: style.animationName,
      duration: style.animationDuration,
      iterationCount: style.animationIterationCount,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* AK12: der 7-Tage-Streifen bleibt unverändert — er kennt keine Nacht, also   */
/* auch keinen Mond (issue #999)                                              */
/* -------------------------------------------------------------------------- */

test('der 7-Tage-Streifen zeigt weiterhin die Sonnenscheibe bei "Klar", nie den Mond (issue #999 AK12)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);

  // DAY_SET_A.categories[0] = "Klar" — im Tagesdetail würde die Nachtstunde
  // einen Mond zeigen (issue #999 AK7); der Streifen kennt keine Nacht.
  await expect(weatherDays(page).nth(0).locator('.weather-icon__disc')).toHaveCount(1);
  await expect(page.locator('.weather-icon__moon')).toHaveCount(0);
});

test('jede Kategorie rendert ihre erwarteten Einzelelemente (issue #661 AK1)', async ({ page }) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);

  // DAY_SET_A.categories: Klar, Teils bewölkt, Bewölkt, Nebel, Regen, Schnee, Gewitter.
  await expect(weatherDays(page).nth(0).locator('.weather-icon__ray')).toHaveCount(8);
  await expect(weatherDays(page).nth(3).locator('.weather-icon__fog-line')).toHaveCount(2);
  await expect(weatherDays(page).nth(4).locator('.weather-icon__drop')).toHaveCount(3);
  await expect(weatherDays(page).nth(5).locator('.weather-icon__flake')).toHaveCount(2);
});

test('für jede der sieben Kategorien läuft im Streifen mindestens eine Endlos-Animation (issue #661 AK2)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);

  for (let i = 0; i < 7; i += 1) {
    const category = DAY_SET_A.categories[i];
    const selector = WEATHER_ICON_ANIMATED_SELECTOR[category];
    const { name, iterationCount } = await animationState(
      weatherDays(page).nth(i).locator(selector).first(),
    );
    expect(name, `${category}: ${selector}`).not.toBe('none');
    for (const count of iterationCount.split(',')) {
      expect(count.trim(), `${category}: ${selector}`).toBe('infinite');
    }
  }
});

test('App-Schalter „Bewegung reduzieren" stoppt die Wetter-Icon-Animationen (issue #661 AK4)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/einstellungen');
  await page.getByRole('switch', { name: 'Bewegung reduzieren' }).click();

  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);

  const { duration, iterationCount } = await animationState(
    weatherDays(page).first().locator('.weather-icon__disc'),
  );
  expect(parseFloat(duration)).toBeLessThan(0.001);
  expect(iterationCount).toBe('1');
});

test('OS-Einstellung „Bewegung reduzieren" stoppt die Wetter-Icon-Animationen ebenso (issue #661 AK5)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);

  const { duration, iterationCount } = await animationState(
    weatherDays(page).first().locator('.weather-icon__disc'),
  );
  expect(parseFloat(duration)).toBeLessThan(0.001);
  expect(iterationCount).toBe('1');
});

test('das Nebel-Icon ragt nicht mehr über die Zeichenfläche (issue #661 AK6)', async ({ page }) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);

  // Index 3 = Nebel (DAY_SET_A.codes[3] = 45).
  const fogSvg = weatherDays(page).nth(3).locator('.weather-forecast__icon svg');
  const bbox = await fogSvg.evaluate((el) => {
    const b = (el as unknown as SVGGraphicsElement).getBBox();
    return { y: b.y };
  });
  // Halbe Strichbreite (0.75) als Rand, getBBox() ignoriert die Strichbreite selbst.
  expect(bbox.y).toBeGreaterThanOrEqual(0.75);
});

test('beide Schneeflocken sind mittig, keine Flocke steht mehr schief (issue #661 AK7)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);

  // Index 5 = Schnee (DAY_SET_A.codes[5] = 73).
  const snowDay = weatherDays(page).nth(5);

  async function flakeCenter(className: string) {
    return snowDay.locator(`.${className}`).evaluate((el) => {
      const b = (el as unknown as SVGGraphicsElement).getBBox();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    });
  }

  const center1 = await flakeCenter('weather-icon__flake--1');
  expect(center1.x).toBeCloseTo(9, 1);
  expect(center1.y).toBeCloseTo(19, 1);

  const center2 = await flakeCenter('weather-icon__flake--2');
  expect(center2.x).toBeCloseTo(15, 1);
  expect(center2.y).toBeCloseTo(19, 1);
});

/* -------------------------------------------------------------------------- */
/* AK: Windmarker im 7-Tage-Streifen (issue #695)                             */
/* -------------------------------------------------------------------------- */

function windMark(page: Page) {
  return page.locator('.weather-forecast').getByRole('img', { name: 'windig' });
}

test('ein Tag mit Böen 60 km/h trägt ein Windzeichen, die anderen sechs nicht (issue #695 AC5)', async ({
  page,
}) => {
  const windySet: DaySet = { ...DAY_SET_A, windGustsMax: [60, 20, 20, 20, 20, 20, 20] };
  await mockForecast(page, windySet);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');

  const days = weatherDays(page);
  await expect(days).toHaveCount(7);

  await expect(days.nth(0).getByRole('img', { name: 'windig' })).toBeVisible();
  for (let i = 1; i < 7; i += 1) {
    await expect(days.nth(i).getByRole('img', { name: 'windig' })).toHaveCount(0);
  }
});

test('ein Tag mit Mittelwind 32 km/h und Böen 40 km/h trägt ebenfalls ein Windzeichen (issue #695 AC6)', async ({
  page,
}) => {
  const windySet: DaySet = {
    ...DAY_SET_A,
    windSpeedsMax: [12, 32, 12, 12, 12, 12, 12],
    windGustsMax: [20, 40, 20, 20, 20, 20, 20],
  };
  await mockForecast(page, windySet);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');

  const days = weatherDays(page);
  await expect(days).toHaveCount(7);
  await expect(days.nth(1).getByRole('img', { name: 'windig' })).toBeVisible();
});

test('ein Streifen ganz ohne windige Tage zeigt kein einziges Windzeichen (issue #695 AC7)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);

  await expect(windMark(page)).toHaveCount(0);
});

test('in einer windstillen Spalte sitzt der Wochentag exakt mittig in seiner Spalte (issue #695 AC8)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/uebersicht');

  const monday = weatherDays(page).nth(0);
  const weekdayBox = await monday.locator('.weather-forecast__weekday').boundingBox();
  const columnBox = await monday.boundingBox();
  expect(weekdayBox).toBeTruthy();
  expect(columnBox).toBeTruthy();

  const weekdayCenter = weekdayBox!.x + weekdayBox!.width / 2;
  const columnCenter = columnBox!.x + columnBox!.width / 2;
  expect(Math.abs(weekdayCenter - columnCenter)).toBeLessThanOrEqual(1);
});

test('die Höhe des Streifens ändert sich nicht, ob null oder zwei Tage windig sind (issue #695 AC9)', async ({
  page,
}) => {
  await mockForecast(page, DAY_SET_A);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);
  const heightWithoutWind = await page
    .locator('.weather-forecast__days')
    .evaluate((el) => el.getBoundingClientRect().height);

  const windySet: DaySet = { ...DAY_SET_A, windGustsMax: [60, 20, 20, 20, 60, 20, 20] };
  await page.unroute(OPEN_METEO_PATTERN);
  await mockForecast(page, windySet);
  await skewClock(page, '2026-07-20T13:00:00.000Z'); // past the 3h window, forces a refetch
  await page.reload();
  await expect(weatherDays(page)).toHaveCount(7);
  await expect(windMark(page)).toHaveCount(2);

  const heightWithWind = await page
    .locator('.weather-forecast__days')
    .evaluate((el) => el.getBoundingClientRect().height);

  expect(heightWithWind).toBeCloseTo(heightWithoutWind, 1);
});

test('bei 375 px bricht die Wochentagszeile in keiner Spalte um und läuft nicht über die Kartenbreite hinaus (issue #695 AC10)', async ({
  page,
}) => {
  const windySet: DaySet = { ...DAY_SET_A, windGustsMax: DAY_SET_A.dates.map(() => 60) };
  await mockForecast(page, windySet);
  await skewClock(page, NOW);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/uebersicht');

  const days = weatherDays(page);
  await expect(days).toHaveCount(7);
  await expect(windMark(page)).toHaveCount(7);

  for (let i = 0; i < 7; i += 1) {
    const linkBox = await days.nth(i).locator('.weather-forecast__day-link').boundingBox();
    const rowBox = await days.nth(i).locator('.weather-forecast__weekday-row').boundingBox();
    expect(linkBox).toBeTruthy();
    expect(rowBox).toBeTruthy();

    // Wrapped onto two lines would roughly double the row's height (14.4px text
    // line height, per the ticket) — well clear of this margin.
    expect(rowBox!.height).toBeLessThan(20);
    // Stays inside the card, doesn't spill past its edges.
    expect(rowBox!.x).toBeGreaterThanOrEqual(linkBox!.x - 0.5);
    expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(linkBox!.x + linkBox!.width + 0.5);
  }
});

test('im Dark Mode ist das Windzeichen sichtbar und übernimmt --text (issue #695 AC11)', async ({
  page,
}) => {
  const windySet: DaySet = { ...DAY_SET_A, windGustsMax: [60, 20, 20, 20, 20, 20, 20] };
  await mockForecast(page, windySet);
  await skewClock(page, NOW);
  await page.addInitScript(() => {
    document.documentElement.setAttribute('data-theme', 'dunkel');
  });
  await page.goto('/uebersicht');

  const wind = weatherDays(page).nth(0).locator('.weather-forecast__wind');
  await expect(wind).toBeVisible();

  // `--text` itself is a context variable since issue #832 (the page ground
  // overrides it, cards reset it back). `.weather-forecast__day` is a card, so
  // its `--text` resolves to the fixed `--text-base` — that's the value this
  // element actually renders, not whatever `--text` means at document level.
  const windColor = await wind.evaluate((el) => getComputedStyle(el).color);
  expect(windColor).toBe(await resolveColorToken(page, '--text-base'));
});

test('offline bleibt der Windmarker aus dem Cache erhalten (issue #695, Offline-Pfad — dieses Ticket schreibt nichts, es liest nur den Wetter-Cache)', async ({
  page,
}) => {
  const windySet: DaySet = { ...DAY_SET_A, windGustsMax: [60, 20, 20, 20, 20, 20, 20] };
  await mockForecast(page, windySet);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);
  await expect(windMark(page)).toHaveCount(1);

  // Same "offline" reproduction as the issue #139 AC2 test above: abort only the
  // Open-Meteo request, a full context.setOffline(true) would also block the
  // reload's own document request against the dev server.
  await page.unroute(OPEN_METEO_PATTERN);
  await page.route(OPEN_METEO_PATTERN, (route) => route.abort('failed'));
  await skewClock(page, NOW);
  await page.reload();

  await expect(weatherDays(page)).toHaveCount(7);
  await expect(windMark(page)).toHaveCount(1);
  await expect(weatherDays(page).nth(0).getByRole('img', { name: 'windig' })).toBeVisible();
});
