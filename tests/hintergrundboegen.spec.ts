import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData } from './helpers';

/**
 * Hintergrundbögen, drei gestaffelte, unabhängig pulsierende Bögen mit der
 * "Foto-Rezept"-Farbgebung (issue #991) — ersetzt die vier Kreise + drei
 * Lichter aus den Issues #829/#849/#904/#919/#982. Ein Test je AK, gemessen
 * per getComputedStyle/getBoundingClientRect/gemaltem Pixel statt per
 * Augenschein, wie schon in der Vorgänger-Datei.
 *
 * AK8-Zuordnung (issue #991): welcher alte Test bleibt (nur auf `.bg-arc`
 * umgeschrieben), welcher ersetzt wird und welcher entfällt, steht im
 * Fortschrittskommentar/Plan des Tickets — hier nur die Kurzfassung je Test.
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

interface ArcRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

async function arcRects(page: Page): Promise<ArcRect[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.bg-layer .bg-arc')).map((el) => {
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

function signature(rects: ArcRect[]): string {
  return JSON.stringify(rects);
}

async function animationNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.bg-layer .bg-arc')).map((el) => getComputedStyle(el).animationName),
  );
}

test('AK1 (#991): genau drei .bg-arc je Route, kein .bg-light/.bg-circle mehr', async ({ page, browser }) => {
  await registerPasskey(page);

  for (const route of ROUTES) {
    await page.goto(route.path);
    const classes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.bg-layer > *')).map((el) => el.className),
    );
    expect(classes, `Kinder von .bg-layer auf ${route.path}`).toEqual(['bg-arc', 'bg-arc', 'bg-arc']);
  }

  const anmeldenContext = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: page.viewportSize() ?? undefined,
  });
  const anmeldenPage = await anmeldenContext.newPage();
  await anmeldenPage.goto('/anmelden');
  const anmeldenClasses = await anmeldenPage.evaluate(() =>
    Array.from(document.querySelectorAll('.bg-layer > *')).map((el) => el.className),
  );
  expect(anmeldenClasses, 'Kinder von .bg-layer auf /anmelden').toEqual(['bg-arc', 'bg-arc', 'bg-arc']);
  await anmeldenContext.close();

  await page.goto('/offline');
  const display = await page.locator('.bg-layer').evaluate((el) => getComputedStyle(el).display);
  expect(display, '.bg-layer auf /offline').toBe('none');
});

// AK1-Geometrie (issue #991): dieselbe Anordnung auf allen neun Routen, anders
// als die alten, je Route unterschiedlichen Kreis-Anordnungen.
const EXPECTED_ARCS: ArcRect[] = [
  { top: 205, left: -312, width: 1000, height: 1000 },
  { top: 395, left: -207, width: 790, height: 790 },
  { top: 575, left: -97, width: 570, height: 570 },
];

test('AK1 (#991): Geometrie (Größen/bottom/Kronenhöhe) bei 375×812 ist auf allen neun Routen identisch', async ({
  page,
  browser,
}) => {
  await registerPasskey(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });

  let reference: ArcRect[] | null = null;
  for (const route of ROUTES) {
    await page.goto(route.path);
    const rects = await arcRects(page);
    expect(rects, `.bg-arc-Anzahl auf ${route.path}`).toHaveLength(3);
    if (reference === null) {
      reference = rects;
    } else {
      expect(signature(rects), `Anordnung auf ${route.path} weicht von der Referenzroute ab`).toBe(
        signature(reference),
      );
    }
  }

  const anmeldenContext = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: page.viewportSize() ?? undefined,
  });
  const anmeldenPage = await anmeldenContext.newPage();
  await anmeldenPage.emulateMedia({ reducedMotion: 'reduce' });
  await anmeldenPage.goto('/anmelden');
  const anmeldenRects = await arcRects(anmeldenPage);
  expect(signature(anmeldenRects), 'Anordnung auf /anmelden weicht ab').toBe(signature(reference!));
  await anmeldenContext.close();

  // Krone/Größe/bottom gegen die AK1-Tabelle, ±2px Toleranz für Sub-Pixel-Rundung.
  for (const [i, expectedRect] of EXPECTED_ARCS.entries()) {
    const actual = reference![i];
    expect(Math.abs(actual.top - expectedRect.top), `Bogen ${i + 1} Krone (top)`).toBeLessThanOrEqual(2);
    expect(Math.abs(actual.width - expectedRect.width), `Bogen ${i + 1} Größe`).toBeLessThanOrEqual(2);
    expect(Math.abs(actual.height - expectedRect.height), `Bogen ${i + 1} Größe`).toBeLessThanOrEqual(2);
  }
});

test('AK2 (#829): die Bögen liegen hinter allen Inhalten, tippen geht durch zur UI', async ({ page }) => {
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
      return Boolean(hit && heading && (hit === heading || heading.contains(hit)) && !hit.closest('.bg-arc'));
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
      return Boolean(hit && !hit.closest('.bg-arc'));
    },
    { x: navBox.x + navBox.width / 2, y: navBox.y + navBox.height / 2 },
  );
  expect(navIsTopmost).toBe(true);
});

const EXPECTED_DURATIONS = [9, 11, 14];
const EXPECTED_DELAYS = ['0s', '-4s', '-9s'];

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

test('AK2 (#991): drei paarweise teilerfremde Dauern (9/11/14s), je Bogen sein eigenes Keyframe', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/uebersicht');

  const { durations, names } = await page.evaluate(() => {
    const arcs = Array.from(document.querySelectorAll('.bg-layer .bg-arc'));
    return {
      durations: arcs.map((el) => parseFloat(getComputedStyle(el).animationDuration)),
      names: arcs.map((el) => getComputedStyle(el).animationName),
    };
  });

  expect(durations).toHaveLength(3);
  for (const [i, expected] of EXPECTED_DURATIONS.entries()) {
    expect(durations[i], `Dauer Bogen ${i + 1}`).toBe(expected);
  }
  expect(gcd(EXPECTED_DURATIONS[0], EXPECTED_DURATIONS[1])).toBe(1);
  expect(gcd(EXPECTED_DURATIONS[0], EXPECTED_DURATIONS[2])).toBe(1);
  expect(gcd(EXPECTED_DURATIONS[1], EXPECTED_DURATIONS[2])).toBe(1);

  // Je ein eigenes Keyframe (nicht dieselbe Animation dreifach wiederverwendet).
  expect(new Set(names).size, `drei verschiedene Keyframe-Namen: ${names.join(', ')}`).toBe(3);
});

test('AK2 (#991): versetzte Startphasen — die drei Bögen stehen nie gleichzeitig am selben Punkt', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/uebersicht');

  const delays = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.bg-layer .bg-arc')).map((el) => getComputedStyle(el).animationDelay),
  );
  expect(delays).toEqual(EXPECTED_DELAYS);

  // Laufzeit-Nachweis: alle drei Bögen bewegen sich unabhängig — nach kurzer
  // Zeit unterscheiden sich ihre drei Größen (Puls-Fortschritt) paarweise.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload();
  const baseline = await arcRects(page);
  await page.waitForFunction((base) => {
    const arcs = Array.from(document.querySelectorAll('.bg-layer .bg-arc'));
    if (arcs.length !== base.length) return false;
    return arcs.every((el, i) => {
      const r = el.getBoundingClientRect();
      return Math.round(r.width) !== base[i].width;
    });
  }, baseline);
  const midFlight = await arcRects(page);
  const widths = midFlight.map((r) => r.width);
  expect(new Set(widths).size, `drei unterschiedliche Puls-Fortschritte: ${widths.join(', ')}`).toBe(3);
});

/** Reads a `@keyframes` rule's `to`/`100%` `scale` value straight from the
 * authored stylesheet — the animated value itself fluctuates continuously at
 * runtime, so this is the only reliable way to pin each arc's own pulse hub
 * (AK2's 1.05/1.085/1.12) instead of the shared "does it move at all" checks
 * elsewhere in this file. */
async function keyframeScaleTarget(page: Page, keyframeName: string): Promise<string | null> {
  return page.evaluate((name) => {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSKeyframesRule) || rule.name !== name) continue;
        for (const kf of Array.from(rule.cssRules)) {
          if (kf instanceof CSSKeyframeRule && (kf.keyText === 'to' || kf.keyText === '100%')) {
            return kf.style.scale || null;
          }
        }
      }
    }
    return null;
  }, keyframeName);
}

test('AK2 (#991): jeder Bogen hat sein eigenes Keyframe mit eigenem Puls-Hub (1.05/1.085/1.12)', async ({ page }) => {
  await registerPasskey(page);
  await page.goto('/uebersicht');

  const names = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.bg-layer .bg-arc')).map((el) => getComputedStyle(el).animationName),
  );
  expect(names).toHaveLength(3);
  expect(new Set(names).size, `drei verschiedene Keyframe-Namen: ${names.join(', ')}`).toBe(3);

  const expectedHubs = ['1.05', '1.085', '1.12'];
  for (const [i, name] of names.entries()) {
    const target = await keyframeScaleTarget(page, name);
    expect(target, `Puls-Hub des Keyframes ${name} (Bogen ${i + 1})`).toBe(expectedHubs[i]);
  }
});

test('AK2 (#829): nach dem Abschalten steht kein Bogen vergrößert oder verschoben still', async ({ page }) => {
  await registerPasskey(page);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/einstellungen');
  const baseline = await arcRects(page);
  expect(baseline).toHaveLength(3);

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload();
  await page.waitForFunction((base) => {
    const arcs = Array.from(document.querySelectorAll('.bg-layer .bg-arc'));
    if (arcs.length !== base.length) return false;
    return arcs.some((el, i) => {
      const r = el.getBoundingClientRect();
      return Math.round(r.width) !== base[i].width;
    });
  }, baseline);
  const midFlight = await arcRects(page);
  expect(midFlight).not.toEqual(baseline);

  const toggle = page.getByRole('switch', { name: 'Bewegung reduzieren' });
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'true');

  const afterToggle = await arcRects(page);
  expect(afterToggle).toEqual(baseline);
});

test('AK2 (#829): OS-Präferenz und App-Schalter setzen animation: none auf allen Bögen', async ({ page }) => {
  await registerPasskey(page);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/uebersicht');
  const namesViaMedia = await animationNames(page);
  expect(namesViaMedia).toHaveLength(3);
  for (const name of namesViaMedia) expect(name).toBe('none');

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/einstellungen');
  const namesBeforeToggle = await animationNames(page);
  expect(namesBeforeToggle.some((name) => name === 'none')).toBe(false);

  const toggle = page.getByRole('switch', { name: 'Bewegung reduzieren' });
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'true');

  const namesAfterToggle = await animationNames(page);
  expect(namesAfterToggle).toHaveLength(3);
  for (const name of namesAfterToggle) expect(name).toBe('none');
});

function clampRectToViewport(rect: ArcRect, viewport: { width: number; height: number }): ArcRect | null {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(viewport.width, rect.left + rect.width);
  const bottom = Math.min(viewport.height, rect.top + rect.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

async function hideForegroundContent(page: Page): Promise<void> {
  await page.evaluate(() => {
    Array.from(document.body.children).forEach((el) => {
      if (el instanceof HTMLElement && !el.classList.contains('bg-layer')) {
        el.style.setProperty('display', 'none', 'important');
      }
    });
  });
}

function findFreeSpotOutsideRects(
  rects: ArcRect[],
  viewport: { width: number; height: number },
): { x: number; y: number } | null {
  const inside = (x: number, y: number, r: ArcRect) =>
    x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
  const step = 8;
  for (let y = 0; y < viewport.height; y += step) {
    for (let x = 0; x < viewport.width; x += step) {
      if (rects.every((r) => !inside(x, y, r))) return { x, y };
    }
  }
  return null;
}

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

async function assertArcVisible(page: Page, label: string): Promise<void> {
  const viewport = page.viewportSize()!;
  const rects = await arcRects(page);
  const largest = rects.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
  const clamped = clampRectToViewport(largest, viewport);
  expect(clamped, `größter Bogen liegt komplett außerhalb des Viewports auf ${label}`).not.toBeNull();
  const outsidePoint = findFreeSpotOutsideRects(rects, viewport);
  expect(outsidePoint, `keine bogenfreie Stelle auf ${label}`).not.toBeNull();

  await hideForegroundContent(page);
  const insidePoint = { x: Math.round(clamped!.left + clamped!.width / 2), y: Math.round(clamped!.top + clamped!.height / 2) };

  const [insideColor, outsideColor] = await samplePixels(page, [insidePoint, outsidePoint!]);
  expect(
    maxChannelDiff(insideColor, outsideColor),
    `Bogenmitte ${JSON.stringify(insideColor)} vs. Grund ${JSON.stringify(outsideColor)} auf ${label}`,
  ).toBeGreaterThanOrEqual(3);
}

test('AK1 (#849): auf jeder der neun Routen unterscheidet sich die Bogenfläche messbar vom Grund (Screenshot-Pixel)', async ({
  page,
  browser,
}) => {
  await registerPasskey(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });

  for (const route of ROUTES) {
    await page.goto(route.path);
    await assertArcVisible(page, route.path);
  }

  const anmeldenContext = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: page.viewportSize() ?? undefined,
  });
  const anmeldenPage = await anmeldenContext.newPage();
  await anmeldenPage.emulateMedia({ reducedMotion: 'reduce' });
  await anmeldenPage.goto('/anmelden');
  await assertArcVisible(anmeldenPage, '/anmelden');
  await anmeldenContext.close();
});

test('AK2 (#849): dieselbe Messung ist in Hell und Dunkel grün', async ({ page, browser }) => {
  await registerPasskey(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const route of ROUTES) {
      await page.goto(route.path);
      await assertArcVisible(page, `${route.path} (${scheme})`);
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
    await assertArcVisible(anmeldenPage, `/anmelden (${scheme})`);
    await anmeldenContext.close();
  }
});

async function arcBackgroundColors(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.bg-layer .bg-arc')).map((el) => getComputedStyle(el).backgroundColor),
  );
}

async function groundColor(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
}

test('AK3 (#991): drei Töne nach dem Foto-Rezept, alle drei unterscheiden sich vom Grund', async ({
  page,
  browser,
}) => {
  await registerPasskey(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });

  for (const route of ROUTES) {
    await page.goto(route.path);
    const ground = await groundColor(page);
    const colors = await arcBackgroundColors(page);
    expect(colors, `drei Bogenfarben auf ${route.path}`).toHaveLength(3);
    expect(new Set(colors).size, `drei verschiedene Töne auf ${route.path}: ${colors.join(', ')}`).toBe(3);
    for (const [i, color] of colors.entries()) {
      expect(color, `Ton ${i + 1} auf ${route.path} entspricht unverändert dem Grund`).not.toBe(ground);
    }
  }

  const anmeldenContext = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: page.viewportSize() ?? undefined,
  });
  const anmeldenPage = await anmeldenContext.newPage();
  await anmeldenPage.emulateMedia({ reducedMotion: 'reduce' });
  await anmeldenPage.goto('/anmelden');
  const ground = await groundColor(anmeldenPage);
  const colors = await arcBackgroundColors(anmeldenPage);
  expect(colors, 'drei Bogenfarben auf /anmelden').toHaveLength(3);
  expect(new Set(colors).size).toBe(3);
  for (const color of colors) {
    expect(color).not.toBe(ground);
  }
  await anmeldenContext.close();
});

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function pointInsideArc(r: ArcRect, x: number, y: number): boolean {
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const radius = (Math.min(r.width, r.height) / 2) * 0.9;
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function pointInsideAnyArc(rects: ArcRect[], x: number, y: number): boolean {
  return rects.some((r) => pointInsideArc(r, x, y));
}

function findSpotInNavBandUnderArc(navBox: Box, navBarBox: Box, rects: ArcRect[]): { x: number; y: number } | null {
  const insideNavBar = (x: number, y: number) =>
    x >= navBarBox.x && x <= navBarBox.x + navBarBox.width && y >= navBarBox.y && y <= navBarBox.y + navBarBox.height;
  const step = 4;
  for (let y = Math.ceil(navBox.y); y < navBox.y + navBox.height; y += step) {
    for (let x = Math.ceil(navBox.x); x < navBox.x + navBox.width; x += step) {
      if (insideNavBar(x, y)) continue;
      if (pointInsideAnyArc(rects, x, y)) return { x, y };
    }
  }
  return null;
}

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

test('AK2/AK3 (#889): Bogen läuft in der Nav-Zeile außerhalb der Pille durch, die Pille bleibt --surface', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/uebersicht');

  const navBar = page.locator('.nav__bar');
  const navBarBox = await navBar.boundingBox();
  expect(navBarBox, '.nav__bar hat eine Bounding-Box').not.toBeNull();

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

  const nav = page.locator('.nav');
  const navBox = await nav.boundingBox();
  expect(navBox, '.nav hat eine Bounding-Box').not.toBeNull();
  const viewport = page.viewportSize()!;
  const rects = await arcRects(page);
  const bandPoint = findSpotInNavBandUnderArc(navBox!, navBarBox!, rects);
  expect(
    bandPoint,
    'Testvoraussetzung: auf /uebersicht liegt ein Bogen in der Nav-Zeile außerhalb der Pille',
  ).not.toBeNull();

  await hideForegroundContent(page);
  const groundPoint = findFreeSpotOutsideRects(rects, viewport);
  expect(groundPoint, 'keine bogenfreie Stelle für den Grund-Vergleich').not.toBeNull();

  const [bandColor, groundPixelColor] = await samplePixels(page, [bandPoint!, groundPoint!]);
  expect(
    maxChannelDiff(bandColor, groundPixelColor),
    `Nav-Band-Pixel ${JSON.stringify(bandColor)} vs. Grund ${JSON.stringify(groundPixelColor)}`,
  ).toBeGreaterThanOrEqual(3);
});

test('AK1 (#919): .bg-layer bekommt inset:0, kein Schnitt mehr an der Safe-Area', async ({ page }) => {
  await registerPasskey(page);
  await page.goto('/aufgaben');

  const layerTop = await page.locator('.bg-layer').evaluate((el) => getComputedStyle(el).top);
  expect(layerTop).toBe('0px');
});

test('AK2 (#982): die erzwungene Safe-Area-Zone zeigt den flachen Grund, kein Schleier mehr darüber', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/aufgaben');
  await page.addStyleTag({ content: ':root { --safe-top: 60px; }' });

  // AK1's Geometrie legt die Bogen-Krone bewusst erst bei y ≈ 205px an — kein
  // Bogen reicht in eine realistische Notch-Zone (≤ ~60px) hinein. Genau das
  // ist "kein Schleier mehr darüber": die Zone zeigt den unveränderten,
  // ungedämpften `--ground`, nicht (mehr) eine abgedunkelte Sonderfarbe.
  await hideForegroundContent(page);
  const groundToken = await resolveVarRgb(page, '--ground');
  const [zonePixel] = await samplePixels(page, [{ x: 187, y: 30 }]);
  expect(
    maxChannelDiff(zonePixel, groundToken),
    `Pixel in der Safe-Area-Zone ${JSON.stringify(zonePixel)} vs. --ground ${JSON.stringify(groundToken)}`,
  ).toBeLessThanOrEqual(2);
});

test('AK4 (#919): --safe-top ist ein eigener Anker, Standard 0, per addStyleTag auf einen echten Wert erzwingbar', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/aufgaben');

  const defaultTop = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--safe-top').trim(),
  );
  expect(defaultTop).toBe('0px');

  await page.addStyleTag({ content: ':root { --safe-top: 47px; }' });
  const forcedTop = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--safe-top').trim(),
  );
  expect(forcedTop, '--safe-top lässt sich unabhängig von env() auf einen echten Wert erzwingen').toBe('47px');
});

test('AK9 (#991): 375 × 812 — die Bögen ragen über den Rand, ohne waagerechten Überlauf zu erzeugen', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/uebersicht');

  const rects = await arcRects(page);
  expect(rects, '.bg-arc-Anzahl').toHaveLength(3);
  const viewportWidth = page.viewportSize()!.width;
  expect(rects.some((r) => r.left < 0 || r.left + r.width > viewportWidth), 'mindestens ein Bogen ragt über den Rand').toBe(
    true,
  );

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth, 'kein waagerechter Überlauf durch die Bögen').toBeLessThanOrEqual(viewportWidth);
});

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const f = (channel: number) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function wcagContrast(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

function arcCircle(r: ArcRect) {
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, radius: (Math.min(r.width, r.height) / 2) * 0.9 };
}

/**
 * Finds a point inside `rects[index]` that no later-painted arc (DOM order =
 * paint order, higher index sits on top) also covers — the only points where
 * that arc's own colour is what the browser actually renders on screen.
 */
function findExclusivePointInArc(
  rects: ArcRect[],
  index: number,
  viewport: { width: number; height: number },
): { x: number; y: number } | null {
  const target = arcCircle(rects[index]);
  const laterRects = rects.slice(index + 1);
  const step = 8;
  const minY = Math.max(0, Math.floor(target.cy - target.radius));
  const maxY = Math.min(viewport.height - 1, Math.ceil(target.cy + target.radius));
  const minX = Math.max(0, Math.floor(target.cx - target.radius));
  const maxX = Math.min(viewport.width - 1, Math.ceil(target.cx + target.radius));
  for (let y = minY; y <= maxY; y += step) {
    for (let x = minX; x <= maxX; x += step) {
      if ((x - target.cx) ** 2 + (y - target.cy) ** 2 > target.radius ** 2) continue;
      if (pointInsideAnyArc(laterRects, x, y)) continue;
      return { x, y };
    }
  }
  return null;
}

/**
 * Ersatzdeckung für die entfallenen Lichter (#904 AK4): die Bögen malen sich
 * seit #991 direkt hinter Seiteninhalt, statt einer separaten, gekappten
 * Lichtschicht — dieser Test hält deshalb den `--on-ground`-Kontrast über
 * ALLEN drei Bogenflächen fest, nicht nur einer Lichtspitze.
 */
async function assertArcContrastHoldsOnGround(page: Page, label: string): Promise<void> {
  const viewport = page.viewportSize()!;
  const rects = await arcRects(page);
  expect(rects, `.bg-arc-Anzahl auf ${label}`).toHaveLength(3);
  const ink = await resolveVarRgb(page, '--on-ground');

  await hideForegroundContent(page);
  for (let i = 0; i < rects.length; i += 1) {
    const point = findExclusivePointInArc(rects, i, viewport);
    expect(point, `keine exklusive Stelle für Bogen ${i + 1} auf ${label}`).not.toBeNull();
    const [pixel] = await samplePixels(page, [point!]);
    const contrast = wcagContrast(pixel, ink);
    expect(
      contrast,
      `Bogen ${i + 1} ${JSON.stringify(pixel)} vs. --on-ground ${JSON.stringify(ink)} auf ${label}`,
    ).toBeGreaterThanOrEqual(4.5);
  }
}

test('Ersatz für #904 AK4 hell: --on-ground hält ≥4,5:1 über allen drei Bogenflächen, jede Route', async ({
  page,
  browser,
}) => {
  await registerPasskey(page);
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });

  for (const route of ROUTES) {
    await page.goto(route.path);
    await assertArcContrastHoldsOnGround(page, route.path);
  }

  const anmeldenContext = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: page.viewportSize() ?? undefined,
    colorScheme: 'light',
  });
  const anmeldenPage = await anmeldenContext.newPage();
  await anmeldenPage.emulateMedia({ reducedMotion: 'reduce' });
  await anmeldenPage.goto('/anmelden');
  await assertArcContrastHoldsOnGround(anmeldenPage, '/anmelden');
  await anmeldenContext.close();
});

test('Ersatz für #904 AK4 dunkel: --on-ground hält ≥4,5:1 über allen drei Bogenflächen, jede Route', async ({
  page,
  browser,
}) => {
  await registerPasskey(page);
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });

  for (const route of ROUTES) {
    await page.goto(route.path);
    await assertArcContrastHoldsOnGround(page, route.path);
  }

  const anmeldenContext = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: page.viewportSize() ?? undefined,
    colorScheme: 'dark',
  });
  const anmeldenPage = await anmeldenContext.newPage();
  await anmeldenPage.emulateMedia({ reducedMotion: 'reduce' });
  await anmeldenPage.goto('/anmelden');
  await assertArcContrastHoldsOnGround(anmeldenPage, '/anmelden');
  await anmeldenContext.close();
});
