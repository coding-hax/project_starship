import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData } from './helpers';

/**
 * S4 of #302 (issue #341): local full-text search over already-decrypted journal
 * entries. Owner decision "3a" in #301 — decrypt on load, scan in memory, no
 * on-disk index — drives AC2 below. Builds on the real editor (S3b, #340).
 *
 * issue #376/ADR-0018: a day can carry any number of entries — a result is one
 * entry, not a day, sorted and shown with date AND time (AC6 below).
 */

test.beforeEach(async () => {
  await resetAppData();
});

const SEARCH_PASSPHRASE = 's4 suche passphrase';

/** Same wait-for-settled-state reasoning as journal.spec.ts's setUpEditor. */
async function setUpEditor(page: Page, passphrase = SEARCH_PASSPHRASE): Promise<void> {
  await registerPasskey(page);
  await page.goto('/journal');
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('Passphrase wiederholen').fill(passphrase);
  await page.getByRole('button', { name: 'Einrichten' }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();
}

async function unlockEditor(page: Page, passphrase = SEARCH_PASSPHRASE): Promise<void> {
  await page.locator('.journal-gate[data-state="locked"]').waitFor();
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Entsperren' }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();
}

/** Seeds a real, decryptable entry via the actual unlocked session's DEK (the
 * same call the editor's submit makes) — several days of real content for the
 * search to find, without driving the UI for each one. */
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

test('AC1: Suchfeld findet Treffer sowohl im Text als auch in Tags', async ({ page }) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-10', { text: 'Ein ruhiger Lauf am Fluss', tags: ['sport'] });
  await seedEntry(page, '2026-07-11', { text: 'Nichts Besonderes', tags: ['lauf-pause'] });
  await seedEntry(page, '2026-07-12', { text: 'Ganz normaler Tag', tags: ['büro'] });

  const search = page.getByLabel('Journal durchsuchen');
  await search.fill('lauf');

  const results = page.locator('.journal-search__result');
  await expect(results).toHaveCount(2);
  // Neuester Eintrag zuerst (search.ts, sortiert nach createdAt seit issue #376) —
  // die drei Einträge wurden in dieser Reihenfolge angelegt, unabhängig von entryDate.
  await expect(results).toContainText(['Nichts Besonderes', 'Ein ruhiger Lauf am Fluss']);
});

test('AC2: nach einer Suche liegt kein Klartext-Fragment in IndexedDB', async ({ page }) => {
  await setUpEditor(page);
  const secretText = 'GEHEIMNISVOLLER SUCHTEXT';
  const secretTag = 'geheimtag';
  await seedEntry(page, '2026-07-10', { text: secretText, tags: [secretTag] });

  const search = page.getByLabel('Journal durchsuchen');
  await search.fill('geheim');
  await expect(page.locator('.journal-search__result')).toHaveCount(1);

  const dump = await page.evaluate(() => window.__starship.debugDumpStores());
  expect(dump).not.toContain(secretText);
  expect(dump).not.toContain(secretTag);
});

test('AC3: bei gesperrtem Journal gibt es keine Suche, sondern den Entsperr-Zustand', async ({ page }) => {
  await setUpEditor(page);
  await page.reload();

  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();
  await expect(page.locator('.journal-search')).toHaveCount(0);

  await unlockEditor(page);
  await expect(page.locator('.journal-search')).toBeVisible();
});

test('AC4: keine Ladeanzeige während der Suche', async ({ page }) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-10', { text: 'Ein Eintrag', tags: [] });

  const search = page.getByLabel('Journal durchsuchen');
  await search.fill('eintrag');
  await expect(page.locator('.journal-search__result')).toHaveCount(1);

  await expect(page.getByText('Lädt', { exact: false })).toHaveCount(0);
  await expect(page.locator('[data-loading], .journal-search__loading')).toHaveCount(0);
});

test('AC5: kein Treffer zeigt einen ruhigen Leerzustand statt einer Fehlermeldung', async ({ page }) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-10', { text: 'Ein Eintrag', tags: [] });

  const search = page.getByLabel('Journal durchsuchen');
  await search.fill('nichtvorhandenesding');

  await expect(page.locator('.journal-search__empty')).toBeVisible();
  await expect(page.locator('.journal-search__empty')).toHaveText('Keine Treffer.');
  // Not getByRole('alert') — Next's route announcer also has role="alert" (see
  // sync.spec.ts AC2) — the error toast is the only thing carrying this class.
  await expect(page.locator('.toast--error')).toHaveCount(0);
});

test('AC6: ein Treffer zeigt Datum und Uhrzeit und führt zu den Einträgen des jeweiligen Tages', async ({
  page,
}) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-01', { text: 'Alter Eintrag mit Stichwort', mood: '6', tags: [] });

  const search = page.getByLabel('Journal durchsuchen');
  await search.fill('stichwort');
  const result = page.locator('.journal-search__result').first();
  // Datum UND Uhrzeit (issue #376 AC6) — ein Treffer ist ein Eintrag, kein Tag.
  await expect(result.locator('.journal-search__result-date')).toHaveText(
    /^01\.07\.2026, \d{2}:\d{2}$/,
  );
  await result.click();

  // Kein Autosave-Entwurffeld mehr, das befüllt würde (ADR-0018) — der Treffer
  // wechselt den sichtbaren Tag, dessen Einträge darunter erscheinen.
  await expect(page.locator('.journal-editor__entry')).toHaveCount(1);
  await expect(page.locator('.journal-editor__entry')).toContainText('Alter Eintrag mit Stichwort');
  await expect(page.locator('.journal-editor__entry')).toContainText('Stimmung 6/10');
});

test('AC6: mehrere Einträge desselben Tages sind eigenständige Treffer', async ({ page }) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-05', { text: 'Morgens ein ruhiger Lauf', tags: [] });
  await seedEntry(page, '2026-07-05', { text: 'Abends noch ein Lauf', tags: [] });

  const search = page.getByLabel('Journal durchsuchen');
  await search.fill('lauf');

  await expect(page.locator('.journal-search__result')).toHaveCount(2);
});

for (const viewport of [
  { width: 375, height: 667 },
  { width: 1280, height: 800 },
]) {
  test(`AC7: Suche bei ${viewport.width}px ohne horizontalen Seiten-Scroll`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await setUpEditor(page);
    await seedEntry(page, '2026-07-10', { text: 'Ein Eintrag', tags: [] });

    const search = page.getByLabel('Journal durchsuchen');
    await search.fill('eintrag');
    await expect(page.locator('.journal-search__result')).toHaveCount(1);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
}

test('AC7: die Suche nutzt Tokens, die sich im Dark Mode tatsächlich unterscheiden', async ({ page }) => {
  await setUpEditor(page);

  const search = page.getByLabel('Journal durchsuchen');
  const lightBg = await search.evaluate((el) => getComputedStyle(el).backgroundColor);

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const darkBg = await search.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(darkBg).not.toBe(lightBg);
});
