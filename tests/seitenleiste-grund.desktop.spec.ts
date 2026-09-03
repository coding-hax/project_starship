import { expect, test, type Locator, type Page } from '@playwright/test';
import { registerPasskey, resetAppData } from './helpers';

/**
 * Desktop-only (issue #1019): the sidebar loses its own `--surface` fill from
 * 768px up and stands on the route ground instead — arcs run through behind
 * it, inactive link ink becomes `--on-ground`, only the active entry keeps a
 * `--surface` pill. Local helpers mirror `hintergrundboegen.spec.ts` (#991
 * AK8) — kept module-local there, so copied rather than imported, same
 * pattern as every other design spec in this file.
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

const ARC_TOKENS = ['--arc-1', '--arc-2', '--arc-3'] as const;

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

async function cssColorToRgb(page: Page, color: string): Promise<[number, number, number]> {
  return page.evaluate((color) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    return [data[0], data[1], data[2]] as [number, number, number];
  }, color);
}

/** Batches several `resolveVarRgb` lookups into one round-trip — AK3/AK4 loop this
 * over eight routes, and one `page.evaluate` per token instead of one per route
 * pushed the whole route×theme loop past the 30s test timeout in CI (issue #1019). */
async function resolveVarsRgb(page: Page, names: readonly string[]): Promise<[number, number, number][]> {
  return page.evaluate((names) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    return names.map((name) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${name})`;
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const data = ctx.getImageData(0, 0, 1, 1).data;
      return [data[0], data[1], data[2]] as [number, number, number];
    });
  }, names);
}

/** `inactiveLink.evaluate` + `cssColorToRgb` in one round-trip instead of two — same
 * reasoning as `resolveVarsRgb` above. */
async function elementColorRgb(locator: Locator): Promise<[number, number, number]> {
  return locator.evaluate((el) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = getComputedStyle(el).color;
    ctx.fillRect(0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    return [data[0], data[1], data[2]] as [number, number, number];
  });
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

test('AK1: .nav trägt keine eigene Fläche mehr, kein Schleier', async ({ page }) => {
  await registerPasskey(page);
  await page.goto('/aufgaben');

  const nav = page.locator('.nav');
  const backgroundColor = await nav.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(backgroundColor).toBe('rgba(0, 0, 0, 0)');
  const surfaceRgb = await resolveVarRgb(page, '--surface');
  expect(backgroundColor).not.toBe(`rgb(${surfaceRgb.join(', ')})`);

  const beforeContent = await nav.evaluate((el) => getComputedStyle(el, '::before').content);
  expect(beforeContent).toBe('none');
});

test('AK2: nur der aktive Eintrag trägt --surface, in beiden Themes', async ({ page }) => {
  await registerPasskey(page);

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/aufgaben');

    const activeLink = page
      .getByRole('navigation', { name: 'Hauptnavigation' })
      .getByRole('link', { name: 'Aufgaben' });
    await expect(activeLink).toHaveAttribute('aria-current', 'page');

    const surfaceRgb = await resolveVarRgb(page, '--surface');
    const accentRgb = await resolveVarRgb(page, '--area-tasks');
    const textBaseRgb = await resolveVarRgb(page, '--text-base');

    const activeStyle = await activeLink.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { backgroundColor: cs.backgroundColor, color: cs.color, text: cs.getPropertyValue('--text').trim() };
    });
    const activeBackgroundRgb = await cssColorToRgb(page, activeStyle.backgroundColor);
    expect(activeBackgroundRgb, `Aktive Pille (${scheme})`).toEqual(surfaceRgb);
    const activeColorRgb = await cssColorToRgb(page, activeStyle.color);
    expect(activeColorRgb, `Aktive Labelfarbe (${scheme})`).toEqual(accentRgb);
    const activeTextRgb = await cssColorToRgb(page, activeStyle.text || 'transparent');
    expect(activeTextRgb, `Ink-Reset des aktiven Eintrags (${scheme})`).toEqual(textBaseRgb);

    const inactiveLink = page
      .getByRole('navigation', { name: 'Hauptnavigation' })
      .getByRole('link', { name: 'Routinen' });
    const inactiveBackground = await inactiveLink.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(inactiveBackground, `Inaktiver Eintrag ohne Fläche (${scheme})`).toBe('rgba(0, 0, 0, 0)');
  }
});

/**
 * AK3/AK4 run one test per theme instead of one test looping both (issue #1019):
 * eight routes × two themes = 16 full navigations blew past the 30s Playwright
 * test timeout under CI load ("page.goto: net::ERR_ABORTED; maybe frame was
 * detached?", `e2e-main (10)`). Halving the per-test navigation count is a
 * structural fix, not a weakened test — same assertions, same coverage, just
 * split at the theme boundary the test names already called out.
 */
async function assertAk3(page: Page, scheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: scheme });
  for (const route of ROUTES) {
    await page.goto(route.path);
    const onGroundRgb = await resolveVarRgb(page, '--on-ground');
    const inactiveLink = page.locator('.nav__link:not([aria-current="page"])').first();
    const colorRgb = await elementColorRgb(inactiveLink);
    expect(colorRgb, `Inaktive Leistenschrift auf ${route.path} (${scheme})`).toEqual(onGroundRgb);
  }
}

test('AK3 (hell): inaktive Leistenschrift ist --on-ground (voll), auf allen Routen', async ({ page }) => {
  await registerPasskey(page);
  await assertAk3(page, 'light');
});

test('AK3 (dunkel): inaktive Leistenschrift ist --on-ground (voll), auf allen Routen', async ({ page }) => {
  await registerPasskey(page);
  await assertAk3(page, 'dark');
});

async function assertAk4(page: Page, scheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: scheme });
  const tokens = [...ARC_TOKENS, '--ground'] as const;
  for (const route of ROUTES) {
    await page.goto(route.path);
    const inactiveLink = page.locator('.nav__link:not([aria-current="page"])').first();
    const ink = await elementColorRgb(inactiveLink);
    const targets = await resolveVarsRgb(page, tokens);

    for (const [i, token] of tokens.entries()) {
      const targetRgb = targets[i];
      const contrast = wcagContrast(ink, targetRgb);
      expect(
        contrast,
        `Leistenschrift ${JSON.stringify(ink)} vs. ${token} ${JSON.stringify(targetRgb)} auf ${route.path} (${scheme})`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
}

test('AK4 (hell): inaktive Leistenschrift hält ≥4,5:1 auf jedem der drei Bögen und auf dem Grund', async ({
  page,
}) => {
  await registerPasskey(page);
  await assertAk4(page, 'light');
});

test('AK4 (dunkel): inaktive Leistenschrift hält ≥4,5:1 auf jedem der drei Bögen und auf dem Grund', async ({
  page,
}) => {
  await registerPasskey(page);
  await assertAk4(page, 'dark');
});
