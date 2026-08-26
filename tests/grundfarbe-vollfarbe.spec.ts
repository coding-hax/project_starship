import { expect, test, type Locator, type Page } from '@playwright/test';
import { FIXED_NOW, registerPasskey, resetAppData } from './helpers';

/**
 * Karten, Leiste und Bedienelemente im Vollfarb-Kontext (issue #831, S5 von
 * #828). Ein Test je AK; jeder Test misst Kontrast/Fläche per getComputedStyle
 * statt per Augenschein (Ticket-Vorgabe). Läuft im Projekt-Standard-Viewport
 * 375×812 (playwright.config.ts) — kein explizites setViewportSize nötig.
 */

const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';
const GARMIN_SYNC_PATTERN = '**/api/garmin-sync';

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // issue #230/memory: /aktivitaeten stößt beim Öffnen /api/garmin-sync an, ungemockt
  // 503 landet als Dev-Overlay-Badge im DOM. /uebersicht holt Wetter — ungemockt
  // leckt der echte Fetch in jeden Test, der diese Route besucht.
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

/** Mirrors grundfarbe.spec.ts's own probe-span technique. */
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

/** Same technique, but the probe is a child of `selector` — resolves the custom
 * property from that element's own cascade context, not document.body's. Used
 * to prove `.nav__bar` (not `.nav`) now owns the ink reset (issue #831 AK5). */
async function resolveColorTokenIn(page: Page, selector: string, token: string): Promise<string> {
  return page.evaluate(
    ({ selector, token }) => {
      const container = document.querySelector(selector)!;
      const probe = document.createElement('span');
      probe.style.color = `var(${token})`;
      container.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    },
    { selector, token },
  );
}

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

/** See grundfarbe.spec.ts's own `toRgb` for why canvas, not a regex on rgb()/oklch(). */
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

async function elementColor(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).color);
}

async function elementBackground(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).backgroundColor);
}

async function htmlBackground(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
}

async function seedTask(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: p }),
    payload,
  );
}

async function seedHabit(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'habits', op: 'upsert', payload: p }),
    payload,
  );
}

test('AK1: Karten stehen als volle Fläche mit tragendem Schatten auf dem Grund', async ({
  page,
}) => {
  await registerPasskey(page);
  const surfaceToken = await resolveColorToken(page, '--surface');

  // SectionCard (device-local, kein Seed nötig) auf /einstellungen.
  await page.goto('/einstellungen');
  const settingsCard = page.locator('.section-card').first();
  await expect(settingsCard).toBeVisible();
  expect(await elementBackground(settingsCard), '.section-card-Fläche').toBe(surfaceToken);
  expect(
    await settingsCard.evaluate((el) => getComputedStyle(el).boxShadow),
    '.section-card trägt einen Schatten',
  ).not.toBe('none');

  // Eigene Karten-Klasse (kein SectionCard) auf /routinen.
  await seedHabit(page, { name: 'AK1-Sonde', schedule: 'daily', color: null, archivedAt: null });
  await page.goto('/routinen');
  const habitCard = page.locator('.habit-list__item').first();
  await expect(habitCard).toBeVisible();
  expect(await elementBackground(habitCard), '.habit-list__item-Fläche').toBe(surfaceToken);
  expect(
    await habitCard.evaluate((el) => getComputedStyle(el).boxShadow),
    '.habit-list__item trägt einen Schatten',
  ).not.toBe('none');
});

test('AK2: die Reiterleiste schwimmt als Pille über dem Grund, der aktive Reiter trägt seine Bereichsfarbe', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/aufgaben');

  const surfaceToken = await resolveColorToken(page, '--surface');
  const groundToken = await resolveColorToken(page, '--ground-aufgaben');
  const areaTasksToken = await resolveColorToken(page, '--area-tasks');

  const navBar = page.locator('.nav__bar');
  await expect(navBar).toBeVisible();
  expect(await elementBackground(navBar), '.nav__bar ist die Pillen-Fläche').toBe(surfaceToken);
  expect(
    await navBar.evaluate((el) => getComputedStyle(el).borderRadius),
    '.nav__bar ist eine Pille',
  ).toBe('999px');
  expect(
    await navBar.evaluate((el) => getComputedStyle(el).boxShadow),
    '.nav__bar schwimmt über dem Grund',
  ).not.toBe('none');

  const navContainer = page.locator('.nav');
  expect(await elementBackground(navContainer), '.nav zeigt den Routen-Grund').toBe(groundToken);

  const activeTab = page
    .getByRole('navigation', { name: 'Hauptnavigation' })
    .getByRole('link', { name: 'Aufgaben' });
  expect(await elementColor(activeTab), 'aktiver Reiter trägt --area-tasks').toBe(areaTasksToken);
});

test('AK3: der schwebende Knopf steht hell auf dem Grund, die Beschriftung in abgedunkelter Bereichsfarbe', async ({
  page,
}) => {
  await registerPasskey(page);

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/aufgaben');

    const onAccent = await resolveColorToken(page, '--on-accent');
    const surfaceToken = await resolveColorToken(page, '--surface');
    const fab = page.getByRole('button', { name: 'Aufgabe erfassen' });
    await expect(fab).toBeVisible();

    const fabBg = await elementBackground(fab);
    expect(fabBg, `FAB-Hintergrund im ${scheme}-Modus ist --surface`).toBe(surfaceToken);

    const glyphColor = await elementColor(fab);
    expect(glyphColor, `Glyph im ${scheme}-Modus ist nicht --on-accent (Umkehrung AK3)`).not.toBe(
      onAccent,
    );
    expect(
      contrastRatio(await toRgb(page, glyphColor), await toRgb(page, fabBg)),
      `Kontrast Glyph/FAB im ${scheme}-Modus`,
    ).toBeGreaterThanOrEqual(4.5);
  }
});

test('AK4: der Home-Balken/die Statuszeile zeigen den Routen-Grund, keine Neutralfläche', async ({
  page,
}) => {
  await registerPasskey(page);

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/aufgaben');

    const groundToken = await htmlBackground(page);
    const surfaceToken = await resolveColorToken(page, '--surface');
    const navContainer = page.locator('.nav');
    const navBg = await elementBackground(navContainer);

    expect(navBg, `.nav-Hintergrund (${scheme}) entspricht dem Routen-Grund`).toBe(groundToken);
    expect(navBg, `.nav-Hintergrund (${scheme}) ist keine Neutralfläche`).not.toBe(surfaceToken);
  }
});

test('AK5: die Pille setzt ihren Ink-Kontext selbst zurück, unabhängig vom Routen-Grund', async ({
  page,
}) => {
  await registerPasskey(page);
  // /routinen: heller Grund, Kontext-Tinte ist --on-accent (dunkel).
  await page.goto('/routinen');

  const textBase = await resolveColorToken(page, '--text-base');
  const textMutedBase = await resolveColorToken(page, '--text-muted-base');
  const onAccent = await resolveColorToken(page, '--on-accent');

  // Ein nicht-aktiver Reiter trägt die feste Karten-Tinte der Pille, nicht die
  // Kontext-Tinte des Grunds darunter.
  const inactiveLink = page
    .getByRole('navigation', { name: 'Hauptnavigation' })
    .getByRole('link', { name: 'Journal' });
  const inactiveColor = await elementColor(inactiveLink);
  expect(inactiveColor, 'nicht-aktiver Reiter trägt --text-muted-base').toBe(textMutedBase);
  expect(inactiveColor, 'nicht-aktiver Reiter trägt nicht die Grund-Tinte').not.toBe(onAccent);

  // issue #831: der Reset wanderte von `.nav` auf `.nav__bar` (die Pille selbst) —
  // eine Sonde direkt in `.nav__bar` muss die Karten-Tinte auflösen, nicht die
  // des umgebenden `.nav`/Grund-Kontexts.
  const navBarText = await resolveColorTokenIn(page, '.nav__bar', '--text');
  expect(navBarText, '.nav__bar löst --text auf --text-base auf').toBe(textBase);
});

test('AK6: bei 375×812 läuft kein Inhalt über den Rand, der schwebende Knopf verdeckt keine Zeile', async ({
  page,
}) => {
  await registerPasskey(page);

  const fabRoutes: Array<{ path: string; fabLabel: string }> = [
    { path: '/aufgaben', fabLabel: 'Aufgabe erfassen' },
    { path: '/kalender', fabLabel: 'Termin erfassen' },
    { path: '/routinen', fabLabel: 'Routine anlegen' },
  ];

  for (const { path, fabLabel } of fabRoutes) {
    await page.goto(path);
    await expect(page.getByRole('button', { name: fabLabel })).toBeVisible();
    const overflow = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      overflow.scrollHeight,
      `${path}: kein vertikaler Überlauf im spärlichen Default-Zustand`,
    ).toBeLessThanOrEqual(overflow.clientHeight);
    expect(overflow.scrollWidth, `${path}: kein horizontaler Überlauf`).toBeLessThanOrEqual(
      overflow.clientWidth,
    );
  }

  // Überlappungsprüfung: genug Aufgaben, dass die Liste bis an den unteren Rand
  // reicht — der schwebende Knopf darf die letzte sichtbare Zeile nicht verdecken.
  await page.goto('/aufgaben');
  for (let i = 0; i < 15; i += 1) {
    await seedTask(page, { title: `AK6-Sonde ${i}`, dueAt: FIXED_NOW });
  }
  await page.reload();
  const fab = page.getByRole('button', { name: 'Aufgabe erfassen' });
  await expect(fab).toBeVisible();
  const lastRow = page.getByRole('list', { name: 'Aufgaben' }).getByRole('listitem').last();
  await lastRow.scrollIntoViewIfNeeded();

  const fabBox = await fab.boundingBox();
  const rowBox = await lastRow.boundingBox();
  expect(fabBox, 'FAB hat eine Bounding-Box').not.toBeNull();
  expect(rowBox, 'letzte Zeile hat eine Bounding-Box').not.toBeNull();
  if (fabBox && rowBox) {
    const overlapsVertically = fabBox.y < rowBox.y + rowBox.height && fabBox.y + fabBox.height > rowBox.y;
    const overlapsHorizontally =
      fabBox.x < rowBox.x + rowBox.width && fabBox.x + fabBox.width > rowBox.x;
    expect(overlapsVertically && overlapsHorizontally, 'FAB überlappt die letzte Zeile nicht').toBe(
      false,
    );
  }
});
