import { expect, test, type Locator, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, selectView } from './helpers';

/**
 * Verlaufs-Schleier an der mobilen Bodenleiste (issue #908): Seiteninhalt, der
 * beim Scrollen hinter die sticky Nav-Zeile rückt, blendet zum Routen-Grund aus,
 * statt bis an die Pille heranzureichen. Ein Test je AK, gemessen per
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

async function navBeforePseudo(
  page: Page,
): Promise<{ backgroundImage: string; pointerEvents: string; content: string }> {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.nav')!, '::before');
    return { backgroundImage: cs.backgroundImage, pointerEvents: cs.pointerEvents, content: cs.content };
  });
}

test('AK1: der Schleier blendet die Nav-Zeile unten zum Bogen-3-Ton aus, gescrollter Karteninhalt liest darunter als Grundfläche', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/aufgaben');

  const before = await navBeforePseudo(page);
  expect(before.backgroundImage, '.nav::before trägt einen Verlauf').toContain('gradient');

  await seedTallTaskList(page);
  await page.reload();
  await selectView(page, 'Alle');
  await scrollNearBottomBehindNav(page);
  await expectCardBehindNav(page);

  // Der Verlauf blendet zu `--arc-3` aus (issue #991 AK7), nicht zu `--ground`:
  // Bogen 3 liegt immer in der Nav-Zeile, ein `--ground`-Stopp ließe an der
  // Oberkante eine sichtbare Kante entstehen.
  const groundToken = await resolveColorToken(page, '--arc-3');
  const surfaceToken = await resolveColorToken(page, '--surface');
  const groundRgb = await toRgb(page, groundToken);
  const surfaceRgb = await toRgb(page, surfaceToken);

  const nav = page.locator('.nav');
  // relY=0.95: tief im Streifen unter der Pille (Home-Indicator-Bereich), relX=0.5:
  // mittig, weit weg von den seitlichen Rändern der Pille.
  const stripColor = await sampleElementPixel(page, nav, 0.5, 0.95);
  expect(
    maxChannelDiff(stripColor, groundRgb),
    `unterer Streifen ${JSON.stringify(stripColor)} vs. --arc-3 ${JSON.stringify(groundRgb)}`,
  ).toBeLessThan(GROUND_WITH_SHADOW_TOLERANCE);
  expect(
    maxChannelDiff(stripColor, surfaceRgb),
    `unterer Streifen ${JSON.stringify(stripColor)} unterscheidet sich von --surface (Kartenfarbe)`,
  ).toBeGreaterThanOrEqual(GROUND_WITH_SHADOW_TOLERANCE);
});

test('AK2: der Schleier stiehlt keine Berührung — nach dem Scrollen klickt ein Reiter in der Pille durch', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/aufgaben');

  const before = await navBeforePseudo(page);
  expect(before.pointerEvents, '.nav::before ist pointer-events: none').toBe('none');

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

test('AK3: die Pille bleibt eigene --surface-Fläche mit Schatten und liegt über dem Schleier', async ({ page }) => {
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

test('AK4: der Home-Indicator-Streifen liest als Seite (Routen-Grund), nicht als Neutralfläche — in Hell und Dunkel', async ({
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

    // Der Verlauf blendet zu `--arc-3` aus (issue #991 AK7) — siehe AK1 oben.
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

test('AK5: die Oberkante der Nav-Zeile bleibt durchsichtig (Regression zu #889)', async ({ page }) => {
  await registerPasskey(page);
  await page.goto('/uebersicht');

  const before = await navBeforePseudo(page);
  // "to top" heißt: der Verlauf läuft vom unteren zum oberen Rand von `.nav` — der
  // letzte Stop im normalisierten String ist die Oberkante, und die muss vollständig
  // durchsichtig sein. Sonst schneidet der Schleier die Hintergrundkreise wie vor
  // #889 an der Nav-Oberkante ab (der bestehende hintergrundkreise.spec.ts-#889-Test
  // deckt das zusätzlich mit echten Bildschirm-Pixeln ab).
  // Chromium keeps `background-image` gradient stops in their declared colour
  // function (here `oklch(...)` for the ground stops, tokens.css) instead of
  // normalising them to rgb() the way it does for plain `color`/`background-color`
  // — the stop-matcher has to cover both.
  const stops = before.backgroundImage.match(/(?:rgba?|oklch)\([^)]+\)/g) ?? [];
  expect(stops.length, `Verlauf hat mindestens zwei Farbstopps: ${before.backgroundImage}`).toBeGreaterThanOrEqual(
    2,
  );
  expect(stops[stops.length - 1], `letzter Stop (Oberkante) ist durchsichtig: ${before.backgroundImage}`).toBe(
    'rgba(0, 0, 0, 0)',
  );

  const navBg = await page.locator('.nav').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(navBg, '.nav trägt weiterhin keine eigene Fläche').toBe('rgba(0, 0, 0, 0)');
});

test('AK6: auf Desktop (≥768px) gibt es keinen Schleier — die Sidebar trägt ihre eigene Fläche', async ({ page }) => {
  await registerPasskey(page);
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto('/aufgaben');

  const before = await navBeforePseudo(page);
  expect(before.content, '.nav::before ist auf Desktop abgeschaltet').toBe('none');

  const surfaceToken = await resolveColorToken(page, '--surface');
  const navBg = await page.locator('.nav').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(navBg, 'die Sidebar trägt ihre eigene --surface-Fläche').toBe(surfaceToken);
});
