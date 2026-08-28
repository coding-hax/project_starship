import { expect, test, type Page } from '@playwright/test';
import { FIXED_NOW, installClockAt, registerPasskey, resetAppData, withDb } from './helpers';

/**
 * Kartenrhythmus der Aufgabenliste (issue #866, T2 von #860). Eine Gruppe ist
 * eine Karte (`--radius-surface`, `--shadow-raised`) statt einer flachen Zeile
 * mit Hairline (issue #704 umgekehrt); die "Woche"-Ansicht bündelt in drei
 * feste Buckets — "Überfällig" / "Heute" / "Diese Woche" — statt einer Marke
 * je Tag (Variante A). Regressionen (Drag-to-Nest, Presence, …) bleiben
 * tasks.spec.ts/uebersicht.spec.ts — hier nur, was an der Karte selbst neu ist.
 */

const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';
const GARMIN_SYNC_PATTERN = '**/api/garmin-sync';

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // The list must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  // /uebersicht fetches weather and pokes Garmin sync on load (see
  // grundfarbe-vollfarbe.spec.ts's own beforeEach) — mocked so the AK-Ü tests
  // below can visit it without leaking a real network call.
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
  await registerPasskey(page);
});

async function seedTask(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: p }),
    payload,
  );
}

/** `FIXED_NOW` shifted by whole local-calendar days, at a fixed local clock
 *  time — mirrors tasks.spec.ts's own helper of the same name. */
function isoAt(daysFromNow: number, hours = 9): string {
  const date = new Date(FIXED_NOW);
  date.setDate(date.getDate() + daysFromNow);
  date.setHours(hours, 0, 0, 0);
  return date.toISOString();
}

/** Scoped to the task list — a page-wide listitem query also matches the nav tabs. */
function taskItems(page: Page) {
  return page.getByRole('list', { name: 'Aufgaben' }).getByRole('listitem');
}

function groupCards(page: Page) {
  return page.locator('.task-list__group-card');
}

function groupTitles(page: Page) {
  return page.locator('.task-list__group-title');
}

/** Mirrors grundfarbe.spec.ts's/grundfarbe-vollfarbe.spec.ts's own probe-span technique. */
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

/** Same idea, for `border-radius`/`box-shadow`/`padding` — resolves a token to
 *  its computed value without hardcoding the px/shadow literal in the assertion. */
async function resolveToken(page: Page, property: string, token: string): Promise<string> {
  return page.evaluate(
    ({ property, token }) => {
      const probe = document.createElement('span');
      probe.style.setProperty(property, `var(${token})`);
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).getPropertyValue(property);
      probe.remove();
      return value;
    },
    { property, token },
  );
}

/** Same probe technique as `resolveColorToken`, but the probe is a child of
 *  `selector` — resolves the custom property from that element's own cascade
 *  context (mirrors grundfarbe-vollfarbe.spec.ts's `resolveColorTokenIn`, issue #831). */
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

test('AK1: eine Gruppe ist eine Karte — Fläche, Radius, Schatten, Polsterung; die Zeile darin trägt keine eigene Fläche', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Überfällig-Sonde', dueAt: isoAt(-1) });
  await seedTask(page, { title: 'Heute-Sonde', dueAt: isoAt(0, 9) });
  await seedTask(page, { title: 'Woche-Sonde', dueAt: isoAt(2) });

  const cards = groupCards(page);
  await expect(cards).toHaveCount(3);

  const surfaceToken = await resolveColorToken(page, '--surface');
  const radiusToken = await resolveToken(page, 'border-radius', '--radius-surface');
  const shadowToken = await resolveToken(page, 'box-shadow', '--shadow-raised');
  // Longhand, not the `padding` shorthand — `getComputedStyle` only normalizes
  // that reliably back to a string for longhands like `padding-top`.
  const paddingToken = await resolveToken(page, 'padding-top', '--space-4');

  const card = cards.first();
  expect(await card.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(surfaceToken);
  expect(await card.evaluate((el) => getComputedStyle(el).borderRadius)).toBe(radiusToken);
  expect(await card.evaluate((el) => getComputedStyle(el).boxShadow)).toBe(shadowToken);
  expect(await card.evaluate((el) => getComputedStyle(el).paddingTop)).toBe(paddingToken);

  // Die Zeile selbst trägt weder Radius noch Schatten — nur die Karte (AK1).
  const row = taskItems(page).first();
  expect(await row.evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none');
  expect(await row.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('0px');

  // Abstand zwischen zwei Karten = --space-3.
  const gapToken = await resolveToken(page, 'margin-top', '--space-3');
  const gapPx = parseFloat(gapToken);
  const firstBox = await cards.nth(0).boundingBox();
  const secondBox = await cards.nth(1).boundingBox();
  if (!firstBox || !secondBox) throw new Error('missing bounding box');
  expect(Math.abs(secondBox.y - (firstBox.y + firstBox.height) - gapPx)).toBeLessThan(1);
});

test('AK1: mehrere an verschiedenen Wochentagen fällige Aufgaben landen in einer "Diese Woche"-Karte, Anzahl rechts = Top-Level-Zeilen', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');
  const parentId = await seedTask(page, { title: 'Übermorgen-Eltern', dueAt: isoAt(2) });
  await seedTask(page, { title: 'Übermorgen-Kind', parentId });
  await seedTask(page, { title: 'In 5 Tagen', dueAt: isoAt(5) });

  await expect(groupTitles(page)).toHaveCount(1);
  await expect(groupTitles(page).first()).toHaveText('Diese Woche');

  // Anzahl = Top-Level-Zeilen (2), nicht inklusive der Unteraufgabe.
  const count = page.locator('.task-list__group-count').first();
  await expect(count).toHaveText('2');
});

test('AK2: eine leer werdende Gruppe verschwindet als eigene Karte, die übrigen bleiben unberührt', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Überfällig bleibt', dueAt: isoAt(-1) });
  const todayId = await seedTask(page, { title: 'Heute-Sonde', dueAt: isoAt(0, 9) });
  await seedTask(page, { title: 'Woche bleibt', dueAt: isoAt(2) });

  await expect(groupTitles(page)).toHaveCount(3);

  await page.evaluate(
    (rowId) => window.__starship.mutate({ table: 'tasks', rowId, op: 'delete' }),
    todayId,
  );

  await expect(groupTitles(page)).toHaveCount(2);
  await expect(groupTitles(page).nth(0)).toHaveText('Überfällig');
  await expect(groupTitles(page).nth(1)).toHaveText('Diese Woche');
});

test('AK2 (Locator-Erhalt): die Zeile bleibt unter der einen "Aufgaben"-Liste erreichbar, die Karte selbst zählt nicht als listitem', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Locator-Sonde', dueAt: FIXED_NOW });

  const list = page.getByRole('list', { name: 'Aufgaben' });
  await expect(list.getByRole('listitem')).toHaveCount(1);

  const card = groupCards(page).first();
  await expect(card).toHaveAttribute('role', 'presentation');
  await expect(card.getByRole('listitem')).toHaveCount(1);

  const row = list.getByRole('listitem').first();
  expect(await row.evaluate((el) => el.closest('.task-list__group-card') !== null)).toBe(true);
});

test('AK-Ü: kein Überlauf auf /aufgaben und /uebersicht, Hell und Dunkel', async ({ page }) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'AK-Ü Überfällig', dueAt: isoAt(-1) });
  await seedTask(page, { title: 'AK-Ü Heute', dueAt: isoAt(0, 9) });
  await seedTask(page, { title: 'AK-Ü Woche', dueAt: isoAt(2) });

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const path of ['/aufgaben', '/uebersicht']) {
      await page.goto(path);
      await expect(groupCards(page).first()).toBeVisible();
      const overflow = await page.evaluate(() => ({
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(
        overflow.scrollHeight,
        `${path} (${scheme}): kein vertikaler Überlauf`,
      ).toBeLessThanOrEqual(overflow.clientHeight);
      expect(overflow.scrollWidth, `${path} (${scheme}): kein horizontaler Überlauf`).toBeLessThanOrEqual(
        overflow.clientWidth,
      );
    }
  }
});

test('AK-Ü: die Karte setzt ihren Ink zurück — Zeilentext ≠ Kartengrund, Kontrast ≥ 4,5:1, Hell und Dunkel', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/aufgaben');
    await seedTask(page, { title: `Ink-Sonde ${scheme}`, dueAt: isoAt(0, 9) });
    await expect(groupCards(page).first()).toBeVisible();

    const textBase = await resolveColorToken(page, '--text-base');
    const cardText = await resolveColorTokenIn(page, '.task-list__group-card', '--text');
    expect(cardText, `.task-list__group-card löst --text auf --text-base auf (${scheme})`).toBe(
      textBase,
    );

    const card = groupCards(page).first();
    const cardBackground = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
    const rowTitle = page.getByText(`Ink-Sonde ${scheme}`);
    const rowColor = await rowTitle.evaluate((el) => getComputedStyle(el).color);
    expect(rowColor, `Zeilentext ≠ Kartengrund (${scheme})`).not.toBe(cardBackground);
    expect(
      contrastRatio(await toRgb(page, rowColor), await toRgb(page, cardBackground)),
      `Kontrast Zeilentext/Kartenfläche (${scheme})`,
    ).toBeGreaterThanOrEqual(4.5);
  }
});

test('Offline-Pfad: eine offline angelegte Aufgabe erscheint sofort in ihrer Gruppen-Karte, erreicht online die Datenbank', async ({
  page,
  context,
}) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');
  await context.setOffline(true);

  await seedTask(page, { title: 'Offline Kartensonde', dueAt: isoAt(0, 9) });

  await expect(groupTitles(page).filter({ hasText: 'Heute' })).toBeVisible();
  const row = taskItems(page).filter({ hasText: 'Offline Kartensonde' });
  await expect(row).toBeVisible();
  expect(await row.evaluate((el) => el.closest('.task-list__group-card') !== null)).toBe(true);

  await page.unroute('**/api/sync/**');
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const rows = await withDb((client) =>
    client.query('SELECT title FROM tasks WHERE title = $1', ['Offline Kartensonde']),
  );
  expect(rows.rows.map((r) => r.title)).toEqual(['Offline Kartensonde']);
});
