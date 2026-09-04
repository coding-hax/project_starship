import { expect, test, type Locator, type Page } from '@playwright/test';
import { installClockAt, registerPasskey, resetAppData } from './helpers';

/**
 * Desktop-only journal furniture that survives the day-card rework (#1048).
 * The AK1/AK2/AK4 two-column-flow tests that used to live here (issue #1023,
 * Teil 8 von #1015 — `.journal-editor__day-group`, `columns: 2`) are gone: the
 * entry stream they measured no longer exists, replaced by the single day-card
 * surface. Epic #1046, section "Was dabei mitstirbt": that column flow is
 * explicitly retired with the stream and gets replaced by a dedicated desktop
 * ticket once one exists, not restored here. What remains — AK3, the figure's
 * position next to the title — is unrelated to the stream and still applies.
 */

const PASSPHRASE = 'desktop journal passphrase';

/** Same setup flow as journal-suche.spec.ts's setUpEditor. */
async function setUpEditor(page: Page): Promise<void> {
  await registerPasskey(page);
  await page.goto('/journal');
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

test.beforeEach(async ({ page }) => {
  await resetAppData();
  await installClockAt(page);
});

/* -------------------------------------------------------------------------- */
/* AK3: Figur neben dem Titelwort, ab 768px                                   */
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
/* AK6: mobil unverändert                                                     */
/* -------------------------------------------------------------------------- */

// Kein eigener Test nötig — belegt durch die weiterhin grüne 375×812-Suite
// (journal.spec.ts, journal-suche.spec.ts u. a., unverändert in diesem PR)
// plus diese neue Datei, die die Testanzahl insgesamt nur erhöht.
