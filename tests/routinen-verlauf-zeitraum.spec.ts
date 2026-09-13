import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, skewClock } from './helpers';

/**
 * Issue #1184 (Phase B) — der Zeitraum der Verlaufskarte ist unter
 * `/einstellungen` wählbar (AK9), wirkt sofort und bleibt gerätelokal
 * erhalten (AK10), die Zellmaße skalieren mit dem Zeitraum (AK8).
 */

const NOW = '2026-07-15T12:00:00.000Z';
const TODAY = '2026-07-15';

const RANGE_KEY = 'starship:habit-history-range';

async function seedHabit(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) =>
      window.__starship.mutate({
        table: 'habits',
        op: 'upsert',
        payload: { schedule: 'daily', color: null, archivedAt: null, ...p },
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
  await skewClock(page, NOW);
});

/* -------------------------------------------------------------------------- */
/* AK9: Einstellungen — Karte "Routinen", Zeile "Verlauf", fünf Werte         */
/* -------------------------------------------------------------------------- */

test('AK9: /einstellungen zeigt in der Gruppe "Module" die Karte "Routinen" mit fünf Werten in Reihenfolge, Vorgabe "30 Tage"', async ({
  page,
}) => {
  await registerPasskey(page, '/einstellungen');

  const moduleGroup = page
    .locator('.einstellungen__group')
    .filter({ has: page.getByRole('heading', { name: 'Module' }) });
  // Die Karten-Überschrift ist ein <h2> ("Routinen") — unterscheidet sie vom
  // gleichnamigen Modul-Schalter-Label im ModulePanel darunter, das kein
  // Heading ist.
  await expect(moduleGroup.getByRole('heading', { name: 'Routinen' })).toBeVisible();
  await expect(moduleGroup.getByText('Verlauf')).toBeVisible();

  const slider = page.getByRole('slider', { name: 'Verlauf' });
  await expect(slider).toHaveAttribute('aria-valuetext', '30 Tage');
  await expect(slider).toHaveAttribute('min', '0');
  await expect(slider).toHaveAttribute('max', '4');

  await slider.focus();
  for (const label of ['30 Tage', '4 Wochen', '3 Wochen', '2 Wochen', '1 Woche']) {
    await expect(slider).toHaveAttribute('aria-valuetext', label);
    await page.keyboard.press('ArrowRight');
  }
  // Am Ende (Index 4) bewegt eine weitere ArrowRight nichts mehr.
  await expect(slider).toHaveAttribute('aria-valuetext', '1 Woche');
});

test('AK9: die Karte "Routinen" fehlt unter /einstellungen, wenn das Modul Routinen abgeschaltet ist', async ({
  page,
}) => {
  await registerPasskey(page, '/einstellungen');
  await expect(page.getByRole('slider', { name: 'Verlauf' })).toBeVisible();

  // Der Modul-Schalter selbst bleibt sichtbar (er schaltet ja wieder ein) —
  // nur die "Verlauf"-Karte mit ihrem Slider verschwindet.
  await page.getByRole('switch', { name: 'Routinen' }).click();

  await expect(page.getByRole('slider', { name: 'Verlauf' })).toHaveCount(0);
  await expect(page.getByText('Verlauf', { exact: true })).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* AK10: wirkt sofort, bleibt nach Reload erhalten, kein Outbox-Eintrag       */
/* -------------------------------------------------------------------------- */

test('AK10: "2 Wochen" wählen wirkt sofort auf /routinen (Etikett + Zellbreite), bleibt nach Reload erhalten, erzeugt keinen Outbox-Eintrag', async ({
  page,
}) => {
  await registerPasskey(page, '/routinen');
  const habitId = await seedHabit(page, { name: 'Wahl-Sonde' });
  await seedHabitLog(page, habitId, TODAY);
  await page.goto('/routinen');
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  await page.goto('/einstellungen');
  const slider = page.getByRole('slider', { name: 'Verlauf' });
  await slider.focus();
  await page.keyboard.press('ArrowRight'); // 30 Tage → 4 Wochen
  await page.keyboard.press('ArrowRight'); // 4 Wochen → 3 Wochen
  await page.keyboard.press('ArrowRight'); // 3 Wochen → 2 Wochen
  await expect(slider).toHaveAttribute('aria-valuetext', '2 Wochen');

  // Die Wahl selbst erzeugt keinen Outbox-Eintrag (gerätelokal, ADR-0006).
  expect(await page.evaluate(() => window.__starship.size())).toBe(0);

  await page.goto('/routinen');
  await expect(page.locator('.habit-history-card').getByText('Erledigt · 2 Wochen')).toBeVisible();
  const cell = await page.locator('.habit-history-card__cell').first().boundingBox();
  expect(cell, 'Zelle hat eine Fläche').not.toBeNull();
  if (!cell) return;
  expect(cell.width, 'Zellbreite 21,9px ± 0,3px bei 2 Wochen').toBeGreaterThanOrEqual(21.6);
  expect(cell.width, 'Zellbreite 21,9px ± 0,3px bei 2 Wochen').toBeLessThanOrEqual(22.2);

  await page.reload();
  await expect(page.locator('.habit-history-card').getByText('Erledigt · 2 Wochen')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* AK8: Zellmaß je Zeitraum, Emoji nicht abgeschnitten, quadratisches Raster  */
/* -------------------------------------------------------------------------- */

const RANGES = [
  { days: 30, label: '30 Tage', cellPx: 10.1 },
  { days: 28, label: '4 Wochen', cellPx: 10.8 },
  { days: 21, label: '3 Wochen', cellPx: 14.5 },
  { days: 14, label: '2 Wochen', cellPx: 21.9 },
  { days: 7, label: '1 Woche', cellPx: 44.1 },
];

for (const range of RANGES) {
  test(`AK8: bei "${range.label}" misst eine Zelle ${range.cellPx}px ± 0,3px, quadratisch, Emoji nicht abgeschnitten`, async ({
    page,
  }) => {
    await registerPasskey(page, '/routinen');
    const habitId = await seedHabit(page, { name: 'Mass-Sonde', emoji: '🏃' });
    await seedHabitLog(page, habitId, TODAY);
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key, value),
      [RANGE_KEY, String(range.days)],
    );
    await page.goto('/routinen');

    await expect(page.locator('.habit-history-card').getByText(`Erledigt · ${range.label}`)).toBeVisible();

    const filledCell = page
      .locator('.habit-history-card__cell')
      .filter({ has: page.locator('.habit-history-card__emoji') });
    // `locator.boundingBox()` has no retry of its own (default `timeout: 0`,
    // unlike `expect()`'s polling) — it takes a single, immediate measurement.
    // The grid still commits a second time right after this card's first paint
    // (`useSyncExternalStore`'s server-snapshot-vs-localStorage correction, see
    // `habit-history-card.tsx`), so without an explicit wait here this could
    // race that second commit and measure mid-flight. Wait for the cell itself
    // before measuring it, the same way the label assertion above already
    // waits for the corrected render.
    await expect(filledCell).toBeVisible();
    const [cellBox, emojiBox] = await Promise.all([
      filledCell.boundingBox(),
      filledCell.locator('.habit-history-card__emoji').boundingBox(),
    ]);
    expect(cellBox, 'Zelle hat eine Fläche').not.toBeNull();
    expect(emojiBox, 'Emoji hat eine Fläche').not.toBeNull();
    if (!cellBox || !emojiBox) return;

    expect(cellBox.width, `Zellbreite ${range.cellPx}px ± 0,3px`).toBeGreaterThanOrEqual(range.cellPx - 0.3);
    expect(cellBox.width, `Zellbreite ${range.cellPx}px ± 0,3px`).toBeLessThanOrEqual(range.cellPx + 0.3);
    expect(
      Math.abs(cellBox.width - cellBox.height),
      `Zelle ist quadratisch (${cellBox.width} x ${cellBox.height})`,
    ).toBeLessThanOrEqual(0.5);
    expect(emojiBox.width, 'Emoji nicht breiter als die Zelle').toBeLessThanOrEqual(cellBox.width);
  });
}
