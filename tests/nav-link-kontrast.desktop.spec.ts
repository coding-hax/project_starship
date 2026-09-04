import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData } from './helpers';

/**
 * Desktop-only (issue #1047): the sidebar's active nav entry used to carry its
 * own --area-* accent as text colour on a --surface pill — readable in dark
 * mode, but under 4.5:1 in light mode on every route (worst: /journal at
 * 1.02:1, literally white-on-white — its --on-ground happens to be a near-
 * white token, unlike the other eight routes). Option A (issue discussion,
 * 03.09.) moves the active entry to the neutral --text-base ink the rest of
 * .nav__bar's "own surface, own ink" pattern already uses (#832 AK5) — the
 * accent survives only as the icon pill's 15%-tint (shell.css
 * `.nav__icon::before`). Mirrors seitenleiste-grund.desktop.spec.ts's local
 * helpers (#1019) — kept module-local there too, so copied rather than
 * imported.
 */

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

/** oklch() survives getComputedStyle verbatim in Chromium — a naive rgb()-regex
 * would misparse the L/C/H numbers as R/G/B, so every colour is round-tripped
 * through a 1×1 canvas instead (same technique as grundfarbe.spec.ts, issue #709). */
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

async function resolveVarRgb(page: Page, name: string): Promise<[number, number, number]> {
  const raw = await page.evaluate((cssVar) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${cssVar})`;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, name);
  return toRgb(page, raw);
}

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

async function ownContrast(page: Page, selector: string): Promise<number> {
  const style = await page.locator(selector).evaluate((el) => {
    const cs = getComputedStyle(el);
    return { color: cs.color, backgroundColor: cs.backgroundColor };
  });
  const [color, backgroundColor] = await Promise.all([toRgb(page, style.color), toRgb(page, style.backgroundColor)]);
  return wcagContrast(color, backgroundColor);
}

test('AK1 (hell): aktiver Eintrag auf /journal hält ≥4,5:1 gegen die eigene Fläche', async ({ page }) => {
  await registerPasskey(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/journal');

  const activeLink = page
    .getByRole('navigation', { name: 'Hauptnavigation' })
    .getByRole('link', { name: 'Journal' });
  await expect(activeLink).toHaveAttribute('aria-current', 'page');

  expect(await ownContrast(page, '.nav__link[aria-current="page"]')).toBeGreaterThanOrEqual(4.5);
});

test('AK2 (hell): gehoverter Eintrag hält ≥4,5:1 auf /journal', async ({ page }) => {
  await registerPasskey(page);
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto('/journal');

  const inactiveLink = page.locator('.nav__link:not([aria-current="page"])').first();
  await inactiveLink.hover();

  async function measure() {
    const style = await inactiveLink.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { color: cs.color, backgroundColor: cs.backgroundColor };
    });
    const [color, backgroundColor] = await Promise.all([
      toRgb(page, style.color),
      toRgb(page, style.backgroundColor),
    ]);
    return wcagContrast(color, backgroundColor);
  }

  // `.nav__link`'s `transition: color` (shell.css) races this read: hovering flips
  // --text from journal's near-white route ink (--on-ground-light) to the dark
  // --text-base, and a same-tick getComputedStyle can land mid-fade even under
  // reducedMotion (observed as low as 2.65:1 for a settled >9:1 — same failure
  // mode as kalender.spec.ts's category-colour assertions). expect.poll re-reads
  // until the transition has actually settled.
  await expect.poll(measure).toBeGreaterThanOrEqual(4.5);
});

test('AK3 (dunkel): aktiver Eintrag auf /journal bleibt lesbar', async ({ page }) => {
  await registerPasskey(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/journal');

  expect(await ownContrast(page, '.nav__link[aria-current="page"]')).toBeGreaterThanOrEqual(4.5);
});

test('AK4 (hell): aktiver Eintrag hält ≥4,5:1 auch auf /uebersicht und /aufgaben', async ({ page }) => {
  await registerPasskey(page);
  await page.emulateMedia({ colorScheme: 'light' });

  for (const path of ['/uebersicht', '/aufgaben']) {
    await page.goto(path);
    expect(await ownContrast(page, '.nav__link[aria-current="page"]'), path).toBeGreaterThanOrEqual(4.5);
  }
});

test('AK5: mobile Nav-Pille unverändert, aktiver Eintrag trägt weiterhin seine Bereichsfarbe', async ({ page }) => {
  await registerPasskey(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/journal');

  const activeColorStr = await page
    .locator('.nav__link[aria-current="page"]')
    .evaluate((el) => getComputedStyle(el).color);
  const [activeColor, areaJournalRgb] = await Promise.all([
    toRgb(page, activeColorStr),
    resolveVarRgb(page, '--area-journal'),
  ]);
  expect(activeColor).toEqual(areaJournalRgb);
});
