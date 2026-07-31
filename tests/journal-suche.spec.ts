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
  await page.getByTestId('journal-recovery-key').waitFor();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();
}

async function unlockEditor(page: Page, passphrase = SEARCH_PASSPHRASE): Promise<void> {
  await page.locator('.journal-gate[data-state="locked"]').waitFor();
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Entsperren', exact: true }).click();
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
  // Die Stimmung (issue #415 AC-P2) sitzt als eigene Span im selben Datumsblock.
  await expect(result.locator('.journal-search__result-date')).toHaveText(
    /^01\.07\.2026, \d{2}:\d{2} · Stimmung 6\/10$/,
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
    await seedEntry(page, '2026-07-10', { text: 'Ein Eintrag', tags: ['sport'] });

    const search = page.getByLabel('Journal durchsuchen');
    await search.fill('eintrag');
    // Filterzeile (Mood/Tag/Datum, issue #415) steht auch bei 375px ohne
    // horizontalen Scroll — Tag-select erscheint erst, weil oben ein Tag geseedet wurde.
    await page.getByLabel('Tag filtern').selectOption('sport');
    await page.getByLabel('Von Datum').fill('2026-07-01');
    await page.getByLabel('Bis Datum').fill('2026-07-31');
    await expect(page.locator('.journal-search__result')).toHaveCount(1);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
}

test('AC-F1: Mood-Filter zeigt nur Einträge mit der gewählten Stimmung', async ({ page }) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-01', { text: 'Eintrag A', mood: '3', tags: [] });
  await seedEntry(page, '2026-07-02', { text: 'Eintrag B', mood: '7', tags: [] });
  await seedEntry(page, '2026-07-03', { text: 'Eintrag C', mood: '7', tags: [] });

  const moodFilter = page.locator('.journal-search__mood-filter');
  await moodFilter.getByRole('button', { name: 'Stimmung 7 filtern', exact: true }).click();

  const results = page.locator('.journal-search__result');
  await expect(results).toHaveCount(2);
  await expect(results).toContainText(['Eintrag C', 'Eintrag B']);
});

test('AC-F2: Tag-Filter zeigt nur Einträge mit exakt diesem Tag', async ({ page }) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-01', { text: 'Eintrag A', tags: ['sport'] });
  await seedEntry(page, '2026-07-02', { text: 'Eintrag B', tags: ['büro'] });

  await page.getByLabel('Tag filtern').selectOption('sport');

  const results = page.locator('.journal-search__result');
  await expect(results).toHaveCount(1);
  await expect(results).toContainText('Eintrag A');
});

test('AC-F3: Datum von/bis engt den Zeitraum inklusiv ein', async ({ page }) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-01', { text: 'Eintrag A', tags: [] });
  await seedEntry(page, '2026-07-05', { text: 'Eintrag B', tags: [] });
  await seedEntry(page, '2026-07-10', { text: 'Eintrag C', tags: [] });

  const results = page.locator('.journal-search__result');

  // nur "von" (nach/gleich) — B und C
  await page.getByLabel('Von Datum').fill('2026-07-05');
  await expect(results).toHaveCount(2);
  await expect(results).toContainText(['Eintrag C', 'Eintrag B']);

  // nur "bis" (vor/gleich) — A und B
  await page.getByLabel('Von Datum').fill('');
  await page.getByLabel('Bis Datum').fill('2026-07-05');
  await expect(results).toHaveCount(2);
  await expect(results).toContainText(['Eintrag B', 'Eintrag A']);

  // beide gesetzt (Bereich) — nur B
  await page.getByLabel('Von Datum').fill('2026-07-02');
  await expect(results).toHaveCount(1);
  await expect(results).toContainText('Eintrag B');
});

test('AC-F4: Freitext + Mood verengen gemeinsam auf die Schnittmenge', async ({ page }) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-01', { text: 'Ruhiger Lauf', mood: '7', tags: [] });
  await seedEntry(page, '2026-07-02', { text: 'Ruhiger Lauf', mood: '3', tags: [] });
  await seedEntry(page, '2026-07-03', { text: 'Büro-Tag', mood: '7', tags: [] });

  const results = page.locator('.journal-search__result');
  await page.getByLabel('Journal durchsuchen').fill('lauf');
  await expect(results).toHaveCount(2);

  const moodFilter = page.locator('.journal-search__mood-filter');
  await moodFilter.getByRole('button', { name: 'Stimmung 7 filtern', exact: true }).click();
  await expect(results).toHaveCount(1);
  await expect(results).toContainText('Ruhiger Lauf');
});

test('AC-P1: sobald ein Filter aktiv ist, weicht der Editor der Suche', async ({ page }) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-01', { text: 'Ein Alltagseintrag', tags: [] });
  await expect(page.locator('.journal-editor__form')).toBeVisible();

  const search = page.getByLabel('Journal durchsuchen');
  await search.fill('alltag');

  await expect(page.locator('.journal-editor__form')).toHaveCount(0);
  await expect(page.locator('.journal-editor__date')).toHaveCount(0);
  await expect(page.locator('.journal-editor__entries')).toHaveCount(0);
  await expect(page.locator('.journal-search__result')).toHaveCount(1);

  await search.fill('');
  await expect(page.locator('.journal-editor__form')).toBeVisible();
});

test('AC-P2: eine Treffervorschau zeigt die Stimmung des Eintrags', async ({ page }) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-01', { text: 'Eintrag mit Stimmung', mood: '6', tags: [] });

  await page.getByLabel('Journal durchsuchen').fill('stimmung');
  await expect(page.locator('.journal-search__result')).toContainText('Stimmung 6/10');
});

test('AC-P3: langer Text wird gekürzt und lässt sich auf- und wieder zuklappen', async ({ page }) => {
  await setUpEditor(page);
  const longText = 'Lauf am Fluss und noch mehr Text darüber, was heute alles passiert ist, Wort für Wort. '.repeat(3);
  await seedEntry(page, '2026-07-01', { text: longText, tags: [] });

  await page.getByLabel('Journal durchsuchen').fill('lauf');
  const snippet = page.locator('.journal-search__result-snippet');
  await expect(snippet).toContainText('…');

  const expandButton = page.getByRole('button', { name: 'Vollständigen Text anzeigen' });
  await expect(expandButton).toBeVisible();
  await expandButton.click();

  await expect(snippet).not.toContainText('…');
  const collapseButton = page.getByRole('button', { name: 'Weniger anzeigen' });
  await expect(collapseButton).toBeVisible();
  await collapseButton.click();

  await expect(snippet).toContainText('…');
  await expect(page.getByRole('button', { name: 'Vollständigen Text anzeigen' })).toBeVisible();
});

test('AC-P4: ein Treffer klicken setzt alle Filter zurück und zeigt wieder den Editor', async ({ page }) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-01', { text: 'Eintrag mit Tag', mood: '5', tags: ['sport'] });

  await page.getByLabel('Journal durchsuchen').fill('eintrag');
  const moodFilter = page.locator('.journal-search__mood-filter');
  await moodFilter.getByRole('button', { name: 'Stimmung 5 filtern', exact: true }).click();
  await page.getByLabel('Tag filtern').selectOption('sport');
  await page.getByLabel('Von Datum').fill('2026-07-01');
  await page.getByLabel('Bis Datum').fill('2026-07-01');
  await expect(page.locator('.journal-search__result')).toHaveCount(1);

  await page.locator('.journal-search__result').click();

  await expect(page.getByLabel('Journal durchsuchen')).toHaveValue('');
  await expect(page.locator('.journal-editor__form')).toBeVisible();
  await expect(page.locator('.journal-search__result')).toHaveCount(0);
});

test('AC8: eine unlesbare Zeile macht die Suche nicht blind (issue #384)', async ({ page }) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-09', { text: 'Ein lesbarer Lauf-Eintrag', tags: [] });

  // Giftzeile: gültiges Base64, aber unter keinem Schlüssel entschlüsselbar — genau
  // der Fall, an dem `Promise.all` vorher den kompletten Ladevorgang rejectete
  // (journal-search-cache.ts) und `entries` für immer `undefined` blieb.
  await page.evaluate(() =>
    window.__starship.mutate({
      table: 'journal_entries',
      op: 'upsert',
      payload: {
        entryDate: '2026-07-09',
        ciphertext: btoa('nicht entschluesselbare bytes'),
        nonce: btoa('123456789012'),
      },
    }),
  );

  const search = page.getByLabel('Journal durchsuchen');
  await search.fill('lauf');

  await expect(page.locator('.journal-search__result')).toHaveCount(1);
  await expect(page.locator('.journal-search__result')).toContainText('Ein lesbarer Lauf-Eintrag');
});

test('AC7: die Suche nutzt Tokens, die sich im Dark Mode tatsächlich unterscheiden', async ({ page }) => {
  await setUpEditor(page);

  const search = page.getByLabel('Journal durchsuchen');
  const lightBg = await search.evaluate((el) => getComputedStyle(el).backgroundColor);

  // Datumsfeld (issue #415) — neues Control, dieselbe Token-Erwartung.
  const fromDate = page.getByLabel('Von Datum');
  const lightDateBg = await fromDate.evaluate((el) => getComputedStyle(el).backgroundColor);

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const darkBg = await search.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(darkBg).not.toBe(lightBg);

  const darkDateBg = await fromDate.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(darkDateBg).not.toBe(lightDateBg);
});
