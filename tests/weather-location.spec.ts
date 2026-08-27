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

/** The "Aktueller Ort" row's value — Row puts label and control in sibling divs, so
 * `getByText('Aktueller Ort')` alone would never reach the value next to it. */
function currentPlace(page: Page) {
  return page.locator('.row', { hasText: 'Aktueller Ort' }).locator('.row__control');
}

/** Reads the weather cache directly — there is no app bridge for it, and adding one
 * just for a test would be more surface than the assertion needs. */
async function weatherCacheKeys(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const request = indexedDB.open('starship');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('weather', 'readonly');
          const getAllKeysReq = tx.objectStore('weather').getAllKeys();
          getAllKeysReq.onsuccess = () => resolve(getAllKeysReq.result as string[]);
          getAllKeysReq.onerror = () => reject(getAllKeysReq.error);
        };
      }),
  );
}

/** Stubs `navigator.geolocation` to resolve `coords` after `delayMs` — the real
 * CDP `setGeolocation` has no delay knob, and the waiting-state AK (#853 AC3)
 * needs a window in which the request is deterministically still in flight. */
async function stubDelayedGeolocation(
  page: Page,
  coords: { latitude: number; longitude: number },
  delayMs: number,
) {
  await page.addInitScript(
    ({ coords, delayMs }) => {
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: {
          getCurrentPosition: (success: (position: GeolocationPosition) => void) => {
            setTimeout(() => {
              success({
                coords: {
                  ...coords,
                  accuracy: 1,
                  altitude: null,
                  altitudeAccuracy: null,
                  heading: null,
                  speed: null,
                },
                timestamp: Date.now(),
              } as GeolocationPosition);
            }, delayMs);
          },
        },
      });
    },
    { coords, delayMs },
  );
}

/** Stubs `navigator.geolocation` to fail immediately with the given error code
 * (1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT) — #853 AC4
 * covers both "abgelehnt" and "keine Position", which need the same hint. */
async function stubGeolocationError(page: Page, code: 1 | 2 | 3) {
  await page.addInitScript((code) => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (
          _success: (position: GeolocationPosition) => void,
          error: (positionError: GeolocationPositionError) => void,
        ) => {
          error({ code, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: 'stub' });
        },
      },
    });
  }, code);
}

const LOCATE_ERROR_HINT =
  'Standort ist für diese Seite gesperrt. In den iOS-Einstellungen unter Safari › Ort wieder erlauben — oder den Ort hier suchen.';

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // Default: abort both Open-Meteo endpoints. Tests register a later, more specific
  // route when they need a response (Playwright: last-registered matching route wins).
  await page.route(GEOCODING_PATTERN, (route) => route.abort('failed'));
  await page.route(FORECAST_PATTERN, (route) => route.abort('failed'));
  await registerPasskey(page);
});

/* -------------------------------------------------------------------------- */
/* AK: Ohne Zutun gilt weiterhin Bonn                                          */
/* -------------------------------------------------------------------------- */

test('ohne Zutun gilt weiterhin Bonn (issue #159 AC2)', async ({ page }) => {
  await page.goto('/einstellungen');
  await expect(currentPlace(page)).toHaveText('Bonn');
});

/* -------------------------------------------------------------------------- */
/* AK: Ort suchen und auswählen, Name + Koordinaten werden gespeichert         */
/* -------------------------------------------------------------------------- */

test('ein Ort lässt sich suchen und auswählen; die Auswahl bleibt nach Reload erhalten (issue #159 AC1)', async ({
  page,
}) => {
  await mockGeocoding(page, { Berlin: [BERLIN] });
  await page.goto('/einstellungen');

  await page.getByLabel('Ort suchen').fill('Berlin');
  await page.getByRole('button', { name: 'Suchen' }).click();

  const result = page.getByRole('button', { name: 'Berlin, Berlin, Deutschland' });
  await expect(result).toBeVisible();
  await result.click();

  await expect(currentPlace(page)).toHaveText('Berlin');

  await page.reload();
  await expect(currentPlace(page)).toHaveText('Berlin');
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
  await expect(page.locator('.weather-forecast__location')).toHaveText('Berlin');
  await expect(page.locator('.weather-forecast')).toHaveAttribute(
    'aria-label',
    'Wettervorhersage Berlin, sieben Tage',
  );
});

/* -------------------------------------------------------------------------- */
/* AK: Die Suche legt nichts in Dexie ab; nur der gewählte Ort wird gespeichert */
/* -------------------------------------------------------------------------- */

test('die Suche legt nichts in Dexie ab, nur der gewählte Ort wird gespeichert (issue #159 AC6)', async ({
  page,
}) => {
  await mockForecastByLocation(page, [
    { latitude: BONN.latitude, longitude: BONN.longitude, body: BONN_FORECAST },
  ]);
  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);
  expect(await weatherCacheKeys(page)).toHaveLength(1);

  await mockGeocoding(page, {
    Paris: [
      { name: 'Paris', admin1: 'Île-de-France', country: 'Frankreich', latitude: 48.85341, longitude: 2.3488 },
    ],
  });
  await page.goto('/einstellungen');
  await page.getByLabel('Ort suchen').fill('Paris');
  await page.getByRole('button', { name: 'Suchen' }).click();
  await expect(page.getByRole('button', { name: /^Paris,/ })).toBeVisible();

  // No selection was made — searching alone must not touch the weather cache.
  expect(await weatherCacheKeys(page)).toHaveLength(1);
  await expect(currentPlace(page)).toHaveText('Bonn');

  await page.reload();
  await expect(currentPlace(page)).toHaveText('Bonn');
});

/* -------------------------------------------------------------------------- */
/* AK: Ohne Netz zeigt die Suche einen erklärenden Zustand, die Auswahl bleibt */
/* -------------------------------------------------------------------------- */

test('ohne Netz zeigt die Suche einen erklärenden Zustand; die zuletzt gewählte Einstellung bleibt (issue #159 AC7)', async ({
  page,
}) => {
  await page.goto('/einstellungen');

  await page.getByLabel('Ort suchen').fill('Hamburg');
  await page.getByRole('button', { name: 'Suchen' }).click();

  await expect(page.getByText('Ohne Netz kann kein Ort gesucht werden.')).toBeVisible();
  await expect(currentPlace(page)).toHaveText('Bonn');
});

/* -------------------------------------------------------------------------- */
/* AK: Eine Suche ohne Treffer sagt das, statt eine leere Liste zu zeigen      */
/* -------------------------------------------------------------------------- */

test('eine Suche ohne Treffer sagt das, statt eine leere Liste zu zeigen (issue #159 AC8)', async ({
  page,
}) => {
  await mockGeocoding(page, { Nichtsstadt: [] });
  await page.goto('/einstellungen');

  await page.getByLabel('Ort suchen').fill('Nichtsstadt');
  await page.getByRole('button', { name: 'Suchen' }).click();

  await expect(page.getByText('Keine Treffer für „Nichtsstadt“.')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* AK: Semantische Tokens, auch im Dark Mode (DESIGN_SYSTEM)                   */
/* -------------------------------------------------------------------------- */

test('der Suchen-Button nutzt den --accent-Token, auch im Dark Mode (issue #159 AC10)', async ({
  page,
}) => {
  await page.goto('/einstellungen');
  const button = page.getByRole('button', { name: 'Suchen' });

  const resolveToken = () =>
    page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--accent)';
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });

  const lightBg = await button.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(lightBg).toBe(await resolveToken());

  await page.emulateMedia({ colorScheme: 'dark' });
  const darkBg = await button.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(darkBg).toBe(await resolveToken());
  expect(darkBg).not.toBe(lightBg);
});

/* -------------------------------------------------------------------------- */
/* AK1 (#853): Knopf „Aktuellen Standort verwenden" zwischen Ort und Suche     */
/* -------------------------------------------------------------------------- */

test('zwischen „Aktueller Ort" und dem Suchfeld steht der Knopf „Aktuellen Standort verwenden" (issue #853 AC1)', async ({
  page,
}) => {
  await page.goto('/einstellungen');

  const locateButton = page.getByRole('button', { name: 'Aktuellen Standort verwenden' });
  await expect(locateButton).toBeVisible();

  const isBetween = await page.evaluate(() => {
    const ortRow = document.querySelector('.row');
    const button = document.querySelector('.weather-panel__locate-button');
    const searchInput = document.querySelector('.weather-panel__search-input');
    if (!ortRow || !button || !searchInput) return false;
    const afterOrt = !!(ortRow.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING);
    const beforeSearch = !!(button.compareDocumentPosition(searchInput) & Node.DOCUMENT_POSITION_FOLLOWING);
    return afterOrt && beforeSearch;
  });
  expect(isBetween).toBe(true);
});

/* -------------------------------------------------------------------------- */
/* AK2 (#853): Standortfreigabe erteilt -> „Aktueller Standort" + GPS-Koordinaten */
/* -------------------------------------------------------------------------- */

test('nach erteilter Standortfreigabe steht „Aktueller Standort" da und der Forecast-Request trägt die GPS-Koordinaten, nicht Bonn (issue #853 AC2)', async ({
  page,
  context,
}) => {
  const GPS = { latitude: 48.1351, longitude: 11.582 };
  const GPS_FORECAST = forecastBody([18, 18, 18, 18, 18, 18, 18], [9, 9, 9, 9, 9, 9, 9]);
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(GPS);
  await mockForecastByLocation(page, [{ ...GPS, body: GPS_FORECAST }]);

  await page.goto('/einstellungen');
  await page.getByRole('button', { name: 'Aktuellen Standort verwenden' }).click();
  await expect(currentPlace(page)).toHaveText('Aktueller Standort');

  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);
  await expect(weatherDays(page).first().locator('.weather-forecast__temp-max')).toHaveText('18°');
});

/* -------------------------------------------------------------------------- */
/* AK3 (#853): Während die Abfrage läuft, zeigt der Knopf einen Wartezustand   */
/* -------------------------------------------------------------------------- */

test('während die Standortabfrage läuft, zeigt der Knopf einen Wartezustand und ist dabei deaktiviert (issue #853 AC3)', async ({
  page,
}) => {
  await stubDelayedGeolocation(page, { latitude: 48.1351, longitude: 11.582 }, 3000);
  await page.goto('/einstellungen');

  const idleButton = page.getByRole('button', { name: 'Aktuellen Standort verwenden' });
  await idleButton.click();

  const busyButton = page.getByRole('button', { name: 'Standort wird ermittelt …' });
  await expect(busyButton).toBeVisible();
  await expect(busyButton).toBeDisabled();
  // A disabled button cannot receive a real click — the browser itself is the
  // guard against triggering the request a second time while it is in flight.

  await expect(page.getByRole('button', { name: 'Aktuellen Standort verwenden' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Aktuellen Standort verwenden' })).toBeEnabled();
});

/* -------------------------------------------------------------------------- */
/* AK4 (#853): Verweigert oder keine Position -> Ort bleibt, Hinweis erklärt   */
/* -------------------------------------------------------------------------- */

test('lehne ich die Standortfreigabe ab, bleibt der Ort unverändert und ein Hinweis erklärt den Rückweg (issue #853 AC4)', async ({
  page,
}) => {
  // No context.grantPermissions() call — Chromium under automation denies the
  // request outright instead of hanging on an unresolvable prompt.
  await page.goto('/einstellungen');
  await page.getByRole('button', { name: 'Aktuellen Standort verwenden' }).click();

  await expect(page.getByText(LOCATE_ERROR_HINT)).toBeVisible();
  await expect(currentPlace(page)).toHaveText('Bonn');
});

test('liefert das Gerät keine Position, bleibt der Ort unverändert und derselbe Hinweis erscheint (issue #853 AC4)', async ({
  page,
}) => {
  await stubGeolocationError(page, 2); // POSITION_UNAVAILABLE
  await page.goto('/einstellungen');
  await page.getByRole('button', { name: 'Aktuellen Standort verwenden' }).click();

  await expect(page.getByText(LOCATE_ERROR_HINT)).toBeVisible();
  await expect(currentPlace(page)).toHaveText('Bonn');
});

/* -------------------------------------------------------------------------- */
/* AK6 (#853): GPS-Ort bleibt nach Reload erhalten, ohne erneute Standortabfrage */
/* -------------------------------------------------------------------------- */

test('der GPS-Ort bleibt nach einem Reload erhalten, die Vorhersage lädt ohne erneute Standortabfrage (issue #853 AC6)', async ({
  page,
  context,
}) => {
  const GPS = { latitude: 41.9028, longitude: 12.4964 };
  const GPS_FORECAST = forecastBody([25, 25, 25, 25, 25, 25, 25], [15, 15, 15, 15, 15, 15, 15]);
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(GPS);
  await mockForecastByLocation(page, [{ ...GPS, body: GPS_FORECAST }]);

  await page.goto('/einstellungen');
  await page.getByRole('button', { name: 'Aktuellen Standort verwenden' }).click();
  await expect(currentPlace(page)).toHaveText('Aktueller Standort');

  // Revoking permission before the reload proves persistence does not depend on
  // asking again: a re-prompt on load would surface as the denied hint below,
  // not as a working forecast for the same coordinates.
  await context.clearPermissions();

  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);
  await expect(weatherDays(page).first().locator('.weather-forecast__temp-max')).toHaveText('25°');

  await page.goto('/einstellungen');
  await expect(currentPlace(page)).toHaveText('Aktueller Standort');
});

/* -------------------------------------------------------------------------- */
/* AK7 (#853): Suche „Berlin" ersetzt den GPS-Ort                              */
/* -------------------------------------------------------------------------- */

test('eine anschließend über die Suche gewählte Stadt ersetzt den GPS-Ort (issue #853 AC7)', async ({
  page,
  context,
}) => {
  const GPS = { latitude: 52.0, longitude: 8.5 };
  const GPS_FORECAST = forecastBody([12, 12, 12, 12, 12, 12, 12], [4, 4, 4, 4, 4, 4, 4]);
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(GPS);
  await mockForecastByLocation(page, [{ ...GPS, body: GPS_FORECAST }]);

  await page.goto('/einstellungen');
  await page.getByRole('button', { name: 'Aktuellen Standort verwenden' }).click();
  await expect(currentPlace(page)).toHaveText('Aktueller Standort');

  await mockGeocoding(page, { Berlin: [BERLIN] });
  await page.getByLabel('Ort suchen').fill('Berlin');
  await page.getByRole('button', { name: 'Suchen' }).click();
  await page.getByRole('button', { name: 'Berlin, Berlin, Deutschland' }).click();

  await expect(currentPlace(page)).toHaveText('Berlin');
});
