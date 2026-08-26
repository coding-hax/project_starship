import { expect, test, type Locator, type Page } from '@playwright/test';
import { openMeteoForecastBody, registerPasskey, resetAppData } from './helpers';

/**
 * Eine Figur je Route (S4 von #828, issue #830). Ein Test je AK, gemessen per
 * getComputedStyle/getBoundingClientRect statt per Augenschein — dieselbe
 * Vorlage wie hintergrundkreise.spec.ts (Routen-Iteration, Reduce-Motion) und
 * grundfarbe.spec.ts (contrastRatio/toRgb).
 */
test.describe.configure({ timeout: 120_000 });

const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';
const GARMIN_SYNC_PATTERN = '**/api/garmin-sync';

test.beforeEach(async ({ page }) => {
  await resetAppData();
  await page.route(GARMIN_SYNC_PATTERN, (route) =>
    route.fulfill({
      json: { scanned: 0, created: 0, updated: 0, detailsFilled: 0, mapsFilled: 0 },
    }),
  );
  await page.route(OPEN_METEO_PATTERN, (route) =>
    route.fulfill({
      json: openMeteoForecastBody({
        dates: ['2026-07-18'],
        tempsMax: [20],
        tempsMin: [10],
      }),
    }),
  );
});

interface RouteCase {
  face: string;
  path: string;
}

// Die acht angemeldeten Routen — Anmelden braucht einen ausgeloggten Kontext
// (eingeloggt leitet die Route sofort auf /uebersicht um) und bekommt in den
// betroffenen Tests einen eigenen `browser.newContext()`.
const ROUTES: RouteCase[] = [
  { face: 'uebersicht', path: '/uebersicht' },
  { face: 'aufgaben', path: '/aufgaben' },
  { face: 'kalender', path: '/kalender' },
  { face: 'routinen', path: '/routinen' },
  { face: 'journal', path: '/journal' },
  { face: 'aktivitaeten', path: '/aktivitaeten' },
  { face: 'wetter', path: '/wetter/2026-07-18' },
  { face: 'einstellungen', path: '/einstellungen' },
];

function relativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/** WCAG contrast ratio (1–21) between two 0–255 sRGB byte tuples. */
function contrastRatio(rgbA: [number, number, number], rgbB: [number, number, number]): number {
  const [la, lb] = [relativeLuminance(...rgbA), relativeLuminance(...rgbB)];
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * getComputedStyle can serialize an oklch()-declared colour back as oklch()
 * rather than rgb() — a 1×1 canvas sidesteps that (same technique as
 * grundfarbe.spec.ts/design-system.spec.ts, issue #709).
 */
async function toRgb(page: Page, color: string): Promise<[number, number, number]> {
  return page.evaluate((c) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b] as [number, number, number];
  }, color);
}

async function htmlBackground(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
}

async function bodyFill(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.querySelector('.page-face__body')!).fill);
}

async function eyeAnimationNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.page-face__eye')).map((el) => getComputedStyle(el).animationName),
  );
}

interface EyeRect {
  top: number;
  left: number;
  width: number;
}

async function eyeRects(page: Page): Promise<EyeRect[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.page-face__eye')).map((el) => {
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width) };
    }),
  );
}

test('AK1: jede der neun Routen zeigt genau eine Figur, keine Silhouette wiederholt sich', async ({
  page,
  browser,
}) => {
  await registerPasskey(page);

  const seenFaces = new Set<string>();
  for (const route of ROUTES) {
    await page.goto(route.path);
    const faces = page.locator('.page-face');
    await expect(faces, `Figur-Anzahl auf ${route.path}`).toHaveCount(1);
    const dataFace = await faces.getAttribute('data-face');
    expect(dataFace, `data-face auf ${route.path}`).toBe(route.face);
    expect(seenFaces.has(dataFace!), `Silhouette auf ${route.path} wiederholt eine vorherige Route`).toBe(
      false,
    );
    seenFaces.add(dataFace!);
  }

  const anmeldenContext = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: page.viewportSize() ?? undefined,
  });
  const anmeldenPage = await anmeldenContext.newPage();
  await anmeldenPage.goto('/anmelden');
  const anmeldenFaces = anmeldenPage.locator('.page-face');
  await expect(anmeldenFaces, 'Figur-Anzahl auf /anmelden').toHaveCount(1);
  const anmeldenFace = await anmeldenFaces.getAttribute('data-face');
  expect(anmeldenFace).toBe('anmelden');
  expect(seenFaces.has(anmeldenFace!), 'Silhouette auf /anmelden wiederholt eine andere Route').toBe(false);
  seenFaces.add(anmeldenFace!);

  expect(seenFaces.size, 'neun paarweise verschiedene Silhouetten').toBe(9);
  await anmeldenContext.close();
});

test('AK2: die Figur steht im Fluss und überlappt weder Ring noch Aktionen auf der Übersicht', async ({
  page,
}) => {
  await registerPasskey(page);

  for (const route of ROUTES) {
    await page.goto(route.path);
    const face = page.locator('.page-face');
    await expect(face).toBeVisible();
    const position = await face.evaluate((el) => getComputedStyle(el).position);
    expect(['absolute', 'fixed'], `Figur auf ${route.path} ist kein positionierter Overlay`).not.toContain(
      position,
    );
  }

  await page.goto('/uebersicht');
  const face = page.locator('.page-face');
  const ring = page.locator('.daily-progress-ring-slot');
  const actions = page.locator('.uebersicht__title-actions');
  const [faceBox, ringBox, actionsBox] = await Promise.all([
    face.boundingBox(),
    ring.boundingBox(),
    actions.boundingBox(),
  ]);
  expect(faceBox).not.toBeNull();
  expect(ringBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();

  function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  }

  expect(overlaps(faceBox!, ringBox!), 'Figur und Fortschrittsring überlappen sich nicht').toBe(false);
  expect(overlaps(faceBox!, actionsBox!), 'Figur und Aktionsbündel überlappen sich nicht').toBe(false);
});

test('AK3: der Körper der Figur erfüllt 3:1 gegen den Grund, hell und dunkel', async ({ page }) => {
  await registerPasskey(page);

  for (const route of ROUTES) {
    await page.goto(route.path);
    const ground = await htmlBackground(page);
    const fill = await bodyFill(page);
    expect(
      contrastRatio(await toRgb(page, fill), await toRgb(page, ground)),
      `Kontrast Figur/Grund auf ${route.path}`,
    ).toBeGreaterThanOrEqual(3.0);
  }

  await page.emulateMedia({ colorScheme: 'dark' });
  for (const route of ROUTES) {
    await page.goto(route.path);
    const ground = await htmlBackground(page);
    const fill = await bodyFill(page);
    expect(
      contrastRatio(await toRgb(page, fill), await toRgb(page, ground)),
      `Dunkelmodus-Kontrast Figur/Grund auf ${route.path}`,
    ).toBeGreaterThanOrEqual(3.0);
  }
});

test('AK4: die Augen blinzeln unregelmäßig, OS-Präferenz und Schalter halten sie mit offenen Augen an', async ({
  page,
}) => {
  await registerPasskey(page);

  // Gegenprobe zuerst: ohne reduzierte Bewegung läuft der Blink (nicht 'none').
  // Übersicht, nicht Einstellungen: Einstellungen' Figur hat ruhende, lachende
  // Augen (Bögen) und blinzelt nie — der AK4-Test läuft deshalb auf einer
  // tatsächlich blinzelnden Route (Planvorgabe).
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/uebersicht');
  const namesRunning = await eyeAnimationNames(page);
  expect(namesRunning.length).toBeGreaterThan(0);
  expect(namesRunning.some((name) => name !== 'none'), 'mindestens ein Auge blinzelt ohne Reduce-Motion').toBe(
    true,
  );

  // (a) OS-Präferenz.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/uebersicht');
  const namesViaMedia = await eyeAnimationNames(page);
  expect(namesViaMedia.length).toBeGreaterThan(0);
  for (const name of namesViaMedia) expect(name).toBe('none');

  // Ruhe-offen: kein Auge steht mitten im Blink (Basislinie vs. nach Umschalten).
  const baselineRects = await eyeRects(page);

  // (b) App-Schalter „Bewegung reduzieren" — ohne OS-Präferenz, damit dieser Teil
  // wirklich den Schalter prüft und nicht zufällig durch (a) mitläuft. Der
  // Schalter lebt auf /einstellungen, geprüft wird auf /uebersicht (blinzelnd).
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/einstellungen');
  const toggle = page.getByRole('switch', { name: 'Bewegung reduzieren' });
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'true');

  await page.goto('/uebersicht');
  const namesAfterToggle = await eyeAnimationNames(page);
  expect(namesAfterToggle.length).toBeGreaterThan(0);
  for (const name of namesAfterToggle) expect(name).toBe('none');

  const afterToggleRects = await eyeRects(page);
  expect(afterToggleRects).toEqual(baselineRects);
});

test('AK5: die Figuren tragen aria-hidden auf allen neun Routen', async ({ page, browser }) => {
  await registerPasskey(page);
  for (const route of ROUTES) {
    await page.goto(route.path);
    await expect(page.locator('.page-face')).toHaveAttribute('aria-hidden', 'true');
  }

  const anmeldenContext = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: page.viewportSize() ?? undefined,
  });
  const anmeldenPage = await anmeldenContext.newPage();
  await anmeldenPage.goto('/anmelden');
  await expect(anmeldenPage.locator('.page-face')).toHaveAttribute('aria-hidden', 'true');
  await anmeldenContext.close();
});

// Regressions-Gate: die Figur darf keinen Kopf überlaufen lassen — dieselbe
// Messung wie seitenkopf.spec.ts AK5, nur noch einmal hier direkt neben AK1–5
// abgeprüft, damit ein Fehlschlag sofort dieser Ticketgruppe zugeordnet wird.
interface HeaderCase {
  path: string;
  header: (page: Page) => Locator;
}

const HEADERS: HeaderCase[] = [
  { path: '/uebersicht', header: (page) => page.locator('.uebersicht__title-row') },
  { path: '/aufgaben', header: (page) => page.locator('.aufgaben-page__title-row') },
  { path: '/kalender', header: (page) => page.locator('.calendar-view__header') },
  { path: '/routinen', header: (page) => page.locator('.page-face-row') },
  { path: '/journal', header: (page) => page.locator('.journal-page__title-row') },
  { path: '/aktivitaeten', header: (page) => page.locator('.page-face-row') },
  { path: '/wetter/2026-07-18', header: (page) => page.locator('.weather-day__topbar') },
  { path: '/einstellungen', header: (page) => page.locator('.einstellungen__topbar') },
];

test('Regressions-Gate: kein Kopf läuft über, nachdem die Figur eingezogen ist (375×812)', async ({
  page,
}) => {
  await registerPasskey(page);
  for (const { path, header } of HEADERS) {
    await page.goto(path);
    const h = header(page);
    await expect(h).toBeVisible();
    const { scrollHeight, clientHeight } = await h.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(scrollHeight, `Kopf auf ${path}: scrollHeight ${scrollHeight} vs. clientHeight ${clientHeight}`).toBeLessThanOrEqual(
      clientHeight,
    );
  }
});
