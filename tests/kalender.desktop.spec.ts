import { expect, test, type Locator, type Page } from '@playwright/test';
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

/** Text-node-tight bounding box (not the h1's own, flex-grown box) — mirrors
 *  kalender.spec.ts's own textBoundingBox, same reason (issue #921 AK4): the
 *  heading's box fills whatever width `flex` gives it, so its own edge would
 *  always sit flush next to the figure regardless of how short the text is. */
async function textBoundingBox(locator: Locator): Promise<{ x: number; right: number }> {
  return locator.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, right: rect.right };
  });
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

/* -------------------------------------------------------------------------- */
/* AK2: Figur neben dem Titelwort, ab 768px                                   */
/* -------------------------------------------------------------------------- */

test('die Figur sitzt ab 768px dicht neben dem Titelwort, nicht am rechten Rand (issue #1021 AK2)', async ({
  page,
}) => {
  const heading = page.locator('.calendar-view__heading');
  const face = page.locator('.calendar-view__title-row .face');
  await expect(heading).toBeVisible();
  await expect(face).toBeVisible();

  const [titleBox, faceBox, viewBox] = await Promise.all([
    textBoundingBox(heading),
    face.boundingBox(),
    page.locator('.calendar-view').boundingBox(),
  ]);
  if (!faceBox || !viewBox) throw new Error('AK2: Figur oder Ansicht ohne BoundingBox');

  const gapToTitle = faceBox.x - titleBox.right;
  const gapToRightEdge = viewBox.x + viewBox.width - (faceBox.x + faceBox.width);
  // Die Figur sitzt dicht am sichtbaren Textende — nicht mit einem großen
  // Zwischenraum, der sie stattdessen an den rechten Ansichtsrand rückte
  // (die Desktop-Umkehr von #921 AK4, das bei 375×812 unverändert grün bleibt).
  expect(gapToTitle).toBeLessThan(gapToRightEdge);
  expect(gapToTitle).toBeLessThan(48);
});

/* -------------------------------------------------------------------------- */
/* AK3: Bodenreserve gegen den schwebenden Erfassen-Knopf, ab 768px           */
/* -------------------------------------------------------------------------- */

test('der schwebende Erfassen-Knopf verdeckt bei einer langen Terminliste kein Element (issue #1021 AK3)', async ({
  page,
}) => {
  for (let hour = 0; hour < 20; hour += 1) {
    const h = String(hour).padStart(2, '0');
    await seedEvent(page, {
      title: `Termin ${hour}`,
      allDay: false,
      startsAt: `${TODAY}T${h}:00:00.000Z`,
      endsAt: `${TODAY}T${h}:30:00.000Z`,
      startDate: null,
      endDate: null,
      category: null,
    });
  }

  const lastItem = page.locator('.event-agenda__item').last();
  await lastItem.scrollIntoViewIfNeeded();
  await expect(lastItem).toBeVisible();

  const fab = page.locator('.fab');
  const [fabBox, itemBox] = await Promise.all([fab.boundingBox(), lastItem.boundingBox()]);
  if (!fabBox || !itemBox) throw new Error('AK3: Fab oder letztes Agenda-Element ohne BoundingBox');

  expect(itemBox.y + itemBox.height).toBeLessThanOrEqual(fabBox.y);
});
