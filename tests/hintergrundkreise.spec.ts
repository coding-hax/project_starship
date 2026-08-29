import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData } from './helpers';

/**
 * Hintergrundkreise, eine Gangart je Route (S3 von #828, issue #829). Ein Test
 * je AK, gemessen per getComputedStyle/getBoundingClientRect statt per Augenschein.
 *
 * issue #849 (Nacharbeit): die Kreise waren auf keiner Route sichtbar — `body`
 * malte `--ground` deckend über die Ebene, obwohl deren `zIndex`/`pointer-events`
 * (AK2 oben) unverändert korrekt waren. Die neuen AK1/AK2/AK3-Tests unten messen
 * deshalb den tatsächlich gemalten Screenshot-Pixel statt resolveter CSS-Werte —
 * genau die Prüfung, die dem alten AK2 gefehlt hat.
 */

// AK1/AK3 navigieren durch alle neun Routen (plus einen zweiten Browser-Kontext
// für /anmelden); auf dem Dev-Server kompiliert jede Route beim ersten Besuch
// (kein Turbopack, siehe CODEMAP „Bauen"). Dieselbe Ursache/Lösung wie
// scroll-position.spec.ts — hier reichten 60s nicht: als erster Test in der
// Datei zahlt AK1 alle neun kalten Kompilate ohne vorgewärmten Cache. 120s wie
// journal-key-race.spec.ts, kein Flake-Versteck — die Assertions bleiben
// unverändert und werden mit mehr Zeit grün.
test.describe.configure({ timeout: 120_000 });

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

// --- issue #849: die Kreise müssen tatsächlich gemalt werden, nicht nur einen
// korrekten z-index/pointer-events haben (s. Dateikopf). ------------------

function clampRectToViewport(rect: CircleRect, viewport: { width: number; height: number }): CircleRect | null {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(viewport.width, rect.left + rect.width);
  const bottom = Math.min(viewport.height, rect.top + rect.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Hides every direct `<body>` child except `.bg-layer` itself (`visibility:
 * hidden`, not `display: none` — layout doesn't matter once we're only
 * reading pixels). Busy routes like /uebersicht stack real content with no
 * gaps down to the fold, so hunting for an "uncovered" pixel via
 * `elementFromPoint` is a dead end — most of that content is plain
 * transparent wrapper `<div>`s anyway, not `<body>` itself, so that hunt
 * misidentifies them as opaque cover. Hiding the whole foreground instead
 * leaves exactly `html`'s ground and `.bg-layer`'s circles on screen — the
 * two things this fix is actually about — and still reproduces the bug this
 * ticket fixes: `body`'s own background (if it regressed) still paints over
 * the fixed `.bg-layer` regardless of whether its siblings are visible.
 */
async function hideForegroundContent(page: Page): Promise<void> {
  await page.evaluate(() => {
    Array.from(document.body.children).forEach((el) => {
      if (el instanceof HTMLElement && !el.classList.contains('bg-layer')) {
        el.style.setProperty('visibility', 'hidden', 'important');
      }
    });
  });
}

/** First point (viewport coords) outside every rect in `rects` — pure geometry, no DOM lookup. */
function findFreeSpotOutsideRects(
  rects: CircleRect[],
  viewport: { width: number; height: number },
): { x: number; y: number } | null {
  const inside = (x: number, y: number, r: CircleRect) =>
    x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
  const step = 8;
  for (let y = 0; y < viewport.height; y += step) {
    for (let x = 0; x < viewport.width; x += step) {
      if (rects.every((r) => !inside(x, y, r))) return { x, y };
    }
  }
  return null;
}

/**
 * Reads real composited pixels, not resolved CSS (issue #849's whole point):
 * `getComputedStyle` reports an element's own declared colour regardless of
 * whether the stacking context ever lets it reach the screen — exactly how the
 * old AK2 above stayed green while the circles were fully painted over. A
 * screenshot fed back in as a data URL and drawn onto a canvas sidesteps that:
 * the pixel it returns is what the browser actually painted.
 */
async function samplePixels(page: Page, points: { x: number; y: number }[]): Promise<[number, number, number][]> {
  const buffer = await page.screenshot();
  const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
  return page.evaluate(
    ({ dataUrl, points }) =>
      new Promise<[number, number, number][]>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(img, 0, 0);
          const scaleX = img.naturalWidth / window.innerWidth;
          const scaleY = img.naturalHeight / window.innerHeight;
          resolve(
            points.map(({ x, y }) => {
              const data = ctx.getImageData(Math.round(x * scaleX), Math.round(y * scaleY), 1, 1).data;
              return [data[0], data[1], data[2]] as [number, number, number];
            }),
          );
        };
        img.onerror = () => reject(new Error('Screenshot ließ sich nicht als Bild laden'));
        img.src = dataUrl;
      }),
    { dataUrl, points },
  );
}

function maxChannelDiff(a: [number, number, number], b: [number, number, number]): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

async function assertCircleVisible(page: Page, label: string): Promise<void> {
  const viewport = page.viewportSize()!;
  const rects = await circleRects(page);
  const largest = rects.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
  const clamped = clampRectToViewport(largest, viewport);
  expect(clamped, `größter Kreis liegt komplett außerhalb des Viewports auf ${label}`).not.toBeNull();
  const outsidePoint = findFreeSpotOutsideRects(rects, viewport);
  expect(outsidePoint, `keine kreisfreie Stelle auf ${label}`).not.toBeNull();

  await hideForegroundContent(page);
  const insidePoint = { x: Math.round(clamped!.left + clamped!.width / 2), y: Math.round(clamped!.top + clamped!.height / 2) };

  const [insideColor, outsideColor] = await samplePixels(page, [insidePoint, outsidePoint!]);
  expect(
    maxChannelDiff(insideColor, outsideColor),
    `Kreismitte ${JSON.stringify(insideColor)} vs. Grund ${JSON.stringify(outsideColor)} auf ${label}`,
  ).toBeGreaterThanOrEqual(3);
}

test('AK1 (#849): auf jeder der neun Routen unterscheidet sich die Kreisfläche messbar vom Grund (Screenshot-Pixel)', async ({
  page,
  browser,
}) => {
  await registerPasskey(page);
  // Ruhelage wie im alten AK1: eine feste Momentaufnahme statt eines
  // Animationsfortschritts, der die Kreisrechtecke pro Lauf verschieben würde.
  await page.emulateMedia({ reducedMotion: 'reduce' });

  for (const route of ROUTES) {
    await page.goto(route.path);
    await assertCircleVisible(page, route.path);
  }

  const anmeldenContext = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: page.viewportSize() ?? undefined,
  });
  const anmeldenPage = await anmeldenContext.newPage();
  await anmeldenPage.emulateMedia({ reducedMotion: 'reduce' });
  await anmeldenPage.goto('/anmelden');
  await assertCircleVisible(anmeldenPage, '/anmelden');
  await anmeldenContext.close();
});

test('AK2 (#849): dieselbe Messung ist in Hell und Dunkel grün', async ({ page, browser }) => {
  await registerPasskey(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const route of ROUTES) {
      await page.goto(route.path);
      await assertCircleVisible(page, `${route.path} (${scheme})`);
    }
  }

  for (const scheme of ['light', 'dark'] as const) {
    const anmeldenContext = await browser.newContext({
      storageState: { cookies: [], origins: [] },
      viewport: page.viewportSize() ?? undefined,
      colorScheme: scheme,
    });
    const anmeldenPage = await anmeldenContext.newPage();
    await anmeldenPage.emulateMedia({ reducedMotion: 'reduce' });
    await anmeldenPage.goto('/anmelden');
    await assertCircleVisible(anmeldenPage, `/anmelden (${scheme})`);
    await anmeldenContext.close();
  }
});

const BLOB_PARTNERS: Record<string, string> = {
  uebersicht: '#ffce00',
  aufgaben: '#12a67a',
  kalender: '#3aa7e0',
  routinen: '#ffce00',
  journal: '#cf49c0',
  aktivitaeten: '#ff7300',
  wetter: '#7cc9f0',
  einstellungen: '#0e7c84',
  anmelden: '#ffce00',
};

async function blobPartner(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--blob-partner').trim());
}

async function circleBackgroundColors(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.bg-layer .bg-circle')).map((el) => getComputedStyle(el).backgroundColor),
  );
}

async function groundColor(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
}

async function assertFourOwnTones(page: Page, ground: string, expectedPartner: string, label: string): Promise<void> {
  const partner = await blobPartner(page);
  expect(partner.toLowerCase(), `--blob-partner auf ${label}`).toBe(expectedPartner);

  const colors = await circleBackgroundColors(page);
  expect(colors, `vier Kreisfarben auf ${label}`).toHaveLength(4);
  expect(new Set(colors).size, `vier verschiedene Töne auf ${label}: ${colors.join(', ')}`).toBe(4);
  for (const [i, color] of colors.entries()) {
    expect(color, `Ton ${i + 1} auf ${label} entspricht unverändert dem Grund`).not.toBe(ground);
  }
}

test('AK3 (#849): vier eigene Töne je Route, --blob-partner passt zum Entwurfsblatt', async ({ page, browser }) => {
  await registerPasskey(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });

  for (const route of ROUTES) {
    await page.goto(route.path);
    const ground = await groundColor(page);
    await assertFourOwnTones(page, ground, BLOB_PARTNERS[route.ground], route.path);
  }

  const anmeldenContext = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: page.viewportSize() ?? undefined,
  });
  const anmeldenPage = await anmeldenContext.newPage();
  await anmeldenPage.emulateMedia({ reducedMotion: 'reduce' });
  await anmeldenPage.goto('/anmelden');
  const ground = await groundColor(anmeldenPage);
  await assertFourOwnTones(anmeldenPage, ground, BLOB_PARTNERS.anmelden, '/anmelden');
  await anmeldenContext.close();
});

// --- issue #889: die Kreise dürfen nicht mehr an der Oberkante der Nav-Zeile
// abbrechen — nur die Pille (`.nav__bar`) darf sie verdecken, der Rest der Zeile
// zeigt sie wie jede andere Stelle der Seite. ---------------------------------

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** First point (viewport coords) that lies inside `navBox` but outside `navBarBox`
 * (the band around the pill) AND inside at least one circle rect. */
function findSpotInNavBandUnderCircle(navBox: Box, navBarBox: Box, rects: CircleRect[]): { x: number; y: number } | null {
  const insideNavBar = (x: number, y: number) =>
    x >= navBarBox.x && x <= navBarBox.x + navBarBox.width && y >= navBarBox.y && y <= navBarBox.y + navBarBox.height;
  // `.bg-circle` is a true circle (`border-radius: 50%`), not its square bounding
  // rect — a point near a corner of `r` sits outside the painted disc and reads as
  // flat ground, exactly the false match this test chased in CI (band vs. ground
  // diff of 2, then 0, both below the required 3). Checking actual distance from
  // the circle's centre, kept at 90% of the radius to clear the anti-aliased edge
  // too, guarantees the chosen point is really painted by the circle.
  const insideAnyCircle = (x: number, y: number) =>
    rects.some((r) => {
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const radius = (Math.min(r.width, r.height) / 2) * 0.9;
      return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
    });
  const step = 4;
  for (let y = Math.ceil(navBox.y); y < navBox.y + navBox.height; y += step) {
    for (let x = Math.ceil(navBox.x); x < navBox.x + navBox.width; x += step) {
      if (insideNavBar(x, y)) continue;
      if (insideAnyCircle(x, y)) return { x, y };
    }
  }
  return null;
}

/** Resolves any colour custom property the same way `resolveColorToken`/`toRgb` do in
 * grundfarbe-vollfarbe.spec.ts, as sRGB bytes comparable to a sampled screenshot pixel —
 * `getComputedStyle().getPropertyValue()` alone would return the raw token string
 * (e.g. `var(--on-ground-light)` or an `oklch(...)`), not a resolved colour. */
async function resolveVarRgb(page: Page, name: string): Promise<[number, number, number]> {
  return page.evaluate((name) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    return [data[0], data[1], data[2]] as [number, number, number];
  }, name);
}

async function resolveSurfaceRgb(page: Page): Promise<[number, number, number]> {
  return resolveVarRgb(page, '--surface');
}

test('AK2/AK3 (#889): Kreisbogen läuft in der Nav-Zeile außerhalb der Pille durch, die Pille bleibt --surface', async ({
  page,
}) => {
  await registerPasskey(page);
  // Ruhelage wie bei den anderen Pixel-Tests oben: eine feste Momentaufnahme,
  // damit die Kreisrechtecke pro Lauf nicht verschieben.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/uebersicht');

  const navBar = page.locator('.nav__bar');
  const navBarBox = await navBar.boundingBox();
  expect(navBarBox, '.nav__bar hat eine Bounding-Box').not.toBeNull();

  // AK3: die Pille selbst bleibt --surface, unabhängig von einem darunterliegenden
  // Kreis — gemessen am tatsächlich gemalten Pixel, solange sie noch sichtbar ist.
  const surfaceRgb = await resolveSurfaceRgb(page);
  const navBarCenter = {
    x: Math.round(navBarBox!.x + navBarBox!.width / 2),
    y: Math.round(navBarBox!.y + navBarBox!.height / 2),
  };
  const [navBarColor] = await samplePixels(page, [navBarCenter]);
  expect(
    maxChannelDiff(navBarColor, surfaceRgb),
    `Pillen-Mitte ${JSON.stringify(navBarColor)} vs. --surface ${JSON.stringify(surfaceRgb)}`,
  ).toBeLessThan(3);

  // AK2: außerhalb der Pille, innerhalb der Nav-Zeile, läuft der Kreisbogen durch —
  // an einer Stelle, an der tatsächlich ein Kreis liegt, unterscheidet sich der
  // gemalte Pixel messbar vom flachen Grund.
  const nav = page.locator('.nav');
  const navBox = await nav.boundingBox();
  expect(navBox, '.nav hat eine Bounding-Box').not.toBeNull();
  const viewport = page.viewportSize()!;
  const rects = await circleRects(page);
  const bandPoint = findSpotInNavBandUnderCircle(navBox!, navBarBox!, rects);
  expect(
    bandPoint,
    'Testvoraussetzung: auf /uebersicht liegt ein Kreis in der Nav-Zeile außerhalb der Pille',
  ).not.toBeNull();

  await hideForegroundContent(page);
  const groundPoint = findFreeSpotOutsideRects(rects, viewport);
  expect(groundPoint, 'keine kreisfreie Stelle für den Grund-Vergleich').not.toBeNull();

  const [bandColor, groundColor] = await samplePixels(page, [bandPoint!, groundPoint!]);
  expect(
    maxChannelDiff(bandColor, groundColor),
    `Nav-Band-Pixel ${JSON.stringify(bandColor)} vs. Grund ${JSON.stringify(groundColor)}`,
  ).toBeGreaterThanOrEqual(3);
});

// --- issue #904: drei wandernde Lichter, dieselbe Anordnung/Gangart auf jeder
// Route (anders als die Kreise oben), Ruhelage sichtbar statt verschwunden,
// Kontrastdeckel am gemalten Pixel gemessen. -------------------------------

async function lightRects(page: Page): Promise<CircleRect[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.bg-layer .bg-light')).map((el) => {
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

async function layerChildClasses(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.bg-layer > *')).map((el) => el.className),
  );
}

const LAYER_CHILD_ORDER = ['bg-light', 'bg-light', 'bg-light', 'bg-circle', 'bg-circle', 'bg-circle', 'bg-circle'];

test('AK1 (#904): drei .bg-light vor den vier .bg-circle auf jeder Route, /offline bleibt display:none', async ({
  page,
  browser,
}) => {
  await registerPasskey(page);

  for (const route of ROUTES) {
    await page.goto(route.path);
    const classes = await layerChildClasses(page);
    expect(classes, `Kinder von .bg-layer auf ${route.path}`).toEqual(LAYER_CHILD_ORDER);
  }

  const anmeldenContext = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: page.viewportSize() ?? undefined,
  });
  const anmeldenPage = await anmeldenContext.newPage();
  await anmeldenPage.goto('/anmelden');
  const anmeldenClasses = await layerChildClasses(anmeldenPage);
  expect(anmeldenClasses, 'Kinder von .bg-layer auf /anmelden').toEqual(LAYER_CHILD_ORDER);
  await anmeldenContext.close();

  await page.goto('/offline');
  const display = await page.locator('.bg-layer').evaluate((el) => getComputedStyle(el).display);
  expect(display, '.bg-layer auf /offline').toBe('none');
});

test('AK2 (#904): Anordnung und Gangart der Lichter sind auf jeder Route identisch', async ({ page }) => {
  await registerPasskey(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });

  let reference: string | null = null;
  for (const route of ROUTES) {
    await page.goto(route.path);
    const rects = await lightRects(page);
    expect(rects, `.bg-light-Anzahl auf ${route.path}`).toHaveLength(3);
    const sig = signature(rects);
    if (reference === null) {
      reference = sig;
    } else {
      expect(sig, `Licht-Anordnung auf ${route.path} weicht von der Referenzroute ab`).toBe(reference);
    }
  }

  await page.goto('/uebersicht');
  const namesA = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.bg-layer .bg-light')).map((el) => getComputedStyle(el).animationName),
  );
  await page.goto('/journal');
  const namesB = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.bg-layer .bg-light')).map((el) => getComputedStyle(el).animationName),
  );
  expect(namesB, 'Gangart-Namen der Lichter unterscheiden sich zwischen Routen').toEqual(namesA);
});

async function lightAnimationState(page: Page): Promise<{ names: string[]; opacities: string[] }> {
  return page.evaluate(() => {
    const lights = Array.from(document.querySelectorAll('.bg-layer .bg-light'));
    return {
      names: lights.map((el) => getComputedStyle(el).animationName),
      opacities: lights.map((el) => getComputedStyle(el).opacity),
    };
  });
}

test('AK3 (#904): Ruhelage der Lichter ist animation:none bei opacity 1, nicht verschwunden', async ({ page }) => {
  await registerPasskey(page);

  // (a) OS-Präferenz.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/uebersicht');
  const viaMedia = await lightAnimationState(page);
  expect(viaMedia.names).toHaveLength(3);
  for (const [i, name] of viaMedia.names.entries()) {
    expect(name, `Licht ${i} animationName`).toBe('none');
    expect(viaMedia.opacities[i], `Licht ${i} opacity`).toBe('1');
  }

  // (b) App-Schalter, ohne OS-Präferenz.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/einstellungen');
  const beforeToggle = await lightAnimationState(page);
  expect(beforeToggle.names.some((name) => name === 'none')).toBe(false);

  const toggle = page.getByRole('switch', { name: 'Bewegung reduzieren' });
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'true');

  const afterToggle = await lightAnimationState(page);
  expect(afterToggle.names).toHaveLength(3);
  for (const [i, name] of afterToggle.names.entries()) {
    expect(name, `Licht ${i} animationName nach Schalter`).toBe('none');
    expect(afterToggle.opacities[i], `Licht ${i} opacity nach Schalter`).toBe('1');
  }
});

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function wcagContrast(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseRgbString(value: string): [number, number, number] {
  const parts = value.match(/[\d.]+/g);
  if (!parts || parts.length < 3) throw new Error(`Farbe nicht lesbar: ${value}`);
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

/** Grid-scans a light's disc (90% of its radius, clear of the anti-aliased edge)
 * for the point closest to its centre that no `.bg-circle` covers — the brightest
 * light pixel this route can actually show, same spirit as
 * `findSpotInNavBandUnderCircle` above. */
function findBrightestLightPoint(
  light: CircleRect,
  excludeCircles: CircleRect[],
  viewport: { width: number; height: number },
): { x: number; y: number } | null {
  const cx = light.left + light.width / 2;
  const cy = light.top + light.height / 2;
  const radius = (Math.min(light.width, light.height) / 2) * 0.9;
  const insideAnyCircle = (x: number, y: number) =>
    excludeCircles.some((r) => x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height);
  const step = 8;
  let best: { x: number; y: number; d: number } | null = null;
  for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(viewport.height - 1, Math.ceil(cy + radius)); y += step) {
    for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(viewport.width - 1, Math.ceil(cx + radius)); x += step) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > radius) continue;
      if (insideAnyCircle(x, y)) continue;
      if (!best || d < best.d) best = { x, y, d };
    }
  }
  return best && { x: best.x, y: best.y };
}

// Die fünf Routen mit heller Tinte (`--on-ground: var(--on-ground-light)`) — auf
// den übrigen vier hellt das Licht die Tinte gegenüber dem Grund noch weiter auf,
// es kann dort per Definition keinen Kontrast kosten.
const LIGHT_INK_ROUTES = ['aufgaben', 'kalender', 'journal', 'wetter', 'einstellungen'];

test('AK4 (#904): Kontrastdeckel — mit Licht bleibt jede Route bei ≥ 3:1 und verliert höchstens 1,5 Punkte', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });

  for (const route of ROUTES.filter((r) => LIGHT_INK_ROUTES.includes(r.ground))) {
    await page.goto(route.path);
    const viewport = page.viewportSize()!;
    const ink = await resolveVarRgb(page, '--on-ground');
    // `--ground` selbst ist von diesem Ticket unberührt (nur `.bg-layer`/`.bg-light`
    // malen etwas darüber) — die Auflösung des Custom Property ist deshalb exakt
    // der "heute"-Grund aus AK4, unbeeinflusst vom neuen Vignette-Verlauf weiter unten.
    const baselineGround = parseRgbString(await groundColor(page));
    const baseline = wcagContrast(baselineGround, ink);

    const circles = await circleRects(page);
    const lights = await lightRects(page);
    expect(lights, `.bg-light-Anzahl auf ${route.path}`).toHaveLength(3);

    await hideForegroundContent(page);
    const candidates = lights
      .map((light) => findBrightestLightPoint(light, circles, viewport))
      .filter((p): p is { x: number; y: number } => p !== null);
    expect(candidates.length, `keine sichtbare Lichtstelle auf ${route.path}`).toBeGreaterThan(0);

    const sampled = await samplePixels(page, candidates);
    const brightest = sampled.reduce((a, b) => (relativeLuminance(a) >= relativeLuminance(b) ? a : b));
    const withLight = wcagContrast(brightest, ink);

    const detail = `${route.path}: Grund ${JSON.stringify(baselineGround)} → ${baseline.toFixed(2)}:1, mit Licht ${JSON.stringify(brightest)} → ${withLight.toFixed(2)}:1, Tinte ${JSON.stringify(ink)}`;
    // .soft, nicht hart: ein Bericht über alle fünf Routen in einem Lauf statt
    // Abbruch bei der ersten — das macht das Nachschärfen des Kontrastdeckels
    // (AK4) in einer Runde möglich statt route-weise.
    expect.soft(withLight, `Kontrast mit Licht ≥ 3.0 — ${detail}`).toBeGreaterThanOrEqual(3.0);
    expect.soft(baseline - withLight, `Kontrastverlust ≤ 1.5 — ${detail}`).toBeLessThanOrEqual(1.5);
  }
});

test('AK5 (#904): Dunkelmodus setzt --sky-strength auf 22% statt 34%', async ({ page }) => {
  await registerPasskey(page);
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
  await page.goto('/uebersicht');
  const light = page.locator('.bg-layer .bg-light').first();
  const lightStrength = await light.evaluate((el) => getComputedStyle(el).getPropertyValue('--sky-strength').trim());
  expect(lightStrength).toBe('34%');

  await page.emulateMedia({ colorScheme: 'dark' });
  const darkStrength = await light.evaluate((el) => getComputedStyle(el).getPropertyValue('--sky-strength').trim());
  expect(darkStrength).toBe('22%');
});

test('AK8 (#904): 375 × 812 — die Lichter ragen über den Rand, ohne waagerechten Überlauf zu erzeugen', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/uebersicht');

  const lights = await lightRects(page);
  expect(lights, '.bg-light-Anzahl').toHaveLength(3);
  const viewportWidth = page.viewportSize()!.width;
  expect(lights.some((r) => r.left < 0 || r.left + r.width > viewportWidth), 'mindestens ein Licht ragt über den Rand').toBe(
    true,
  );

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth, 'kein waagerechter Überlauf durch die Lichter').toBeLessThanOrEqual(viewportWidth);
});
