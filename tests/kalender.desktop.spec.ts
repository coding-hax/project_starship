import { expect, test, type Page } from '@playwright/test';
import { installClockAt, registerPasskey, resetAppData } from './helpers';

/**
 * Desktop-only: the two-column layout only applies from 768px up
 * (calendar-view.css, issue #1021, Teil 6 von #1015) — the 375×812 suite
 * (kalender.spec.ts u. a.) is unaffected (AK5), so it stays in its own file
 * instead of a runtime `test.skip`, same pattern as section-card.desktop.spec.ts.
 */

const TODAY = '2026-07-18';

async function seedEvent(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'events', op: 'upsert', payload: p }),
    payload,
  );
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  await installClockAt(page);
  await registerPasskey(page);
  await page.goto('/kalender');
  await page.waitForFunction(() => typeof window.__starship?.mutate === 'function', null, {
    polling: 100,
  });
  await page.getByRole('radio', { name: 'Monat' }).click();
});

/* -------------------------------------------------------------------------- */
/* AK1: Monatsraster links, Tagesagenda rechts, ab 768px                      */
/* -------------------------------------------------------------------------- */

test('das Monatsraster steht links, die Tagesagenda rechts daneben (issue #1021 AK1)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Zweispalter-Termin',
    allDay: false,
    startsAt: `${TODAY}T09:00:00.000Z`,
    endsAt: `${TODAY}T10:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });

  const monthGrid = page.locator('.month-grid');
  const agenda = page.locator('.event-agenda');
  await expect(monthGrid).toBeVisible();
  await expect(agenda).toBeVisible();

  const [gridBox, agendaBox] = await Promise.all([monthGrid.boundingBox(), agenda.boundingBox()]);
  if (!gridBox || !agendaBox) throw new Error('AK1: Raster oder Agenda ohne BoundingBox');

  // Nebeneinander, nicht untereinander.
  expect(gridBox.x + gridBox.width).toBeLessThanOrEqual(agendaBox.x);
  // In derselben Zeile — ein senkrechter Überlapp beweist, dass beide Spalten sind.
  const sameRow = gridBox.y < agendaBox.y + agendaBox.height && agendaBox.y < gridBox.y + gridBox.height;
  expect(sameRow).toBe(true);
});

test('das Monatsraster wird nicht auf die Spaltenhöhe gestreckt (issue #1021 AK1)', async ({ page }) => {
  const monthGrid = page.locator('.month-grid');
  await expect(monthGrid).toBeVisible();

  expect(await monthGrid.evaluate((el) => getComputedStyle(el).alignSelf)).toBe('start');

  const [gridBox, viewBox] = await Promise.all([
    monthGrid.boundingBox(),
    page.locator('.calendar-view').boundingBox(),
  ]);
  if (!gridBox || !viewBox) throw new Error('AK1: Raster oder Ansicht ohne BoundingBox');
  // Die Karte trägt heute nur Punkte je Tag und bliebe gestreckt fast leer —
  // ihre eigene Höhe muss deutlich unter der der ganzen Ansicht liegen.
  expect(gridBox.height).toBeLessThan(viewBox.height * 0.9);
});
