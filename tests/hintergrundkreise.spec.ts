import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData } from './helpers';

/**
 * Hintergrundkreise, eine Gangart je Route (S3 von #828, issue #829). Ein Test
 * je AK, gemessen per getComputedStyle/getBoundingClientRect statt per Augenschein.
 */

const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';
const GARMIN_SYNC_PATTERN = '**/api/garmin-sync';

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // /aktivitaeten stößt beim Öffnen /api/garmin-sync an, /uebersicht holt Wetter —
  // ungemockt leckt der echte Fetch in jeden Test, der eine dieser Routen besucht
  // (dieselben Mocks wie grundfarbe.spec.ts).
  await page.route(GARMIN_SYNC_PATTERN, (route) =>
    route.fulfill({
      json: { scanned: 0, created: 0, updated: 0, detailsFilled: 0, mapsFilled: 0 },
    }),
  );
  await page.route(OPEN_METEO_PATTERN, (route) =>
    route.fulfill({
      json: {
        daily: {
          time: ['2026-07-18'],
          weather_code: [0],
          temperature_2m_max: [20],
          temperature_2m_min: [10],
          precipitation_probability_max: [0],
          sunrise: ['2026-07-18T05:00'],
          sunset: ['2026-07-18T21:00'],
          wind_speed_10m_max: [10],
          wind_gusts_10m_max: [15],
        },
        hourly: {
          time: Array.from({ length: 24 }, (_, h) => `2026-07-18T${String(h).padStart(2, '0')}:00`),
          temperature_2m: Array.from({ length: 24 }, () => 15),
          precipitation_probability: Array.from({ length: 24 }, () => 0),
          precipitation: Array.from({ length: 24 }, () => 0),
        },
      },
    }),
  );
});

interface RouteCase {
  ground: string;
  path: string;
}

// Die acht angemeldeten Routen — Anmelden braucht einen ausgeloggten Kontext
// (eingeloggt leitet die Route sofort auf /uebersicht um) und bekommt in den
// betroffenen Tests einen eigenen `browser.newContext()`.
const ROUTES: RouteCase[] = [
  { ground: 'uebersicht', path: '/uebersicht' },
  { ground: 'aufgaben', path: '/aufgaben' },
  { ground: 'kalender', path: '/kalender' },
  { ground: 'routinen', path: '/routinen' },
  { ground: 'journal', path: '/journal' },
  { ground: 'aktivitaeten', path: '/aktivitaeten' },
  { ground: 'wetter', path: '/wetter/2026-07-18' },
  { ground: 'einstellungen', path: '/einstellungen' },
];

interface CircleRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

async function circleRects(page: Page): Promise<CircleRect[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.bg-layer .bg-circle')).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        top: Math.round(r.top),
        left: Math.round(r.left),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    }),
  );
}

function signature(rects: CircleRect[]): string {
  return JSON.stringify(rects);
}

interface GaitInfo {
  names: string[];
  durations: number[];
}

async function gaitInfo(page: Page): Promise<GaitInfo> {
  return page.evaluate(() => {
    const circles = Array.from(document.querySelectorAll('.bg-layer .bg-circle'));
    return {
      names: circles.map((el) => getComputedStyle(el).animationName),
      durations: circles.flatMap((el) =>
        getComputedStyle(el)
          .animationDuration.split(',')
          .map((d) => parseFloat(d)),
      ),
    };
  });
}

async function animationNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.bg-layer .bg-circle')).map((el) => getComputedStyle(el).animationName),
  );
}

test('AK1: jede der neun Routen zeigt vier Kreise in eigener Anordnung', async ({ page, browser }) => {
  await registerPasskey(page);
  // Ruhelage: ohne reduzierte Bewegung wäre die Momentaufnahme vom
  // Animationsfortschritt (negative animation-delay je Kreis) abhängig.
  await page.emulateMedia({ reducedMotion: 'reduce' });

  const signatures = new Set<string>();
  for (const route of ROUTES) {
    await page.goto(route.path);
    const rects = await circleRects(page);
    expect(rects, `.bg-circle-Anzahl auf ${route.path}`).toHaveLength(4);
    const sig = signature(rects);
    expect(signatures.has(sig), `Anordnung auf ${route.path} wiederholt eine vorherige Route`).toBe(false);
    signatures.add(sig);
  }

  const anmeldenContext = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: page.viewportSize() ?? undefined,
  });
  const anmeldenPage = await anmeldenContext.newPage();
  await anmeldenPage.emulateMedia({ reducedMotion: 'reduce' });
  await anmeldenPage.goto('/anmelden');
  const anmeldenRects = await circleRects(anmeldenPage);
  expect(anmeldenRects, '.bg-circle-Anzahl auf /anmelden').toHaveLength(4);
  expect(signatures.has(signature(anmeldenRects)), 'Anordnung auf /anmelden wiederholt eine andere Route').toBe(
    false,
  );
  await anmeldenContext.close();
});

test('AK2: die Kreise liegen hinter allen Inhalten, tippen geht durch zur UI', async ({ page }) => {
  await registerPasskey(page);
  await page.goto('/aufgaben');

  const layer = page.locator('.bg-layer');
  await expect(layer).toBeAttached();
  const layerStyle = await layer.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { zIndex: Number(cs.zIndex), pointerEvents: cs.pointerEvents };
  });
  expect(layerStyle.zIndex).toBeLessThan(0);
  expect(layerStyle.pointerEvents).toBe('none');

  const heading = page.getByRole('heading', { level: 1, name: 'Aufgaben' });
  await expect(heading).toBeVisible();
  const headingBox = (await heading.boundingBox())!;
  const headingIsTopmost = await page.evaluate(
    ({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      const heading = document.querySelector('h1');
      return Boolean(hit && heading && (hit === heading || heading.contains(hit)) && !hit.closest('.bg-circle'));
    },
    { x: headingBox.x + headingBox.width / 2, y: headingBox.y + headingBox.height / 2 },
  );
  expect(headingIsTopmost).toBe(true);

  const navLink = page
    .getByRole('navigation', { name: 'Hauptnavigation' })
    .getByRole('link', { name: 'Aufgaben' });
  await expect(navLink).toBeVisible();
  const navBox = (await navLink.boundingBox())!;
  const navIsTopmost = await page.evaluate(
    ({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return Boolean(hit && !hit.closest('.bg-circle'));
    },
    { x: navBox.x + navBox.width / 2, y: navBox.y + navBox.height / 2 },
  );
  expect(navIsTopmost).toBe(true);
});

test('AK3: jede Route hat eine eigene Gangart, Dauern liegen zwischen 7 und 40 s', async ({ page, browser }) => {
  await registerPasskey(page);

  const seenNames = new Set<string>();
  for (const route of ROUTES) {
    await page.goto(route.path);
    const { names, durations } = await gaitInfo(page);
    expect(names, `Gangart-Anzahl auf ${route.path}`).toHaveLength(4);
    expect(names.every((n) => n === names[0]), `alle vier Kreise auf ${route.path} teilen dieselbe Gangart`).toBe(
      true,
    );
    expect(seenNames.has(names[0]), `Gangart auf ${route.path} wiederholt eine vorherige Route`).toBe(false);
    seenNames.add(names[0]);
    for (const duration of durations) {
      expect(duration, `Dauer auf ${route.path}`).toBeGreaterThanOrEqual(7);
      expect(duration, `Dauer auf ${route.path}`).toBeLessThanOrEqual(40);
    }
  }

  const anmeldenContext = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: page.viewportSize() ?? undefined,
  });
  const anmeldenPage = await anmeldenContext.newPage();
  await anmeldenPage.goto('/anmelden');
  const { names, durations } = await gaitInfo(anmeldenPage);
  expect(names).toHaveLength(4);
  expect(names.every((n) => n === names[0])).toBe(true);
  expect(seenNames.has(names[0]), 'Gangart auf /anmelden wiederholt eine andere Route').toBe(false);
  for (const duration of durations) {
    expect(duration).toBeGreaterThanOrEqual(7);
    expect(duration).toBeLessThanOrEqual(40);
  }
  await anmeldenContext.close();
});

test('AK4: OS-Präferenz und App-Schalter setzen animation: none auf allen Kreisen', async ({ page }) => {
  await registerPasskey(page);

  // (a) OS-Präferenz.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/uebersicht');
  const namesViaMedia = await animationNames(page);
  expect(namesViaMedia).toHaveLength(4);
  for (const name of namesViaMedia) expect(name).toBe('none');

  // (b) App-Schalter „Bewegung reduzieren" — ohne OS-Präferenz, damit dieser Teil
  // wirklich den Schalter prüft und nicht zufällig durch (a) mitläuft.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/einstellungen');
  const namesBeforeToggle = await animationNames(page);
  expect(namesBeforeToggle.some((name) => name === 'none')).toBe(false);

  const toggle = page.getByRole('switch', { name: 'Bewegung reduzieren' });
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'true');

  const namesAfterToggle = await animationNames(page);
  expect(namesAfterToggle).toHaveLength(4);
  for (const name of namesAfterToggle) expect(name).toBe('none');
});

test('AK5: nach dem Abschalten steht kein Kreis vergrößert oder verschoben still', async ({ page }) => {
  await registerPasskey(page);

  // Basislinie: reduzierte Bewegung von Anfang an, die Ruhe-Rechtecke der vier Kreise.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/einstellungen');
  const baseline = await circleRects(page);
  expect(baseline).toHaveLength(4);

  // Dieselbe Seite mit Bewegung laden und abwarten, bis die Gangart die Kreise
  // sichtbar aus der Ruhelage bewegt hat (Bedingung, kein blindes Timeout).
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload();
  await page.waitForFunction((base) => {
    const circles = Array.from(document.querySelectorAll('.bg-layer .bg-circle'));
    if (circles.length !== base.length) return false;
    return circles.some((el, i) => {
      const r = el.getBoundingClientRect();
      return Math.round(r.top) !== base[i].top || Math.round(r.left) !== base[i].left;
    });
  }, baseline);
  const midFlight = await circleRects(page);
  expect(midFlight).not.toEqual(baseline);

  const toggle = page.getByRole('switch', { name: 'Bewegung reduzieren' });
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'true');

  const afterToggle = await circleRects(page);
  expect(afterToggle).toEqual(baseline);
});
