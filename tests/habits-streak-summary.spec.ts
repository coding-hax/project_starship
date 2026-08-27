import { expect, test, type Locator, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, skewClock } from './helpers';

/**
 * Statusblock auf /routinen (issue #863, löst die "Routinen in Serie"-Karte
 * aus #809 ab): drei Ringe, ein Satz, eine Tabelle. Umgeschrieben von der
 * alten Ein-Zahl-Kartenspec — Testzahl darf nie sinken (CLAUDE.md), sie wächst
 * hier von 11 auf mehr, weil jetzt mehr Fläche zu prüfen ist.
 */

// A Wednesday — same reference date as streak.test.ts. The running week is
// 2026-07-13..2026-07-19 (Mon–Sun), the running month is July 2026.
const NOW = '2026-07-15T12:00:00.000Z';
const TODAY = '2026-07-15';

function card(page: Page) {
  return page.locator('.streak-summary-card');
}

function legendItem(page: Page, ring: 'heute' | 'woche' | 'serie') {
  return card(page).locator(`li[data-ring="${ring}"]`);
}

function ringFill(page: Page, ring: 'heute' | 'woche' | 'serie') {
  return card(page).locator(`circle[data-ring="${ring}"]`);
}

async function seedHabit(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) =>
      window.__starship.mutate({
        table: 'habits',
        op: 'upsert',
        payload: { name: 'x', schedule: 'daily', color: null, archivedAt: null, ...p },
      }),
    payload,
  );
}

async function seedHabitLog(page: Page, habitId: string, logDate: string, done = true): Promise<void> {
  await page.evaluate(
    ({ habitId, logDate, done }) =>
      window.__starship.mutate({
        table: 'habit_logs',
        op: 'upsert',
        payload: { habitId, logDate, done },
      }),
    { habitId, logDate, done },
  );
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await registerPasskey(page);
  await skewClock(page, NOW);
  // Umgezogen von /uebersicht auf /routinen (issue #652) — der Block sitzt bei
  // der Verwaltung statt auf der täglichen Übersicht.
  await page.goto('/routinen');
});

/* -------------------------------------------------------------------------- */
/* AK1: Statusblock ersetzt die alte Ein-Zahl-Karte                           */
/* -------------------------------------------------------------------------- */

test('AK1: der Statusblock erscheint mit Ringen und Tabelle, sobald es eine aktive Routine gibt', async ({
  page,
}) => {
  await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });

  await expect(card(page)).toBeVisible();
  await expect(card(page).locator('svg circle[data-ring]')).toHaveCount(3);
  await expect(card(page).locator('table')).toBeVisible();
  // Die alte Ein-Zahl-Kennzahl ist als eigenständiges Element weg.
  await expect(card(page).locator('.streak-summary-card__metric')).toHaveCount(0);
});

test('AK1: die alte Kennzahl "Routinen in Serie" lebt als letzte Tabellenzeile weiter, zählt nur laufende Serien', async ({
  page,
}) => {
  const withStreak = await seedHabit(page, {
    name: 'Wasser trinken',
    schedule: 'daily',
    createdAt: '2026-06-01T00:00:00.000Z',
  });
  const weeklyWithStreak = await seedHabit(page, {
    name: 'Großeinkauf',
    schedule: 'weekly',
    createdAt: '2026-06-02T00:00:00.000Z',
  });
  await seedHabit(page, {
    name: 'Meditieren',
    schedule: 'daily',
    createdAt: '2026-06-03T00:00:00.000Z',
  }); // ohne jeden Log -> keine Serie

  await seedHabitLog(page, withStreak, TODAY);
  await seedHabitLog(page, weeklyWithStreak, '2026-07-14'); // diese Woche

  await expect(card(page).locator('tfoot')).toContainText('Routinen in Serie — 2 von 3 aktiv');
});

test('AK1: eine archivierte Routine mit laufender Serie zählt in der Fußzeile nicht mit', async ({
  page,
}) => {
  const archived = await seedHabit(page, {
    createdAt: '2026-06-01T00:00:00.000Z',
    archivedAt: '2026-07-14T00:00:00.000Z',
  });
  await seedHabitLog(page, archived, TODAY);
  // Eine zweite, aktive Routine ohne Serie hält den Block sichtbar.
  await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });

  await expect(card(page).locator('tfoot')).toContainText('Routinen in Serie — 0 von 1 aktiv');
});

/* -------------------------------------------------------------------------- */
/* AK6: kein Block ohne aktive Routine                                        */
/* -------------------------------------------------------------------------- */

test('AK6: ohne jede Routine erscheint der Block nicht', async ({ page }) => {
  await expect(card(page)).toHaveCount(0);
});

test('AK6: nur archivierte Routinen lassen den Block ebenfalls weg', async ({ page }) => {
  await seedHabit(page, {
    createdAt: '2026-06-01T00:00:00.000Z',
    archivedAt: '2026-07-01T00:00:00.000Z',
  });

  await expect(card(page)).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* Rein aus IndexedDB, offline                                                */
/* -------------------------------------------------------------------------- */

test('der Block berechnet sich vollständig offline aus IndexedDB', async ({ page, context }) => {
  await context.setOffline(true);

  const habitId = await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });
  await seedHabitLog(page, habitId, TODAY);

  await expect(card(page).locator('tfoot')).toContainText('Routinen in Serie — 1 von 1 aktiv');
});

/* -------------------------------------------------------------------------- */
/* AK2: jeder Ringwert steht zusätzlich als Text in der Legende               */
/* -------------------------------------------------------------------------- */

test('AK2: der äußere Ring "Heute" zeigt Zähler und Nenner als Text in der Legende', async ({
  page,
}) => {
  const done = await seedHabit(page, { name: 'A', createdAt: '2026-06-01T00:00:00.000Z' });
  await seedHabit(page, { name: 'B', createdAt: '2026-06-02T00:00:00.000Z' }); // heute noch offen
  await seedHabitLog(page, done, TODAY);

  const legend = legendItem(page, 'heute');
  await expect(legend.locator('.streak-summary-card__legend-value')).toContainText('1');
  await expect(legend.locator('.streak-summary-card__legend-denom')).toHaveText('/ 2');
});

test('AK2: der mittlere Ring "Diese Woche" zeigt Zähler und Nenner als Text in der Legende', async ({
  page,
}) => {
  const habitId = await seedHabit(page, { schedule: 'daily', createdAt: '2026-06-01T00:00:00.000Z' });
  await seedHabitLog(page, habitId, '2026-07-13');
  await seedHabitLog(page, habitId, '2026-07-14');
  await seedHabitLog(page, habitId, TODAY);

  const legend = legendItem(page, 'woche');
  await expect(legend.locator('.streak-summary-card__legend-value')).toContainText('3');
  await expect(legend.locator('.streak-summary-card__legend-denom')).toHaveText('/ 7');
});

test('AK2: der innere Ring "Längste Serie" zeigt den Streak-Wert mit Einheit, ohne Nenner', async ({
  page,
}) => {
  const habitId = await seedHabit(page, { schedule: 'daily', createdAt: '2026-06-01T00:00:00.000Z' });
  await seedHabitLog(page, habitId, '2026-07-13');
  await seedHabitLog(page, habitId, '2026-07-14');
  await seedHabitLog(page, habitId, TODAY);

  const legend = legendItem(page, 'serie');
  await expect(legend.locator('.streak-summary-card__legend-value')).toContainText('3 Tage');
  await expect(legend.locator('.streak-summary-card__legend-denom')).toHaveCount(0);
});

test('die Legendenwerte nutzen tabular-nums', async ({ page }) => {
  const habitId = await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });
  await seedHabitLog(page, habitId, TODAY);

  await expect(legendItem(page, 'heute').locator('.streak-summary-card__legend-value')).toHaveCSS(
    'font-variant-numeric',
    'tabular-nums',
  );
});

/* -------------------------------------------------------------------------- */
/* AK4: Tabelle mit Routine · 12 Wochen · Serie                               */
/* -------------------------------------------------------------------------- */

test('AK4: die Tabelle zeigt je Zeile Name, Serie/Periodenstand und 12 Balken', async ({ page }) => {
  const daily = await seedHabit(page, {
    name: 'Wasser trinken',
    schedule: 'daily',
    createdAt: '2026-06-01T00:00:00.000Z',
  });
  await seedHabitLog(page, daily, '2026-07-13');
  await seedHabitLog(page, daily, '2026-07-14');
  await seedHabitLog(page, daily, TODAY); // 3 Tage laufende Serie

  const weekly = await seedHabit(page, {
    name: 'Großeinkauf',
    schedule: 'weekly',
    target: 3,
    createdAt: '2026-06-02T00:00:00.000Z',
  });
  await seedHabitLog(page, weekly, '2026-07-13');
  await seedHabitLog(page, weekly, '2026-07-14'); // 2 von 3 diese Woche

  const dailyRow = card(page).locator('tbody tr').filter({ hasText: 'Wasser trinken' });
  await expect(dailyRow.locator('.streak-summary-card__serie')).toHaveText('3');
  await expect(dailyRow.locator('.streak-summary-card__bar')).toHaveCount(12);

  const weeklyRow = card(page).locator('tbody tr').filter({ hasText: 'Großeinkauf' });
  await expect(weeklyRow.locator('.streak-summary-card__serie')).toHaveText('2/3');
  await expect(weeklyRow.locator('.streak-summary-card__bar')).toHaveCount(12);
});

/* -------------------------------------------------------------------------- */
/* AK3: Kontrast gemessen, nicht geraten — hell und dunkel                    */
/* -------------------------------------------------------------------------- */

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

/** Resolves any computed CSS colour string (rgb()/oklch()/color-mix() …) to sRGB bytes via canvas. */
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

async function strokeColor(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).stroke);
}

async function textColor(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).color);
}

async function backgroundColor(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).backgroundColor);
}

test('AK3: jede Ringfüllung erreicht mindestens 3:1 gegen die eigene Spur, hell und dunkel', async ({
  page,
}) => {
  const habitId = await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });
  await seedHabitLog(page, habitId, TODAY);

  const trackRgb = await toRgb(page, await strokeColor(card(page).locator('.streak-summary-card__ring-track').first()));

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const ring of ['heute', 'woche', 'serie'] as const) {
      const fillRgb = await toRgb(page, await strokeColor(ringFill(page, ring)));
      expect(contrastRatio(fillRgb, trackRgb), `${ring} (${scheme})`).toBeGreaterThanOrEqual(3);
    }
  }
});

test('AK3: jede Legendenbeschriftung erreicht mindestens 4,5:1 gegen die Fläche, hell und dunkel', async ({
  page,
}) => {
  const habitId = await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });
  await seedHabitLog(page, habitId, TODAY);

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const panelRgb = await toRgb(page, await backgroundColor(card(page)));

    for (const ring of ['heute', 'woche', 'serie'] as const) {
      const legend = legendItem(page, ring);
      const labelRgb = await toRgb(page, await textColor(legend.locator('.streak-summary-card__legend-label')));
      const valueRgb = await toRgb(page, await textColor(legend.locator('.streak-summary-card__legend-value')));
      expect(contrastRatio(labelRgb, panelRgb), `${ring} label (${scheme})`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(valueRgb, panelRgb), `${ring} value (${scheme})`).toBeGreaterThanOrEqual(4.5);
    }

    const sentenceRgb = await toRgb(page, await textColor(card(page).locator('.streak-summary-card__sentence')));
    expect(contrastRatio(sentenceRgb, panelRgb), `sentence (${scheme})`).toBeGreaterThanOrEqual(4.5);
  }
});

test('die eigene dunkle Fläche bleibt in hell und dunkel identisch (issue #863 "Offen 1")', async ({
  page,
}) => {
  await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });

  await page.emulateMedia({ colorScheme: 'light' });
  const lightBg = await backgroundColor(card(page));
  const lightInk = await textColor(card(page).locator('.streak-summary-card__legend-value').first());

  await page.emulateMedia({ colorScheme: 'dark' });
  const darkBg = await backgroundColor(card(page));
  const darkInk = await textColor(card(page).locator('.streak-summary-card__legend-value').first());

  expect(darkBg).toBe(lightBg);
  expect(darkInk).toBe(lightInk);
});

/* -------------------------------------------------------------------------- */
/* AK6: 375px ohne Überlauf, Verwaltungsliste per Scroll erreichbar           */
/* -------------------------------------------------------------------------- */

test('AK6: bei 375px läuft nichts über den Rand, die Verwaltungsliste ist per Scroll erreichbar', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const habitId = await seedHabit(page, { name: 'Ein ziemlich langer Routinen-Name', createdAt: '2026-06-01T00:00:00.000Z' });
  await seedHabitLog(page, habitId, TODAY);

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);

  const habitList = page.getByRole('list', { name: 'Routinen' });
  await habitList.scrollIntoViewIfNeeded();
  await expect(habitList).toBeVisible();
});

for (const viewport of [
  { width: 375, height: 667 },
  { width: 1280, height: 800 },
]) {
  test(`der Block ist bei ${viewport.width}px sichtbar`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const habitId = await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });
    await seedHabitLog(page, habitId, TODAY);

    await expect(card(page)).toBeVisible();
  });
}

/* -------------------------------------------------------------------------- */
/* AK8: prefers-reduced-motion                                                */
/* -------------------------------------------------------------------------- */

test('AK8: die Ringfüllung transitioniert nicht, auch nicht mit prefers-reduced-motion', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const habitId = await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });
  await seedHabitLog(page, habitId, TODAY);

  await expect(ringFill(page, 'heute')).toHaveCSS('transition-duration', '0s');
});
