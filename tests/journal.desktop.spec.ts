import { expect, test, type Locator, type Page } from '@playwright/test';
import { FIXED_NOW, installClockAt, registerPasskey, resetAppData } from './helpers';

/**
 * Desktop-only journal furniture that survives the day-card rework (#1048).
 * The AK1/AK2/AK4 two-column-flow tests that used to live here (issue #1023,
 * Teil 8 von #1015 — `.journal-editor__day-group`, `columns: 2`) are gone: the
 * entry stream they measured no longer exists, replaced by the single day-card
 * surface. Epic #1046, section "Was dabei mitstirbt": that column flow is
 * explicitly retired with the stream and gets replaced by a dedicated desktop
 * ticket once one exists, not restored here. What remains — AK3, the figure's
 * position next to the title — is unrelated to the stream and still applies.
 *
 * issue #1052 (Nachfolger dieses zurückgestellten Zwei-Bahnen-Flusses) fügt
 * die AK1/AK2/AK3/AK4-Tests unten neu hinzu — Raster + „Zuletzt geschrieben"
 * statt der alten `columns: 2`-Tagesgruppen.
 */

const PASSPHRASE = 'desktop journal passphrase';

/** Same setup flow as journal-suche.spec.ts's setUpEditor. */
async function setUpEditor(page: Page): Promise<void> {
  await registerPasskey(page, '/journal');
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByLabel('Passphrase wiederholen').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Einrichten' }).click();
  await page.getByTestId('journal-recovery-key').waitFor();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();
}

/** Text-node-tight bounding box (not the h1's own, flex-grown box) — mirrors
 *  kalender.desktop.spec.ts's textBoundingBox, same reason (issue #921 AK4):
 *  the heading's box fills whatever width `flex` gives it, so its own edge
 *  would always sit flush next to the figure regardless of how short the text
 *  is. */
async function textBoundingBox(locator: Locator): Promise<{ x: number; right: number }> {
  return locator.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, right: rect.right };
  });
}

/** Seeds a real, decryptable entry via the actual unlocked session's DEK —
 *  same technique as journal-suche.spec.ts's own `seedEntry`. */
async function seedEntry(
  page: Page,
  entryDate: string,
  content: { text: string; mood?: string; tags?: string[] },
): Promise<void> {
  await page.evaluate(
    ({ entryDate, content }) => window.__starship.appendJournalEntry(entryDate, content),
    { entryDate, content },
  );
}

/** `FIXED_NOW` shifted by whole local-calendar days — mirrors
 *  aufgaben.desktop.spec.ts's own `isoAt`, but returns a bare `YYYY-MM-DD`
 *  (journal entries key off `entryDate`, not an ISO instant). */
function dayKeyOffset(days: number): string {
  const date = new Date(FIXED_NOW);
  date.setDate(date.getDate() + days);
  return date.toLocaleDateString('en-CA');
}

/** Same month+day as `FIXED_NOW`, `yearsAgo` years earlier — for seeding „An
 *  diesem Tag" hits. */
function sameDayYearOffset(yearsAgo: number): string {
  const date = new Date(FIXED_NOW);
  date.setFullYear(date.getFullYear() - yearsAgo);
  return date.toLocaleDateString('en-CA');
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  await installClockAt(page);
});

/* -------------------------------------------------------------------------- */
/* AK1 (#1052): Zwei-Bahnen-Grid ab 768px                                     */
/* -------------------------------------------------------------------------- */

test('AK1 (#1052): ab 768px steht links die Tageskarte über „Zuletzt geschrieben", rechts „An diesem Tag" über beiden Zeilen', async ({
  page,
}) => {
  await setUpEditor(page);
  await seedEntry(page, dayKeyOffset(0), { text: 'Heute geschrieben' });
  await seedEntry(page, dayKeyOffset(-1), { text: 'Gestern geschrieben' });
  await seedEntry(page, sameDayYearOffset(1), { text: 'Vor einem Jahr' });

  const editor = page.locator('.journal-editor');
  const dayCard = page.locator('.journal-day-card');
  const recent = page.locator('.journal-recent');
  const sameDay = page.locator('.journal-same-day');
  await expect(dayCard).toBeVisible();
  await expect(recent).toBeVisible();
  await expect(sameDay).toBeVisible();

  // Ein Raster, kein `columns` (AK1).
  expect(await editor.evaluate((el) => getComputedStyle(el).display)).toBe('grid');

  const [dayCardBox, recentBox, sameDayBox] = await Promise.all([
    dayCard.boundingBox(),
    recent.boundingBox(),
    sameDay.boundingBox(),
  ]);
  if (!dayCardBox || !recentBox || !sameDayBox) throw new Error('AK1: fehlende BoundingBox');

  // Linke Bahn: Tageskarte über „Zuletzt geschrieben", dieselbe Spalte.
  expect(recentBox.y).toBeGreaterThanOrEqual(dayCardBox.y + dayCardBox.height);
  expect(Math.abs(recentBox.x - dayCardBox.x)).toBeLessThan(2);

  // Rechte Bahn: „An diesem Tag" rechts von der linken Bahn.
  expect(sameDayBox.x).toBeGreaterThanOrEqual(dayCardBox.x + dayCardBox.width);

  // … und steht über beiden linken Zeilen, nicht nur einer davon.
  const overlapsVertically = (a: { y: number; height: number }, b: { y: number; height: number }) =>
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0;
  expect(overlapsVertically(sameDayBox, dayCardBox)).toBe(true);
  expect(overlapsVertically(sameDayBox, recentBox)).toBe(true);
});

/* -------------------------------------------------------------------------- */
/* AK2 (#1052): „Zuletzt geschrieben" öffnet einen Tag                        */
/* -------------------------------------------------------------------------- */

test('AK2 (#1052): eine Zeile in „Zuletzt geschrieben" öffnet diesen Tag, mit Zeile und Stimmungspunkt', async ({
  page,
}) => {
  await setUpEditor(page);
  await seedEntry(page, dayKeyOffset(0), { text: 'Heute geschrieben', mood: '7' });
  await seedEntry(page, dayKeyOffset(-1), { text: 'Gestern geschrieben', mood: '4' });

  const row = page.locator('.journal-recent__row', { hasText: 'Gestern geschrieben' });
  await expect(row).toBeVisible();
  await expect(row.locator('.journal-recent__mood')).toHaveText('4');
  await row.click();

  const card = page.locator('.journal-day-card');
  await expect(card.locator('.journal-day-card__line')).toHaveText('Gestern geschrieben');
  await expect(card.locator('.journal-day-card__mood')).toHaveText('4');
  // „Zuletzt geschrieben" öffnet über denselben Modul-Store wie Chevrons und
  // Wischen (issue #1050) — „Gestern" bekommt dort dieselbe Augenbraue.
  await expect(card.locator('.journal-day-card__eyebrow')).toHaveText('Gestern');

  // Der geöffnete Tag verschwindet aus der Liste, heute taucht dafür auf.
  await expect(page.locator('.journal-recent__row', { hasText: 'Gestern geschrieben' })).toHaveCount(0);
  await expect(page.locator('.journal-recent__row', { hasText: 'Heute geschrieben' })).toBeVisible();

  // Derselbe Store treibt auch Chevrons/Wischen (issue #1050 AK7): ein
  // Eintrag landet auf dem gerade gezeigten Tag, nicht zwingend auf heute —
  // der Erfassen-Knopf springt deshalb nicht mehr zurück auf heute.
  await page.locator('.fab').click();
  await expect(page.getByRole('dialog', { name: 'Eintragen' })).toBeVisible();
  await expect(card.locator('.journal-day-card__eyebrow')).toHaveText('Gestern');
  await page.getByRole('button', { name: 'Abbrechen' }).click();
});

/* -------------------------------------------------------------------------- */
/* AK3 (#1052): Suchtreffer in zwei Bahnen                                    */
/* -------------------------------------------------------------------------- */

test('AK3 (#1052): Suchtreffer laufen ab 768px in zwei Bahnen, eine Jahresgruppe bricht nicht mittendrin um', async ({
  page,
}) => {
  await setUpEditor(page);
  await seedEntry(page, '2020-03-01', { text: 'Eintrag 2020' });
  await seedEntry(page, '2021-03-01', { text: 'Eintrag 2021' });
  await seedEntry(page, '2022-03-01', { text: 'Eintrag 2022' });
  await seedEntry(page, '2023-03-01', { text: 'Eintrag 2023' });
  await seedEntry(page, '2024-03-01', { text: 'Eintrag 2024' });

  await page.getByRole('button', { name: 'Journal durchsuchen' }).click();

  const groups = page.locator('.journal-search__year-group');
  await expect(groups).toHaveCount(5);

  expect(
    await page.locator('.journal-search__groups').evaluate((el) => getComputedStyle(el).columnCount),
  ).toBe('2');
  const breakInsideValues = await groups.evaluateAll((els) => els.map((el) => getComputedStyle(el).breakInside));
  expect(breakInsideValues.every((value) => value === 'avoid'), breakInsideValues.join(', ')).toBe(true);

  const boxes = await Promise.all(Array.from({ length: 5 }, (_, i) => groups.nth(i).boundingBox()));
  const xs = boxes.map((box) => Math.round(box!.x / 10) * 10);
  expect(new Set(xs).size, `Spalten-x-Werte: ${xs.join(', ')}`).toBe(2);
});

/* -------------------------------------------------------------------------- */
/* AK4 (#1052): Bodenreserve gegen den Fab                                    */
/* -------------------------------------------------------------------------- */

test('AK4 (#1052): der schwebende Erfassen-Knopf verdeckt keine Zeile am Seitenende', async ({ page }) => {
  await setUpEditor(page);
  await seedEntry(page, dayKeyOffset(0), { text: 'Heute geschrieben' });
  for (let yearsAgo = 1; yearsAgo <= 15; yearsAgo += 1) {
    await seedEntry(page, sameDayYearOffset(yearsAgo), { text: `Vor ${yearsAgo} Jahren` });
  }

  const rows = page.locator('.journal-same-day__row');
  await expect(rows).toHaveCount(15);
  await rows.last().scrollIntoViewIfNeeded();

  const lastRowBox = await rows.last().boundingBox();
  const fabBox = await page.locator('.fab').boundingBox();
  if (!lastRowBox || !fabBox) throw new Error('AK4: fehlende BoundingBox');
  expect(lastRowBox.y + lastRowBox.height).toBeLessThanOrEqual(fabBox.y);
});

/* -------------------------------------------------------------------------- */
/* issue #1023 AK3 (nicht #1052): Figur neben dem Titelwort, ab 768px         */
/* -------------------------------------------------------------------------- */

test('die Figur sitzt ab 768px dicht neben dem Titelwort, nicht am rechten Rand (issue #1023 AK3)', async ({
  page,
}) => {
  await setUpEditor(page);

  const heading = page.locator('.journal-page__heading');
  const face = page.locator('.journal-page__title-row .face');
  await expect(heading).toBeVisible();
  await expect(face).toBeVisible();

  const [titleBox, faceBox, rowBox] = await Promise.all([
    textBoundingBox(heading),
    face.boundingBox(),
    page.locator('.journal-page__title-row').boundingBox(),
  ]);
  if (!faceBox || !rowBox) throw new Error('AK3: Figur oder Titelzeile ohne BoundingBox');

  const gapToTitle = faceBox.x - titleBox.right;
  const gapToRightEdge = rowBox.x + rowBox.width - (faceBox.x + faceBox.width);
  // Die Figur sitzt dicht am sichtbaren Textende — nicht mit einem großen
  // Zwischenraum, der sie stattdessen an den rechten Zeilenrand rückte (die
  // Desktop-Umkehr von #928 AK2, das bei 375×812 unverändert grün bleibt).
  expect(gapToTitle).toBeLessThan(gapToRightEdge);
  expect(gapToTitle).toBeLessThan(48);
});

/* -------------------------------------------------------------------------- */
/* AK5 (#1052): mobil unverändert                                             */
/* -------------------------------------------------------------------------- */

// Kein eigener Test nötig — belegt durch die weiterhin grüne 375×812-Suite
// (journal.spec.ts, journal-suche.spec.ts u. a., unverändert in diesem PR)
// plus diese neue Datei, die die Testanzahl insgesamt nur erhöht.
