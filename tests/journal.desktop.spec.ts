import { expect, test, type Locator, type Page } from '@playwright/test';
import { installClockAt, registerPasskey, resetAppData } from './helpers';

/**
 * Desktop-only: the two-column layout only applies from 768px up
 * (journal-editor.css, issue #1023, Teil 8 von #1015) — the 375×812 suite
 * (journal.spec.ts, journal-suche.spec.ts u. a.) is unaffected (AK6), so it
 * stays in its own file instead of a runtime `test.skip`, same pattern as
 * kalender.desktop.spec.ts (issue #1021).
 */

const PASSPHRASE = 'desktop journal passphrase';

/** Same setup flow as journal-suche.spec.ts's setUpEditor — registers the
 *  passphrase through the real UI, then switches to reduced motion so the
 *  `.list-motion-item` enter animation (issue #430) can't leave a stale
 *  `transform: translateY(8px)` under a boundingBox taken right after seeding
 *  (Memory: "Enter-Animation täuscht Layout-Shift vor"). Every entry after the
 *  first non-empty snapshot renders as `entering`, not `present`
 *  (use-list-presence.ts), so this matters for every seed but the very first. */
async function setUpEditor(page: Page): Promise<void> {
  await registerPasskey(page);
  await page.goto('/journal');
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByLabel('Passphrase wiederholen').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Einrichten' }).click();
  await page.getByTestId('journal-recovery-key').waitFor();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();
  await page.emulateMedia({ reducedMotion: 'reduce' });
}

/** Seeds a real, decryptable entry via the actual unlocked session's DEK — same
 *  bridge call as journal-suche.spec.ts's seedEntry. */
async function seedEntry(page: Page, entryDate: string, text: string): Promise<void> {
  await page.evaluate(
    ({ entryDate, text }) => window.__starship.appendJournalEntry(entryDate, { text }),
    { entryDate, text },
  );
}

/** `2026-0<month>-<day>`, walking backwards from a fixed date so every call in
 *  a test produces a distinct, deterministic day key without touching the
 *  installed clock. */
function dayKey(offset: number): string {
  const date = new Date('2026-06-28T12:00:00.000Z');
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
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
/* AK1: zwei Bahnen ab 768px                                                  */
/* -------------------------------------------------------------------------- */

test('die Tageschronik läuft ab 768px in zwei Bahnen (issue #1023 AK1)', async ({ page }) => {
  await setUpEditor(page);
  for (let i = 0; i < 8; i += 1) {
    await seedEntry(page, dayKey(i), `Eintrag ${i}`);
  }

  const editor = page.locator('.journal-editor');
  const groups = page.locator('.journal-editor__day-group');
  await expect(groups).toHaveCount(8);

  const editorBox = await editor.boundingBox();
  const groupBoxes = await groups.evaluateAll((els) =>
    els.map((el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, width: rect.width };
    }),
  );
  if (!editorBox) throw new Error('AK1: Editor ohne BoundingBox');

  // Zwei distinkte Spalten-x-Positionen, nicht nur eine (echter Reflow statt
  // eines No-op-`columns`, das der Browser bei `display: flex` ignoriert).
  const xClusters = new Set(groupBoxes.map((box) => Math.round(box.x / 10) * 10));
  expect(xClusters.size).toBe(2);

  // Jede Gruppe ist deutlich schmaler als die volle Editorbreite.
  for (const box of groupBoxes) {
    expect(box.width).toBeLessThan(editorBox.width * 0.6);
  }

  expect(await editor.evaluate((el) => getComputedStyle(el).columnCount)).toBe('2');
});

/* -------------------------------------------------------------------------- */
/* AK2: Tagesgruppen brechen nicht um                                         */
/* -------------------------------------------------------------------------- */

test('eine Tagesgruppe bricht nicht über zwei Bahnen um (issue #1023 AK2)', async ({ page }) => {
  await setUpEditor(page);
  await seedEntry(page, dayKey(0), 'Eintrag A');

  const group = page.locator('.journal-editor__day-group').first();
  await expect(group).toBeVisible();
  expect(await group.evaluate((el) => getComputedStyle(el).breakInside)).toBe('avoid');
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
/* AK4: Bodenreserve gegen den schwebenden Erfassen-Knopf, ab 768px           */
/* -------------------------------------------------------------------------- */

test('der schwebende Erfassen-Knopf verdeckt bei einer langen Chronik kein Element (issue #1023 AK4)', async ({
  page,
}) => {
  await setUpEditor(page);
  for (let i = 0; i < 24; i += 1) {
    await seedEntry(page, dayKey(i), `Eintrag ${i}`);
  }

  const lastGroup = page.locator('.journal-editor__day-group').last();
  await lastGroup.scrollIntoViewIfNeeded();
  await expect(lastGroup).toBeVisible();

  const fab = page.locator('.fab');
  const [fabBox, groupBox] = await Promise.all([fab.boundingBox(), lastGroup.boundingBox()]);
  if (!fabBox || !groupBox) throw new Error('AK4: Fab oder letzte Tagesgruppe ohne BoundingBox');

  expect(groupBox.y + groupBox.height).toBeLessThanOrEqual(fabBox.y);
});

/* -------------------------------------------------------------------------- */
/* AK6: mobil unverändert                                                     */
/* -------------------------------------------------------------------------- */

// Kein eigener Test nötig — belegt durch die weiterhin grüne 375×812-Suite
// (journal.spec.ts, journal-suche.spec.ts u. a., unverändert in diesem PR)
// plus diese neue Datei, die die Testanzahl insgesamt nur erhöht.
