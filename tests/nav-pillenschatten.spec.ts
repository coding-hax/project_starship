import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData } from './helpers';

/**
 * Der Schatten der Nav-Pille (issue #1071). Bis dahin kappte
 * `clip-path: inset(-40px -40px 0 -40px)` auf `.nav__bar` den eigenen Schatten
 * der Pille genau auf ihrer Unterkante (#831/#908) — eine perfekt waagerechte
 * Linie über die volle Bildschirmbreite, an der ein spürbar eingefärbter Grund
 * abrupt in den unberührten übergeht. Auf dem Gerät liest der Streifen darunter
 * dadurch als eigener, hellerer Block; im Playwright-Browser fällt es weniger
 * auf, weil `env(safe-area-inset-bottom)` dort 0 ist und der Streifen 8 statt
 * 42 px hoch wird. Gemessen wird deshalb am gemalten Pixel, nicht am
 * Augenschein — und die Kante selbst wird als Sprung zwischen *benachbarten*
 * Pixeln gemessen, damit die Prüfung von der Streifenhöhe unabhängig ist.
 *
 * Ein eigener Spec statt eines Anbaus an `nav-schleier.spec.ts`: die Datei
 * wird von #1006 gerade auf einen anderen Träger umgeschrieben.
 */

test.describe.configure({ timeout: 120_000 });

const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';
const GARMIN_SYNC_PATTERN = '**/api/garmin-sync';

type Rgb = [number, number, number];

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

/**
 * Eine senkrechte Pixelspalte aus *einem* Bildschirmfoto — ein Foto je Messung,
 * nie eins je Pixel: die drei Hintergrundbögen pulsieren (background-arcs.css),
 * zwei Aufnahmen kurz nacheinander lägen also auf verschiedenen Frames und
 * jeder Vergleich zwischen ihnen wäre Rauschen statt Kante.
 */
async function columnPixels(page: Page, x: number, yFrom: number, height: number): Promise<Rgb[]> {
  const buffer = await page.screenshot({ clip: { x, y: yFrom, width: 1, height } });
  const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
  return page.evaluate(
    ({ dataUrl, height }) =>
      new Promise<Rgb[]>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(img, 0, 0);
          // Skaliert statt 1:1 gelesen: ein Gerät mit deviceScaleFactor > 1
          // liefert mehr Bildpunkte als CSS-Pixel angefordert wurden.
          const scale = img.naturalHeight / height;
          const column = Math.floor(img.naturalWidth / 2);
          const out: Rgb[] = [];
          for (let i = 0; i < height; i += 1) {
            const y = Math.min(img.naturalHeight - 1, Math.round((i + 0.5) * scale));
            const data = ctx.getImageData(column, y, 1, 1).data;
            out.push([data[0], data[1], data[2]]);
          }
          resolve(out);
        };
        img.onerror = () => reject(new Error('Bildschirmfoto ließ sich nicht als Bild laden'));
        img.src = dataUrl;
      }),
    { dataUrl, height },
  ) as Promise<Rgb[]>;
}

function maxChannelDiff(a: Rgb, b: Rgb): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

async function toRgb(page: Page, color: string): Promise<Rgb> {
  return page.evaluate((c) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b] as Rgb;
  }, color);
}

async function navBarBox(page: Page) {
  const box = await page.locator('.nav__bar').boundingBox();
  expect(box, '.nav__bar hat eine Bounding-Box').not.toBeNull();
  return box!;
}

test('AK1: die Pille schneidet ihren Schatten nicht mehr ab und behält ihn', async ({ page }) => {
  await registerPasskey(page, '/uebersicht');

  const navBar = page.locator('.nav__bar');
  expect(
    await navBar.evaluate((el) => getComputedStyle(el).clipPath),
    '.nav__bar trägt kein clip-path mehr',
  ).toBe('none');

  const [shadow, token] = await Promise.all([
    navBar.evaluate((el) => getComputedStyle(el).boxShadow),
    page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.boxShadow = 'var(--shadow-float)';
      document.body.append(probe);
      const value = getComputedStyle(probe).boxShadow;
      probe.remove();
      return value;
    }),
  ]);
  expect(shadow, '.nav__bar trägt weiterhin --shadow-float').toBe(token);
});

test('AK2: an der Pillen-Unterkante liegt keine Kante — in Hell und Dunkel', async ({ page }) => {
  await registerPasskey(page);

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/uebersicht');
    const box = await navBarBox(page);

    // x = 4: links neben der Pille (sie beginnt bei --space-3 = 12px), also im
    // Grund und außerhalb jeder Karte. Fenster um die Unterkante, oben und
    // unten beschnitten auf das, was der Viewport hergibt.
    const viewport = page.viewportSize()!;
    const yFrom = Math.max(0, Math.round(box.y + box.height) - 8);
    const yTo = Math.min(viewport.height, Math.round(box.y + box.height) + 12);
    const column = await columnPixels(page, 4, yFrom, yTo - yFrom);

    let worst = 0;
    let worstAt = yFrom;
    for (let i = 0; i < column.length - 1; i += 1) {
      const step = maxChannelDiff(column[i], column[i + 1]);
      if (step > worst) {
        worst = step;
        worstAt = yFrom + i;
      }
    }
    expect(
      worst,
      `größter Sprung zwischen benachbarten Pixeln (${scheme}) bei y=${worstAt}: ${JSON.stringify(column)}`,
    ).toBeLessThanOrEqual(2);
  }
});

test('AK3: der Schatten läuft unter der Pille weiter und dort aus — in Hell und Dunkel', async ({
  page,
}) => {
  await registerPasskey(page);

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/uebersicht');
    const box = await navBarBox(page);

    const grundRgb = await toRgb(
      page,
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--arc-3').trim(),
      ),
    );

    const x = Math.round(box.x + box.width / 2);
    const bottom = Math.round(box.y + box.height);
    const [zwei, drei, vier] = await columnPixels(page, x, bottom + 2, 3);

    expect(
      maxChannelDiff(zwei, grundRgb),
      `2px unter der Pille (${scheme}) ${JSON.stringify(zwei)} vs. --arc-3 ${JSON.stringify(grundRgb)} — der Schatten ist da`,
    ).toBeGreaterThanOrEqual(8);
    expect(
      maxChannelDiff(vier, grundRgb),
      `4px unter der Pille (${scheme}) ${JSON.stringify(vier)} vs. --arc-3 ${JSON.stringify(grundRgb)} — er bleibt leicht`,
    ).toBeLessThanOrEqual(22);
    // Monoton heller werdend statt Stufe: der mittlere Wert liegt zwischen den
    // beiden äußeren, sonst ist irgendwo doch wieder eine Kante.
    const abstaende = [zwei, drei, vier].map((p) => maxChannelDiff(p, grundRgb));
    expect(
      abstaende[1] <= abstaende[0] && abstaende[2] <= abstaende[1],
      `Schatten klingt monoton ab (${scheme}): ${JSON.stringify(abstaende)}`,
    ).toBe(true);
  }
});
