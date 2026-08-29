import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { openMeteoForecastBody, registerPasskey, resetAppData } from './helpers';

/**
 * Eine Figur je Route, zweifarbig nach Entwurfsblatt (S4 von #828, issue
 * #830, redraw issue #850). Ein Test je AK, gemessen per
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

/** Läuft `fn` über alle neun Routen — die acht angemeldeten auf `page`, Anmelden über einen frischen, ausgeloggten Kontext. */
async function forEachRoute(
  page: Page,
  browser: Browser,
  fn: (routePage: Page, face: string, path: string) => Promise<void>,
): Promise<void> {
  for (const route of ROUTES) {
    await page.goto(route.path);
    await fn(page, route.face, route.path);
  }

  const anmeldenContext = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: page.viewportSize() ?? undefined,
  });
  const anmeldenPage = await anmeldenContext.newPage();
  await anmeldenPage.goto('/anmelden');
  await fn(anmeldenPage, 'anmelden', '/anmelden');
  await anmeldenContext.close();
}

/**
 * getComputedStyle can serialize a colour back in a form that differs from
 * what was declared (e.g. oklch() vs. hex) — a 1×1 canvas sidesteps that
 * (same technique as grundfarbe.spec.ts/design-system.spec.ts, issue #709).
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

async function bodyFill(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.querySelector('.face__body')!).fill);
}

/** Fülle, wo vorhanden — sonst Kontur (geschlossene Bögen, z. B. Journal). */
async function inkColors(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const els = document.querySelectorAll('.face__eyes, .face__eyes *, .face__line, .face__line *');
    return Array.from(els).map((el) => {
      const style = getComputedStyle(el);
      return style.fill !== 'none' ? style.fill : style.stroke;
    });
  });
}

interface AnimationState {
  face: string;
  eyes: string[];
}

async function animationNames(page: Page): Promise<AnimationState> {
  return page.evaluate(() => ({
    face: getComputedStyle(document.querySelector('.face')!).animationName,
    eyes: Array.from(document.querySelectorAll('.face__eyes')).map((el) => getComputedStyle(el).animationName),
  }));
}

interface RestRects {
  face: { top: number; left: number };
  eyes: { top: number; left: number; width: number }[];
}

async function restRects(page: Page): Promise<RestRects> {
  return page.evaluate(() => {
    const faceRect = document.querySelector('.face')!.getBoundingClientRect();
    return {
      face: { top: Math.round(faceRect.top), left: Math.round(faceRect.left) },
      eyes: Array.from(document.querySelectorAll('.face__eyes')).map((el) => {
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width) };
      }),
    };
  });
}

type ShapeDesc =
  | { tag: 'path'; d: string }
  | { tag: 'circle'; cx: string; cy: string; r: string }
  | { tag: 'rect'; x: string; y: string; width: string; height: string; rx: string };

interface BodyGeometry {
  transform: string | null;
  shapes: ShapeDesc[];
}

async function bodyGeometry(page: Page): Promise<BodyGeometry> {
  return page.evaluate(() => {
    function describe(el: Element): ShapeDesc {
      const tag = el.tagName.toLowerCase();
      if (tag === 'path') return { tag: 'path', d: el.getAttribute('d') ?? '' };
      if (tag === 'circle') {
        return {
          tag: 'circle',
          cx: el.getAttribute('cx') ?? '',
          cy: el.getAttribute('cy') ?? '',
          r: el.getAttribute('r') ?? '',
        };
      }
      if (tag === 'rect') {
        return {
          tag: 'rect',
          x: el.getAttribute('x') ?? '',
          y: el.getAttribute('y') ?? '',
          width: el.getAttribute('width') ?? '',
          height: el.getAttribute('height') ?? '',
          rx: el.getAttribute('rx') ?? '',
        };
      }
      throw new Error(`unerwartetes Element im Figurenkörper: ${tag}`);
    }

    const body = document.querySelector('.face__body')!;
    const transform = body.getAttribute('transform');
    const shapes =
      body.tagName.toLowerCase() === 'path' ? [describe(body)] : Array.from(body.children).map(describe);
    return { transform, shapes };
  });
}

// Silhouetten aus dem Entwurfsblatt, wortgleich (issue #850) — Grundlage für AK1.
const EXPECTED_BODY: Record<string, BodyGeometry> = {
  uebersicht: {
    transform: null,
    shapes: [
      { tag: 'path', d: 'M32 3c15.5 0 26 10.5 26 26.5C58 47.5 46.5 61 32 61S6 47.5 6 29.5C6 13.5 16.5 3 32 3z' },
    ],
  },
  aufgaben: {
    transform: null,
    shapes: [{ tag: 'path', d: 'M32 5c19.5 0 27 7.5 27 27s-7.5 27-27 27S5 51.5 5 32 12.5 5 32 5z' }],
  },
  kalender: {
    transform: null,
    shapes: [{ tag: 'path', d: 'M32 6a26 26 0 0126 26v17a5 5 0 01-5 5H11a5 5 0 01-5-5V32A26 26 0 0132 6z' }],
  },
  routinen: {
    transform: 'scale(2.6667)',
    shapes: [
      {
        tag: 'path',
        d: 'M12 2.8c.4 2.6 1.9 4 3.2 5.4C16.7 9.8 18 11.4 18 13.8a6 6 0 0 1-12 0c0-1.9.7-3.3 1.7-4.5.2 1.3.8 2.1 1.6 2.5-.5-3.6.3-6.6 2.7-9z',
      },
    ],
  },
  journal: {
    transform: null,
    shapes: [{ tag: 'path', d: 'M32 9l19 12v22L32 55 13 43V21z' }],
  },
  aktivitaeten: {
    transform: null,
    shapes: [{ tag: 'path', d: 'M32 3c12.5 10.5 22.5 19 22.5 31.5a22.5 22.5 0 11-45 0C9.5 22 19.5 13.5 32 3z' }],
  },
  wetter: {
    transform: null,
    shapes: [
      { tag: 'circle', cx: '21', cy: '34', r: '14' },
      { tag: 'circle', cx: '41', cy: '30', r: '17' },
      { tag: 'rect', x: '9', y: '35', width: '46', height: '18', rx: '9' },
    ],
  },
  einstellungen: {
    transform: null,
    shapes: [
      { tag: 'circle', cx: '32.0', cy: '15.0', r: '12.5' },
      { tag: 'circle', cx: '46.7', cy: '23.5', r: '12.5' },
      { tag: 'circle', cx: '46.7', cy: '40.5', r: '12.5' },
      { tag: 'circle', cx: '32.0', cy: '49.0', r: '12.5' },
      { tag: 'circle', cx: '17.3', cy: '40.5', r: '12.5' },
      { tag: 'circle', cx: '17.3', cy: '23.5', r: '12.5' },
      { tag: 'circle', cx: '32', cy: '32', r: '17' },
    ],
  },
  anmelden: {
    transform: null,
    shapes: [
      {
        tag: 'path',
        d: 'M32.0 7.0L39.6 21.5L55.8 24.3L44.4 36.0L46.7 52.2L32.0 45.0L17.3 52.2L19.6 36.0L8.2 24.3L24.4 21.5Z',
      },
    ],
  },
};

// Farbpaar aus dem Entwurfsblatt (AK2/AK3) — dieselben Werte wie tokens.css.
const FACE_COLORS: Record<string, { body: string; ink: string }> = {
  uebersicht: { body: '#ffce00', ink: '#b84600' },
  aufgaben: { body: '#ffb020', ink: '#6b3200' },
  kalender: { body: '#9ad2ff', ink: '#093a90' },
  routinen: { body: '#ff7300', ink: '#7a2e00' },
  journal: { body: '#ffce00', ink: '#4a1d78' },
  aktivitaeten: { body: '#ffffff', ink: '#a86a00' },
  wetter: { body: '#ffffff', ink: '#14638f' },
  einstellungen: { body: '#ffc44d', ink: '#333d47' },
  anmelden: { body: '#ffffff', ink: '#ff7300' },
};

// Anmelden trägt die Figur groß über dem Titel statt der 42px-Zeile (issue
// #870 T3) — alle anderen acht Routen bleiben bei der halbhohen Kopfgröße.
const EXPECTED_FACE_SIZE: Record<string, number> = { anmelden: 136 };

test('AK1: die neun Silhouetten stimmen wortgleich mit dem Entwurfsblatt überein', async ({ page, browser }) => {
  await registerPasskey(page);

  const seenFaces = new Set<string>();
  await forEachRoute(page, browser, async (routePage, face, path) => {
    const el = routePage.locator('.face');
    await expect(el, `Figur-Anzahl auf ${path}`).toHaveCount(1);

    const dataFace = await el.getAttribute('data-face');
    expect(dataFace, `data-face auf ${path}`).toBe(face);
    expect(seenFaces.has(dataFace!), `Silhouette auf ${path} wiederholt eine vorherige Route`).toBe(false);
    seenFaces.add(dataFace!);

    expect(await el.getAttribute('viewBox'), `viewBox auf ${path}`).toBe('0 0 64 64');
    const overflow = await el.evaluate((n) => getComputedStyle(n).overflow);
    expect(overflow, `overflow auf ${path}`).toBe('visible');
    const box = await el.boundingBox();
    expect(box, `Bounding-Box auf ${path}`).not.toBeNull();
    const expectedSize = EXPECTED_FACE_SIZE[face] ?? 42;
    expect(Math.round(box!.width), `Breite auf ${path}`).toBe(expectedSize);
    expect(Math.round(box!.height), `Höhe auf ${path}`).toBe(expectedSize);

    const geometry = await bodyGeometry(routePage);
    expect(geometry, `Körper-Geometrie auf ${path}`).toEqual(EXPECTED_BODY[face]);
  });

  expect(seenFaces.size, 'neun paarweise verschiedene Silhouetten').toBe(9);
});

test('Regressions-Test (unverändert seit #830 AK2): die Figur steht im Fluss und überlappt weder Ring noch Aktionen auf der Übersicht', async ({
  page,
}) => {
  await registerPasskey(page);

  for (const route of ROUTES) {
    await page.goto(route.path);
    const face = page.locator('.face');
    await expect(face).toBeVisible();
    const position = await face.evaluate((el) => getComputedStyle(el).position);
    expect(['absolute', 'fixed'], `Figur auf ${route.path} ist kein positionierter Overlay`).not.toContain(
      position,
    );
  }

  await page.goto('/uebersicht');
  const face = page.locator('.face');
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

test('AK2: zwei Farben je Seite — Körper in --face-body, Augen/Mundlinie in --face-ink, keine gefüllte Grinsfläche mehr', async ({
  page,
  browser,
}) => {
  await registerPasskey(page);

  await forEachRoute(page, browser, async (routePage, face, path) => {
    const expected = FACE_COLORS[face];
    const bodyRgb = await toRgb(routePage, await bodyFill(routePage));
    expect(bodyRgb, `Körperfarbe auf ${path}`).toEqual(await toRgb(routePage, expected.body));

    const ink = await inkColors(routePage);
    expect(ink.length, `mindestens eine Tinten-Fläche auf ${path}`).toBeGreaterThan(0);
    for (const color of ink) {
      expect(await toRgb(routePage, color), `Augen-/Mundfarbe auf ${path}`).toEqual(
        await toRgb(routePage, expected.ink),
      );
    }

    const grinCount = await routePage.locator('[class*="grin"]').count();
    expect(grinCount, `keine gefüllte Grinsfläche mehr auf ${path}`).toBe(0);
  });

  // Basiswerte der Mundlinie (unüberschrieben, an der Übersicht geprüft):
  // Linie statt Fläche, Rundkappen, Basisbreite 4.
  await page.goto('/uebersicht');
  const mouth = page.locator('.face__line').first();
  const mouthStyle = await mouth.evaluate((el) => {
    const s = getComputedStyle(el);
    return { fill: s.fill, strokeWidth: s.strokeWidth, strokeLinecap: s.strokeLinecap };
  });
  expect(mouthStyle.fill).toBe('none');
  expect(mouthStyle.strokeWidth).toBe('4px');
  expect(mouthStyle.strokeLinecap).toBe('round');
});

test('AK3: dasselbe Farbpaar in Hell und Dunkel', async ({ page, browser }) => {
  await registerPasskey(page);

  await forEachRoute(page, browser, async (routePage, _face, path) => {
    const lightBody = await toRgb(routePage, await bodyFill(routePage));
    const lightInk = await toRgb(routePage, (await inkColors(routePage))[0]);

    await routePage.emulateMedia({ colorScheme: 'dark' });
    await routePage.goto(path);
    const darkBody = await toRgb(routePage, await bodyFill(routePage));
    const darkInk = await toRgb(routePage, (await inkColors(routePage))[0]);
    await routePage.emulateMedia({ colorScheme: 'light' });

    expect(darkBody, `Körperfarbe hell/dunkel auf ${path}`).toEqual(lightBody);
    expect(darkInk, `Tintenfarbe hell/dunkel auf ${path}`).toEqual(lightInk);
  });
});

test('AK4/AK5: die Figur blinzelt und wippt, OS-Präferenz und Schalter halten beides mit offenen Augen und ohne Versatz an', async ({
  page,
}) => {
  await registerPasskey(page);

  // Gegenprobe zuerst: ohne reduzierte Bewegung laufen Blink und Bob (nicht 'none').
  // Übersicht, nicht Einstellungen: Einstellungen' Figur hat ruhende, lachende
  // Augen (Bögen als .face__line) und blinzelt nie.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/uebersicht');
  const runningNames = await animationNames(page);
  expect(runningNames.face, 'Bob läuft ohne Reduce-Motion').not.toBe('none');
  expect(runningNames.eyes.length).toBeGreaterThan(0);
  expect(runningNames.eyes.some((name) => name !== 'none'), 'mindestens ein Augenpaar blinzelt').toBe(true);

  // (a) OS-Präferenz.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/uebersicht');
  const namesViaMedia = await animationNames(page);
  expect(namesViaMedia.face, 'Bob hält per OS-Präferenz an').toBe('none');
  expect(namesViaMedia.eyes.length).toBeGreaterThan(0);
  for (const name of namesViaMedia.eyes) expect(name).toBe('none');

  // Ruhe-offen, kein Versatz: kein Auge steht mitten im Blink, die Figur trägt
  // kein Bob-Delta (Basislinie vs. nach Umschalten).
  const baselineRects = await restRects(page);

  // (b) App-Schalter „Bewegung reduzieren" — ohne OS-Präferenz, damit dieser Teil
  // wirklich den Schalter prüft und nicht zufällig durch (a) mitläuft. Der
  // Schalter lebt auf /einstellungen, geprüft wird auf /uebersicht (blinzelnd+wippend).
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/einstellungen');
  const toggle = page.getByRole('switch', { name: 'Bewegung reduzieren' });
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'true');

  await page.goto('/uebersicht');
  const namesAfterToggle = await animationNames(page);
  expect(namesAfterToggle.face, 'Bob hält per App-Schalter an').toBe('none');
  expect(namesAfterToggle.eyes.length).toBeGreaterThan(0);
  for (const name of namesAfterToggle.eyes) expect(name).toBe('none');

  const afterToggleRects = await restRects(page);
  expect(afterToggleRects).toEqual(baselineRects);
});

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

test('AK6: kein Kopf läuft über, nachdem die 42-px-Figur eingezogen ist (375×812)', async ({ page }) => {
  await registerPasskey(page);
  for (const { path, header } of HEADERS) {
    await page.goto(path);
    const h = header(page);
    await expect(h).toBeVisible();
    const { scrollHeight, clientHeight } = await h.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(
      scrollHeight,
      `Kopf auf ${path}: scrollHeight ${scrollHeight} vs. clientHeight ${clientHeight}`,
    ).toBeLessThanOrEqual(clientHeight);
  }
});

test('AK7: die Figuren tragen aria-hidden auf allen neun Routen', async ({ page, browser }) => {
  await registerPasskey(page);
  await forEachRoute(page, browser, async (routePage, _face, path) => {
    await expect(routePage.locator('.face'), `aria-hidden auf ${path}`).toHaveAttribute('aria-hidden', 'true');
  });
});
