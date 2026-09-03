import { expect, test, type Locator, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, selectView } from './helpers';

/**
 * Verdeckung an der mobilen Bodenleiste (issue #908, Träger gewechselt in
 * issue #1006): Seiteninhalt, der beim Scrollen hinter die sticky Nav-Zeile
 * rückt, blendet aus, statt bis an die Pille heranzureichen. Verdeckt wird
 * seit #1006 mit einer beschnittenen Kopie des echten Hintergrunds
 * (`.nav-ground`) statt mit einer flachen Fläche in einer von Hand
 * nachgezogenen Farbe — deshalb prüft AK1 die Gleichheit der beiden
 * Hintergrund-Ausgaben und AK2 die Nahtlosigkeit an der Oberkante, wo die
 * alte Lösung ihre Kante hatte (#889). Ein Test je AK, gemessen per
 * getComputedStyle/gemaltem Pixel statt per Augenschein. Setup wie
 * grundfarbe-vollfarbe.spec.ts. Läuft im Projekt-Standard-Viewport 375×812.
 */

test.describe.configure({ timeout: 60_000 });

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

async function seedTask(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: p }),
    payload,
  );
}

/** Seeds enough open tasks that /aufgaben's "Alle" card overflows the 812px
 * viewport by several screenfuls — scrolling near the end then really does slide
 * card rows behind the sticky nav instead of leaving empty space there. */
async function seedTallTaskList(page: Page, count = 30): Promise<void> {
  for (let i = 0; i < count; i++) {
    await seedTask(page, {
      title: `Schleier-Sonde ${i}`,
      createdAt: new Date(Date.UTC(2026, 6, 18, 0, i)).toISOString(),
    });
  }
}

/**
 * Scrolls to `margin` px short of the true document end, not all the way to
 * `scrollHeight`. `.nav`'s own row is a dedicated, always-empty grid track
 * (grid-row: 3, right after `main`'s grid-row: 2) — at the *exact* scroll max,
 * the sticky bar's screen position coincides with that empty track and nothing
 * else was ever there, veil or not. Short of max, the sticky bar still paints
 * over real `main` content that hasn't scrolled past yet — the actual scenario
 * this ticket is about. 200px, against ~30 seeded rows (well over 1000px of
 * card height), leaves generous room on both sides.
 */
async function scrollNearBottomBehindNav(page: Page, margin = 200): Promise<void> {
  await page.evaluate((m) => {
    const target = document.body.scrollHeight - window.innerHeight - m;
    window.scrollTo(0, Math.max(0, target));
  }, margin);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
}

/** Testvoraussetzung für die Streifen-Tests unten: nach dem Scrollen liegt eine
 * echte Karte tatsächlich hinter der Nav-Zeile (nicht nur leerer Grund). Seit
 * issue #996 ist die ganze Liste eine einzige `.task-list__surface` statt
 * einer je Gruppe — "Alle" hatte davor ohnehin nur eine (keine Gruppen), das
 * hier holt sich also dieselbe Fläche, nur unter dem neuen Namen. */
async function expectCardBehindNav(page: Page): Promise<void> {
  const overlaps = await page.evaluate(() => {
    const card = document.querySelector('.task-list__surface');
    const nav = document.querySelector('.nav');
    if (!card || !nav) return false;
    const cardBox = card.getBoundingClientRect();
    const navBox = nav.getBoundingClientRect();
    return cardBox.bottom > navBox.top && cardBox.top < navBox.bottom;
  });
  expect(overlaps, 'Testvoraussetzung: die letzte Karte reicht bis in die Nav-Zeile hinein').toBe(true);
}

/** Mirrors grundfarbe-vollfarbe.spec.ts's own probe-span technique. */
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

/** Same canvas round-trip grundfarbe.spec.ts/hintergrundkreise.spec.ts use to turn a
 * CSS colour string (rgb()/oklch()/named) into comparable sRGB bytes. */
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

function maxChannelDiff(a: [number, number, number], b: [number, number, number]): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

/**
 * The strip sampled below the pill (relY=0.95) sits inside `.nav__bar`'s own
 * `--shadow-raised` (0 10px 26px, tokens.css) — a real, pre-existing soft shadow
 * that tints even a plain-ground pixel a few channel steps darker, not something
 * this ticket introduces or the veil can avoid. Dark mode's shadow alpha is over
 * 3× light mode's (0.4 vs. 0.12), measured up to 23 there — 30 comfortably absorbs
 * both while staying an order of magnitude below the gap to `--surface` (a
 * near-white card colour vs. a saturated route ground, easily 100+ per channel).
 */
const GROUND_WITH_SHADOW_TOLERANCE = 30;

/** Reads a real composited pixel from `locator`'s own painted box (issue #849's
 * screenshot-not-getComputedStyle technique, scoped to one element) — `relX`/`relY`
 * are fractions (0..1) of that element's own bounding box, not viewport coordinates. */
async function sampleElementPixel(
  page: Page,
  locator: Locator,
  relX: number,
  relY: number,
): Promise<[number, number, number]> {
  const buffer = await locator.screenshot();
  const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
  return page.evaluate(
    ({ dataUrl, relX, relY }) =>
      new Promise<[number, number, number]>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(img, 0, 0);
          const x = Math.min(img.naturalWidth - 1, Math.round(relX * img.naturalWidth));
          const y = Math.min(img.naturalHeight - 1, Math.round(relY * img.naturalHeight));
          const data = ctx.getImageData(x, y, 1, 1).data;
          resolve([data[0], data[1], data[2]]);
        };
        img.onerror = () => reject(new Error('Element-Screenshot ließ sich nicht als Bild laden'));
        img.src = dataUrl;
      }),
    { dataUrl, relX, relY },
  );
}

/** Reads the nav row's own background copy (issue #1006) plus what is left of
 * the pseudo-element it replaced — `content: 'none'` is what an unstyled
 * `::before` computes to, i.e. the proof that no rule paints there anymore. */
async function navGroundStyles(
  page: Page,
): Promise<{ maskImage: string; pointerEvents: string; display: string; beforeContent: string }> {
  return page.evaluate(() => {
    const copy = document.querySelector('.nav-ground');
    const cs = copy ? getComputedStyle(copy) : null;
    const before = getComputedStyle(document.querySelector('.nav')!, '::before');
    return {
      maskImage: cs?.maskImage ?? 'kein .nav-ground im DOM',
      pointerEvents: cs?.pointerEvents ?? 'kein .nav-ground im DOM',
      display: cs?.display ?? 'kein .nav-ground im DOM',
      beforeContent: before.content,
    };
  });
}

/** Reads one composited pixel in VIEWPORT coordinates — the element-scoped
 * `sampleElementPixel` above cannot compare across two boxes, which is exactly
 * what the seam test (AK2) needs. The project's viewport runs at
 * deviceScaleFactor 1 (playwright.config.ts, `devices['Desktop Chrome']`), so
 * screenshot pixels and CSS pixels are the same grid. */
async function samplePagePixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const buffer = await page.screenshot();
  const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
  return page.evaluate(
    ({ dataUrl, x, y }) =>
      new Promise<[number, number, number]>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(img, 0, 0);
          const data = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
          resolve([data[0], data[1], data[2]]);
        };
        img.onerror = () => reject(new Error('Seiten-Screenshot ließ sich nicht als Bild laden'));
        img.src = dataUrl;
      }),
    { dataUrl, x, y },
  );
}

/** Geometry and tone of the three arcs in one background layer, in DOM order.
 * `scale` (the pulse) is a transform-like property and never changes a
 * computed `width`/`height`, so this reads the same values mid-pulse as at
 * rest — no timing, no flake. */
async function arcsOf(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    return [...root.querySelectorAll('.bg-arc')].map((el) => {
      const cs = getComputedStyle(el);
      return {
        width: cs.width,
        height: cs.height,
        bottom: cs.bottom,
        left: cs.left,
        backgroundColor: cs.backgroundColor,
      };
    });
  }, selector);
}

/**
 * Ein Schleier in der falschen Farbe — der Zustand vor diesem Ticket, wenn
 * jemand die Bogenfarbe nicht nachzieht — liegt weit über dieser Schranke:
 * `--ground` und `--arc-3` trennen auf Übersicht 44 Kanalstufen (grün 161 vs.
 * 205). 12 lässt Raum für den Kartenschatten, der in beide Proben ein paar
 * Stufen streut, und fängt jede echte Kante trotzdem.
 */
const SEAM_TOLERANCE = 12;

test('AK1: die Nav-Zeile trägt eine Kopie des echten Hintergrunds, keine nachgezogene Farbe', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/aufgaben');

  const copy = page.locator('.nav-ground');
  await expect(copy, 'die Nav-Zeile hat eine eigene Hintergrund-Ausgabe').toBeVisible();

  const navArcs = await arcsOf(page, '.nav-ground');
  const ambientArcs = await arcsOf(page, '.bg-layer');
  expect(navArcs, 'die Kopie rendert dieselben drei Bögen').toHaveLength(3);
  expect(navArcs, 'Geometrie und Ton je Bogen sind identisch mit der Umgebungsschicht').toEqual(
    ambientArcs,
  );

  const styles = await navGroundStyles(page);
  expect(styles.beforeContent, '.nav::before malt nichts mehr').toBe('none');

  // Kein Verlauf mehr in `.nav` selbst: die Farbe, die dort liegt, kommt aus
  // der Kopie und wird nirgends ein zweites Mal von Hand hingeschrieben.
  const navBackground = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.nav')!);
    return { image: cs.backgroundImage, color: cs.backgroundColor };
  });
  expect(navBackground.image, '.nav malt keinen eigenen Verlauf').toBe('none');
  expect(navBackground.color, '.nav trägt keine eigene Fläche').toBe('rgba(0, 0, 0, 0)');
});

test('AK2: an der Oberkante der Nav-Zeile entsteht keine Kante', async ({ page }) => {
  await registerPasskey(page);
  await page.goto('/uebersicht');
  await expect(page.getByRole('navigation', { name: 'Hauptnavigation' })).toBeVisible();

  const navBox = (await page.locator('.nav').boundingBox())!;
  // x = 4: links der 16px-Polsterung von `main` und links der Pille (12px
  // Rand) — auf beiden Seiten der Kante liegt dort nur Hintergrund.
  const x = 4;
  // Tief im Streifen unter der Pille, wo die Kopie voll deckt …
  const inRow = await samplePagePixel(page, x, navBox.y + navBox.height - 3);
  // … gegen einen Punkt oberhalb der Nav-Zeile, außerhalb der Reichweite des
  // Pillenschattens (0 8px 30px, tokens.css: höchstens 22px über deren
  // Oberkante, die selbst 8px unter der Nav-Oberkante liegt).
  const aboveRow = await samplePagePixel(page, x, navBox.y - 40);
  expect(
    maxChannelDiff(inRow, aboveRow),
    `Nav-Zeile ${JSON.stringify(inRow)} vs. darüber ${JSON.stringify(aboveRow)}`,
  ).toBeLessThanOrEqual(SEAM_TOLERANCE);
});

test('AK3: gescrollter Karteninhalt bleibt unter der Nav-Zeile unsichtbar — in Hell und Dunkel', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/aufgaben');
  await seedTallTaskList(page);

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.reload();
    await selectView(page, 'Alle');
    await scrollNearBottomBehindNav(page);
    await expectCardBehindNav(page);

    const navBg = await page.locator('.nav').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(navBg, `.nav trägt weiterhin keine eigene Fläche (${scheme})`).toBe('rgba(0, 0, 0, 0)');

    // Der Streifen liest als der Hintergrund, auf dem die Zeile liegt — seit
    // #991 ist das Bogen 3, seit #1006 malt ihn die Kopie selbst statt einer
    // gleichfarbigen Fläche. Entscheidend ist beides Mal: nicht die Karte.
    const groundToken = await resolveColorToken(page, '--arc-3');
    const surfaceToken = await resolveColorToken(page, '--surface');
    const groundRgb = await toRgb(page, groundToken);
    const surfaceRgb = await toRgb(page, surfaceToken);

    const stripColor = await sampleElementPixel(page, page.locator('.nav'), 0.5, 0.95);
    expect(
      maxChannelDiff(stripColor, groundRgb),
      `Streifen (${scheme}) ${JSON.stringify(stripColor)} vs. --arc-3 ${JSON.stringify(groundRgb)}`,
    ).toBeLessThan(GROUND_WITH_SHADOW_TOLERANCE);
    expect(
      maxChannelDiff(stripColor, surfaceRgb),
      `Streifen (${scheme}) unterscheidet sich von --surface`,
    ).toBeGreaterThanOrEqual(GROUND_WITH_SHADOW_TOLERANCE);
  }
});

test('AK4: die Ausblendung liegt auf der Kopie und endet an der Oberkante durchsichtig', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/uebersicht');

  const styles = await navGroundStyles(page);
  expect(styles.maskImage, 'die Kopie blendet per Maske aus').toContain('gradient');
  // "to top" heißt: der letzte Stopp ist die Oberkante der Nav-Zeile, und die
  // muss vollständig durchsichtig sein. Sonst schneidet die Kopie den
  // Hintergrund an genau der Kante ab, die #889 schon einmal aufgemacht hat.
  const stops = styles.maskImage.match(/(?:rgba?|oklch)\([^)]+\)/g) ?? [];
  expect(stops.length, `Maske hat mindestens zwei Stopps: ${styles.maskImage}`).toBeGreaterThanOrEqual(2);
  expect(
    stops[stops.length - 1],
    `letzter Stopp (Oberkante) ist durchsichtig: ${styles.maskImage}`,
  ).toBe('rgba(0, 0, 0, 0)');
});

test('AK5: die Kopie stiehlt keine Berührung — nach dem Scrollen klickt ein Reiter in der Pille durch', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/aufgaben');

  const styles = await navGroundStyles(page);
  expect(styles.pointerEvents, '.nav-ground ist pointer-events: none').toBe('none');

  await seedTallTaskList(page);
  await page.reload();
  await selectView(page, 'Alle');
  await scrollNearBottomBehindNav(page);
  await expectCardBehindNav(page);

  const kalenderTab = page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Kalender' });
  await expect(kalenderTab).toBeVisible();
  await kalenderTab.click();
  await expect(page).toHaveURL(/\/kalender$/);
});

test('AK6: die Pille bleibt eigene --surface-Fläche mit Schatten und liegt über der Kopie', async ({ page }) => {
  await registerPasskey(page);
  await page.goto('/aufgaben');
  await seedTallTaskList(page);
  await page.reload();
  await selectView(page, 'Alle');
  await scrollNearBottomBehindNav(page);
  await expectCardBehindNav(page);

  const navBar = page.locator('.nav__bar');
  const surfaceToken = await resolveColorToken(page, '--surface');
  expect(await navBar.evaluate((el) => getComputedStyle(el).backgroundColor), '.nav__bar-Fläche').toBe(surfaceToken);
  expect(await navBar.evaluate((el) => getComputedStyle(el).boxShadow), '.nav__bar-Schatten').not.toBe('none');

  const surfaceRgb = await toRgb(page, surfaceToken);
  const pillColor = await sampleElementPixel(page, navBar, 0.5, 0.5);
  expect(
    maxChannelDiff(pillColor, surfaceRgb),
    `Pillen-Mitte ${JSON.stringify(pillColor)} vs. --surface ${JSON.stringify(surfaceRgb)}`,
  ).toBeLessThan(3);
});

test('AK7: auf Desktop (≥768px) gibt es keine Kopie — die Sidebar steht ohne eigene Fläche auf dem Grund (#1019)', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto('/aufgaben');

  const styles = await navGroundStyles(page);
  expect(styles.display, '.nav-ground ist auf Desktop abgeschaltet').toBe('none');

  const navBg = await page.locator('.nav').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(navBg, 'die Sidebar trägt keine eigene Fläche mehr, der Grund scheint durch').toBe('rgba(0, 0, 0, 0)');
});

test('AK8: bei „Ruhe reduzieren" steht auch die Kopie still und untransformiert', async ({ page }) => {
  await registerPasskey(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/uebersicht');

  const arcs = await page.evaluate(() =>
    [...document.querySelectorAll('.nav-ground .bg-arc')].map((el) => {
      const cs = getComputedStyle(el);
      return { animationName: cs.animationName, scale: cs.scale };
    }),
  );
  expect(arcs, 'die Kopie rendert drei Bögen').toHaveLength(3);
  for (const [index, arc] of arcs.entries()) {
    expect(arc.animationName, `Bogen ${index + 1} der Kopie animiert nicht`).toBe('none');
    expect(arc.scale, `Bogen ${index + 1} der Kopie ruht untransformiert`).toBe('1');
  }
});
