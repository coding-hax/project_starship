import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { openMeteoForecastBody, registerPasskey, resetAppData } from './helpers';

/**
 * Formsprache-Grundlage (issue #865, T1 von #860): zwei Radienrollen
 * (--radius-surface für schwebende Flächen, --radius-card für innenliegende
 * Elemente) + der neue Kartenschatten. Ein Test je AK, gemessen per
 * getComputedStyle statt per Augenschein.
 */

const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';
const GARMIN_SYNC_PATTERN = '**/api/garmin-sync';

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // /uebersicht und /aktivitaeten lösen beim Laden echte Netzaufrufe aus, die
  // ungemockt als Konsolenfehler/Dev-Overlay im DOM landen (siehe grundfarbe.spec.ts).
  await page.route(GARMIN_SYNC_PATTERN, (route) =>
    route.fulfill({
      json: { scanned: 0, created: 0, updated: 0, detailsFilled: 0, mapsFilled: 0 },
    }),
  );
  await page.route(OPEN_METEO_PATTERN, (route) =>
    route.fulfill({
      json: openMeteoForecastBody({ dates: ['2026-07-18'], tempsMax: [20], tempsMin: [10] }),
    }),
  );
});

/** Mirrors grundfarbe.spec.ts's own probe-span technique for a var()-resolved value. */
async function resolveRadiusToken(page: Page, token: string): Promise<string> {
  return page.evaluate((cssVar) => {
    const probe = document.createElement('span');
    probe.style.borderRadius = `var(${cssVar})`;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).borderRadius;
    probe.remove();
    return value;
  }, token);
}

async function resolveShadowToken(page: Page, token: string): Promise<string> {
  return page.evaluate((cssVar) => {
    const probe = document.createElement('span');
    probe.style.boxShadow = `var(${cssVar})`;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).boxShadow;
    probe.remove();
    return value;
  }, token);
}

async function elementRadius(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).borderRadius);
}

async function elementShadow(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).boxShadow);
}

interface RouteCase {
  path: string;
  /** Der Kopf-Container: Titelzeile + optionaler Zusatz (Ring, Datum, Suchknopf). */
  header: (page: Page) => Locator;
}

// Acht der neun authentifizierten Routen — Anmelden braucht einen ausgeloggten
// Kontext und bekommt seinen eigenen Eintrag über forEachRoute unten (Vorlage:
// figuren.spec.ts, seitenkopf.spec.ts).
const ROUTES: RouteCase[] = [
  { path: '/uebersicht', header: (page) => page.locator('.uebersicht__title-row') },
  { path: '/aufgaben', header: (page) => page.getByRole('heading', { level: 1, name: 'Aufgaben' }) },
  { path: '/kalender', header: (page) => page.locator('.calendar-view__header') },
  {
    path: '/routinen',
    header: (page) => page.getByRole('heading', { level: 1, name: 'Routinen' }),
  },
  { path: '/journal', header: (page) => page.locator('.journal-page__title-row') },
  {
    path: '/aktivitaeten',
    header: (page) => page.getByRole('heading', { level: 1, name: 'Aktivitäten' }),
  },
  { path: '/wetter/2026-07-18', header: (page) => page.locator('.weather-day__topbar') },
  { path: '/einstellungen', header: (page) => page.locator('.einstellungen__topbar') },
];

/** Läuft `fn` über alle neun Routen im gegebenen Theme — die acht angemeldeten auf
 * `page`, Anmelden über einen frischen, ausgeloggten Kontext. `colorScheme` wird
 * vor jeder Navigation gesetzt, damit auch Mount-Zeit-JS (z. B. use-appearance.ts)
 * die richtige Systempräferenz sieht (Vorlage: figuren.spec.ts AK3). */
async function forEachRoute(
  page: Page,
  browser: Browser,
  colorScheme: 'light' | 'dark',
  fn: (routePage: Page, path: string, header: Locator) => Promise<void>,
): Promise<void> {
  await page.emulateMedia({ colorScheme });
  for (const route of ROUTES) {
    await page.goto(route.path);
    await fn(page, route.path, route.header(page));
  }

  const anmeldenContext = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: page.viewportSize() ?? undefined,
    colorScheme,
  });
  const anmeldenPage = await anmeldenContext.newPage();
  await anmeldenPage.goto('/anmelden');
  const header = anmeldenPage.getByRole('heading', { level: 1 });
  await fn(anmeldenPage, '/anmelden', header);
  await anmeldenContext.close();
}

async function assertNoOverflow(routePage: Page, header: Locator, label: string) {
  const { scrollWidth, clientWidth } = await routePage.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `waagerechter Überlauf auf ${label}`).toBeLessThanOrEqual(clientWidth);

  await expect(header).toBeVisible();
  const { scrollHeight, clientHeight } = await header.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(
    scrollHeight,
    `Kopf auf ${label}: scrollHeight ${scrollHeight} vs. clientHeight ${clientHeight}`,
  ).toBeLessThanOrEqual(clientHeight);
}

test('AK1: zwei Radienrollen — Fläche 28px (.section-card), innen 14px (.calendar-strip__day)', async ({
  page,
}) => {
  await registerPasskey(page);

  await page.goto('/einstellungen');
  const surfaceToken = await resolveRadiusToken(page, '--radius-surface');
  expect(surfaceToken).toBe('28px');
  const surfaceCard = page.locator('.section-card').first();
  await expect(surfaceCard).toBeVisible();
  expect(await elementRadius(surfaceCard)).toBe(surfaceToken);

  await page.goto('/kalender');
  const cardToken = await resolveRadiusToken(page, '--radius-card');
  expect(cardToken).toBe('14px');
  const innerCell = page.locator('.calendar-strip__day').first();
  await expect(innerCell).toBeVisible();
  expect(await elementRadius(innerCell)).toBe(cardToken);
});

test('AK2: der neue Kartenschatten liegt auf einer schwebenden Fläche (.section-card)', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/einstellungen');

  const shadowToken = await resolveShadowToken(page, '--shadow-raised');
  const surfaceCard = page.locator('.section-card').first();
  await expect(surfaceCard).toBeVisible();
  expect(await elementShadow(surfaceCard)).toBe(shadowToken);
});

// Zwei Tests statt einem gemeinsamen: ein Durchlauf über alle neun Routen inklusive
// eigenem Anmelden-Kontext braucht bereits einen Teil des Standard-Testtimeouts (30s);
// Hell und Dunkel im selben Test hintereinander lief unter CI-Last in den Timeout
// (net::ERR_ABORTED beim Goto mitten im zweiten Durchlauf).
for (const scheme of ['light', 'dark'] as const) {
  const label = scheme === 'light' ? 'Hell' : 'Dunkel';
  test(`AK-Ü: kein Überlauf nach dem Radien-/Schattenwechsel, ${label}, alle neun Routen`, async ({
    page,
    browser,
  }) => {
    await registerPasskey(page);

    await forEachRoute(page, browser, scheme, async (routePage, path, header) => {
      await assertNoOverflow(routePage, header, `${path} (${scheme})`);
    });
  });
}
