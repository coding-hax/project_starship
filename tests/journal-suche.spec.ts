import { expect, test, type Locator, type Page } from '@playwright/test';
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

/** issue #423 AC-B: Mood-/Tag-/Datumsfilter sind standardmäßig verborgen und
 * erscheinen erst nach Klick auf den Filter-Button. */
async function openFilters(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
}

/** issue #700 AK5: das Suchfeld ist nicht mehr dauerhaft sichtbar — die Lupe in
 * der Titelzeile öffnet erst den Suchmodus. Die Lupe ist ein Button mit der
 * `aria-label` „Journal durchsuchen"; das Suchfeld trägt dieselbe Beschriftung,
 * beide stehen aber nie gleichzeitig im DOM (die Lupe verschwindet im
 * Suchmodus), daher bleibt der Button-Zugriff eindeutig. */
async function openSearch(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Journal durchsuchen' }).click();
}

/** Bounding box of the date text inside `.journal-page__eyebrow-row`
 *  (issue #928 AK1). Since issue #1050, the date sits in its own
 *  `.journal-page__day-nav-date` span flanked by chevrons (`JournalDayNav`),
 *  no longer bare text directly in the row. */
async function eyebrowDateBox(row: Locator): Promise<{ x: number; right: number }> {
  const box = await row.locator('.journal-page__day-nav-date').boundingBox();
  if (!box) throw new Error('date element not found in eyebrow row');
  return { x: box.x, right: box.x + box.width };
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

  await openSearch(page);
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

  await openSearch(page);
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
  // Gesperrt: weder die Lupe (AK7) noch das Suchfeld stehen im DOM.
  await expect(page.getByRole('button', { name: 'Journal durchsuchen' })).toHaveCount(0);
  await expect(page.locator('.journal-search')).toHaveCount(0);

  await unlockEditor(page);
  // Entsperrt: die Lupe erscheint, das Suchfeld aber erst nach einem Klick (AK5).
  await expect(page.getByRole('button', { name: 'Journal durchsuchen' })).toBeVisible();
  await expect(page.locator('.journal-search')).toHaveCount(0);

  await openSearch(page);
  await expect(page.locator('.journal-search')).toBeVisible();
});

test('AC4: keine Ladeanzeige während der Suche', async ({ page }) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-10', { text: 'Ein Eintrag', tags: [] });

  await openSearch(page);
  const search = page.getByLabel('Journal durchsuchen');
  await search.fill('eintrag');
  await expect(page.locator('.journal-search__result')).toHaveCount(1);

  await expect(page.getByText('Lädt', { exact: false })).toHaveCount(0);
  await expect(page.locator('[data-loading], .journal-search__loading')).toHaveCount(0);
});

test('AC5: kein Treffer zeigt einen ruhigen Leerzustand statt einer Fehlermeldung', async ({ page }) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-10', { text: 'Ein Eintrag', tags: [] });

  await openSearch(page);
  const search = page.getByLabel('Journal durchsuchen');
  await search.fill('nichtvorhandenesding');

  await expect(page.locator('.journal-search__empty')).toBeVisible();
  await expect(page.locator('.journal-search__empty')).toHaveText('Keine Treffer.');
  // Not getByRole('alert') — Next's route announcer also has role="alert" (see
  // sync.spec.ts AC2) — the error toast is the only thing carrying this class.
  await expect(page.locator('.toast--error')).toHaveCount(0);
});

test('AC6: ein Treffer zeigt Datum und Uhrzeit', async ({ page }) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-01', { text: 'Alter Eintrag mit Stichwort', mood: '6', tags: [] });

  await openSearch(page);
  const search = page.getByLabel('Journal durchsuchen');
  await search.fill('stichwort');
  const result = page.locator('.journal-search__result').first();
  // Datum UND Uhrzeit (issue #376 AC6) — ein Treffer ist ein Eintrag, kein Tag.
  // Seit issue #700 AK6 volles, ausgeschriebenes Datum ("Sa. 8. August · 10:12"):
  // Wochentag kurz, Tag numerisch, Monat lang, " · ", Zeit. Intl liefert den kurzen
  // Wochentag mit Komma ("Mi.,") — genau wie die Tagesüberschriften des Stroms; das
  // Komma bleibt (Spezifikationswandel, keine gelockerte Zusicherung). Die Stimmung
  // (issue #415 AC-P2) sitzt weiter als eigene Span im selben Datumsblock.
  await expect(result.locator('.journal-search__result-date')).toHaveText(
    /^Mi\., 1\. Juli · \d{2}:\d{2} · Stimmung 6\/10$/,
  );

  // Ein Treffer führte früher zu den Einträgen des jeweiligen Tages — seit
  // #1048 zeigt die Seite nur noch den heutigen Tag, ein Sprung existiert
  // vorerst nicht mehr (journal-editor.tsx, handleSearchSelect). Kehrt mit
  // "Suche im neuen Register" zurück (Kind-Ticket von #1046); bis dahin prüft
  // dieser Test nur noch, dass der Klick den Suchmodus verlässt (AC-P4 deckt
  // das für den Filter-Fall bereits ab, hier nur die Rückkehr selbst).
  await result.click();
  await expect(page.locator('.journal-search')).toHaveCount(0);
});

test('AC6: mehrere Einträge desselben Tages sind eigenständige Treffer', async ({ page }) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-05', { text: 'Morgens ein ruhiger Lauf', tags: [] });
  await seedEntry(page, '2026-07-05', { text: 'Abends noch ein Lauf', tags: [] });

  await openSearch(page);
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

    await openSearch(page);
    const search = page.getByLabel('Journal durchsuchen');
    await search.fill('eintrag');
    // Filterzeile (Mood/Tag/Datum, issue #415) steht auch bei 375px ohne
    // horizontalen Scroll — Tag-select erscheint erst, weil oben ein Tag geseedet wurde.
    await openFilters(page);
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

  await openSearch(page);
  await openFilters(page);
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

  await openSearch(page);
  await openFilters(page);
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

  await openSearch(page);
  await openFilters(page);
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

  await openSearch(page);
  const results = page.locator('.journal-search__result');
  await page.getByLabel('Journal durchsuchen').fill('lauf');
  await expect(results).toHaveCount(2);

  await openFilters(page);
  const moodFilter = page.locator('.journal-search__mood-filter');
  await moodFilter.getByRole('button', { name: 'Stimmung 7 filtern', exact: true }).click();
  await expect(results).toHaveCount(1);
  await expect(results).toContainText('Ruhiger Lauf');
});

test('AC-P1: im Suchmodus weicht der Editor der Suche, Abbrechen stellt ihn wieder her', async ({ page }) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-01', { text: 'Ein Alltagseintrag', tags: [] });
  // Der FAB (nicht mehr das Formular selbst, #701) ist window-unabhängig da —
  // im offenen Sheet wäre das Formular ohnehin unsichtbar, solange niemand den
  // FAB angetippt hat.
  const fab = page.getByRole('button', { name: 'Eintragen', exact: true });
  await expect(fab).toBeVisible();

  // Seit issue #700 AK6 weicht der Editor bereits beim Betreten des Suchmodus —
  // nicht erst, wenn eine Suche Treffer hat: kein FAB, kein Strom.
  await openSearch(page);
  await expect(fab).toHaveCount(0);
  await expect(page.locator('.journal-editor__day-header')).toHaveCount(0);
  await expect(page.locator('.journal-editor__entries')).toHaveCount(0);

  const search = page.getByLabel('Journal durchsuchen');
  await search.fill('alltag');
  await expect(page.locator('.journal-search__result')).toHaveCount(1);

  // Rückkehr über „Abbrechen" (das Leeren des Feldes verlässt den Modus nicht).
  await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  await expect(fab).toBeVisible();
  await expect(page.locator('.journal-search')).toHaveCount(0);
});

test('AC-P2: eine Treffervorschau zeigt die Stimmung des Eintrags', async ({ page }) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-01', { text: 'Eintrag mit Stimmung', mood: '6', tags: [] });

  await openSearch(page);
  await page.getByLabel('Journal durchsuchen').fill('stimmung');
  await expect(page.locator('.journal-search__result')).toContainText('Stimmung 6/10');
});

test('AC-P3: langer Text wird gekürzt und lässt sich auf- und wieder zuklappen', async ({ page }) => {
  await setUpEditor(page);
  const longText = 'Lauf am Fluss und noch mehr Text darüber, was heute alles passiert ist, Wort für Wort. '.repeat(3);
  await seedEntry(page, '2026-07-01', { text: longText, tags: [] });

  await openSearch(page);
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

test('AC-P4: ein Treffer klicken verlässt den Suchmodus und zeigt wieder den Editor', async ({ page }) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-01', { text: 'Eintrag mit Tag', mood: '5', tags: ['sport'] });

  await openSearch(page);
  await page.getByLabel('Journal durchsuchen').fill('eintrag');
  await openFilters(page);
  const moodFilter = page.locator('.journal-search__mood-filter');
  await moodFilter.getByRole('button', { name: 'Stimmung 5 filtern', exact: true }).click();
  await page.getByLabel('Tag filtern').selectOption('sport');
  await page.getByLabel('Von Datum').fill('2026-07-01');
  await page.getByLabel('Bis Datum').fill('2026-07-01');
  await expect(page.locator('.journal-search__result')).toHaveCount(1);

  await page.locator('.journal-search__result').click();

  // Seit issue #700 AK5 verschwindet das Suchfeld beim Verlassen ganz — ein
  // späteres Öffnen beginnt darum leer (die Filter sind zurückgesetzt).
  await expect(page.locator('.journal-search')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Eintragen', exact: true })).toBeVisible();
  // Die Lupe steht wieder, das erneute Öffnen zeigt ein leeres Suchfeld.
  await openSearch(page);
  await expect(page.getByLabel('Journal durchsuchen')).toHaveValue('');
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

  await openSearch(page);
  const search = page.getByLabel('Journal durchsuchen');
  await search.fill('lauf');

  await expect(page.locator('.journal-search__result')).toHaveCount(1);
  await expect(page.locator('.journal-search__result')).toContainText('Ein lesbarer Lauf-Eintrag');
});

test('AC7: die Suche nutzt Tokens, die sich im Dark Mode tatsächlich unterscheiden', async ({ page }) => {
  await setUpEditor(page);

  await openSearch(page);
  const search = page.getByLabel('Journal durchsuchen');
  const lightBg = await search.evaluate((el) => getComputedStyle(el).backgroundColor);

  // Datumsfeld (issue #415) — neues Control, dieselbe Token-Erwartung.
  await openFilters(page);
  const fromDate = page.getByLabel('Von Datum');
  const lightDateBg = await fromDate.evaluate((el) => getComputedStyle(el).backgroundColor);

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const darkBg = await search.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(darkBg).not.toBe(lightBg);

  const darkDateBg = await fromDate.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(darkDateBg).not.toBe(lightDateBg);
});

test('AC-B: die Filter sind standardmäßig verborgen und lassen sich per Filter-Button auf- und zuklappen', async ({
  page,
}) => {
  await setUpEditor(page);

  await openSearch(page);
  const filterToggle = page.getByRole('button', { name: 'Filter', exact: true });
  await expect(page.locator('.journal-search__filters')).toHaveCount(0);
  await expect(filterToggle).toHaveAttribute('aria-expanded', 'false');

  await filterToggle.click();
  await expect(page.locator('.journal-search__filters')).toBeVisible();
  await expect(filterToggle).toHaveAttribute('aria-expanded', 'true');

  await filterToggle.click();
  await expect(page.locator('.journal-search__filters')).toHaveCount(0);
  await expect(filterToggle).toHaveAttribute('aria-expanded', 'false');
});

test('AC-D: das Öffnen des Filter-Menüs zeigt sofort alle Einträge (issue #456)', async ({
  page,
}) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-01', { text: 'Eintrag A', tags: [] });
  await seedEntry(page, '2026-07-02', { text: 'Eintrag B', tags: [] });
  const fab = page.getByRole('button', { name: 'Eintragen', exact: true });
  await expect(fab).toBeVisible();

  // Seit issue #700 AK6 weicht der FAB schon beim Betreten des Suchmodus.
  await openSearch(page);
  await expect(fab).toHaveCount(0);

  await openFilters(page);
  const results = page.locator('.journal-search__result');
  await expect(results).toHaveCount(2);
  await expect(results).toContainText(['Eintrag B', 'Eintrag A']);

  // Seit issue #847 AK1 ist "alle Einträge zeigen" der Normalzustand des
  // Suchmodus, nicht mehr an das offene Filter-Menü gebunden — die Liste
  // bleibt darum auch nach dem Zuklappen des Filter-Menüs stehen; nur
  // „Abbrechen" verlässt den Suchmodus.
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(results).toHaveCount(2);
  await expect(fab).toHaveCount(0);

  await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  await expect(fab).toBeVisible();
});

test('AC-E: Enter im leeren Suchfeld zeigt alle Einträge, ohne dass das Filter-Menü offen sein muss (issue #456)', async ({
  page,
}) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-01', { text: 'Eintrag A', tags: [] });
  await seedEntry(page, '2026-07-02', { text: 'Eintrag B', tags: [] });

  await openSearch(page);
  const search = page.getByLabel('Journal durchsuchen');
  await expect(search).toHaveValue('');
  await search.press('Enter');

  await expect(page.getByRole('button', { name: 'Eintragen', exact: true })).toHaveCount(0);
  const results = page.locator('.journal-search__result');
  await expect(results).toHaveCount(2);
  await expect(results).toContainText(['Eintrag B', 'Eintrag A']);

  // Ein Treffer klicken verlässt den Suchmodus wie jeden anderen Filter-Zustand
  // (AC-P4-Verhalten): das Suchfeld verschwindet, der Editor kehrt zurück.
  await results.first().click();
  await expect(page.locator('.journal-search')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Eintragen', exact: true })).toBeVisible();
});

test('AC-C: der Zurücksetzen-Knopf leert alle Filter inkl. Datum zuverlässig', async ({ page }) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-01', { text: 'Eintrag A', mood: '5', tags: ['sport'] });
  await seedEntry(page, '2026-07-15', { text: 'Eintrag B', mood: '2', tags: ['büro'] });

  await openSearch(page);
  await openFilters(page);
  const results = page.locator('.journal-search__result');
  await page.getByLabel('Von Datum').fill('2026-07-01');
  await page.getByLabel('Bis Datum').fill('2026-07-01');
  await expect(results).toHaveCount(1);

  await page.getByRole('button', { name: 'Zurücksetzen', exact: true }).click();

  await expect(page.getByLabel('Von Datum')).toHaveValue('');
  await expect(page.getByLabel('Bis Datum')).toHaveValue('');
  // issue #456: das Filter-Menü ist nach dem Reset weiterhin offen — und ein
  // offenes Filter-Menü ohne gesetzten Filter zeigt seitdem alle Einträge,
  // statt in den inaktiven Leerzustand zu fallen.
  await expect(results).toHaveCount(2);
});

test('AC-D: der Zurücksetzen-Knopf steht auf Höhe der Datumsfelder statt darunter (issue #455)', async ({
  page,
}) => {
  await setUpEditor(page);
  await openSearch(page);
  await openFilters(page);

  const fromDate = page.getByLabel('Von Datum');
  const resetButton = page.getByRole('button', { name: 'Zurücksetzen', exact: true });

  const dateBox = (await fromDate.boundingBox())!;
  const resetBox = (await resetButton.boundingBox())!;
  expect(dateBox).not.toBeNull();
  expect(resetBox).not.toBeNull();

  // Gleiche Zeile: die vertikalen Mittelpunkte liegen praktisch aufeinander,
  // statt der Knopf als eigene Zeile darunter zu stehen.
  const dateCenterY = dateBox.y + dateBox.height / 2;
  const resetCenterY = resetBox.y + resetBox.height / 2;
  expect(Math.abs(dateCenterY - resetCenterY)).toBeLessThan(2);

  // Icon statt Text (Vorschlag aus dem Ticket).
  await expect(resetButton.locator('svg')).toHaveCount(1);
  await expect(resetButton).not.toHaveText('Zurücksetzen');
});

test('issue #928 AK1: die Augenbraue zeigt das Datum links und die Lupe rechts', async ({
  page,
}) => {
  await setUpEditor(page);

  const row = page.locator('.journal-page__eyebrow-row');
  const toggle = row.getByRole('button', { name: 'Journal durchsuchen' });
  const rowBox = await row.boundingBox();
  const toggleBox = await toggle.boundingBox();
  const dateBox = await eyebrowDateBox(row);
  if (!rowBox || !toggleBox) throw new Error('missing bounding box');

  // Datum links: die Lupe beginnt rechts vom Datumstext.
  expect(toggleBox.x).toBeGreaterThan(dateBox.right);

  // Lupe rechts außen: ihr rechter Rand liegt an der Augenbrauenzeile an.
  expect(rowBox.x + rowBox.width - (toggleBox.x + toggleBox.width)).toBeLessThan(2);
});

test('AK5: die Lupe (44×44) in der Augenbrauenzeile öffnet den Suchmodus, das Suchfeld ist nicht dauerhaft sichtbar', async ({
  page,
}) => {
  await setUpEditor(page);

  // Standardmäßig ist kein Suchfeld auf der Seite (AK5).
  await expect(page.locator('.journal-search')).toHaveCount(0);

  // Die Lupe sitzt in der Augenbrauenzeile (issue #928 AK1, zuvor in der
  // Titelzeile) und ist ein 44×44-Tap-Ziel.
  const toggle = page
    .locator('.journal-page__eyebrow-row')
    .getByRole('button', { name: 'Journal durchsuchen' });
  await expect(toggle).toBeVisible();
  const box = (await toggle.boundingBox())!;
  expect(box).not.toBeNull();
  expect(Math.round(box.width)).toBe(44);
  expect(Math.round(box.height)).toBe(44);

  // Klick öffnet den Suchmodus mit sichtbarem Suchfeld; die Lupe verschwindet,
  // solange der Modus offen ist (AK6: dort nur Suchfeld, „Abbrechen", Treffer).
  await toggle.click();
  await expect(page.locator('.journal-search__input')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Journal durchsuchen' })).toHaveCount(0);
});

test('issue #928 AK4: die Augenbrauenzeile behält ihre Höhe, wenn die Lupe im Suchmodus verschwindet', async ({
  page,
}) => {
  await setUpEditor(page);

  const eyebrowRow = page.locator('.journal-page__eyebrow-row');
  const beforeBox = (await eyebrowRow.boundingBox())!;
  expect(beforeBox).not.toBeNull();

  await openSearch(page);
  await expect(page.locator('.journal-search__input')).toBeVisible();

  const afterBox = (await eyebrowRow.boundingBox())!;
  expect(afterBox).not.toBeNull();
  expect(afterBox.height).toBe(beforeBox.height);
});

test('AK6: im Suchmodus kein FAB; jeder Treffer trägt volles Datum + Zeit und hebt das Suchwort hervor', async ({
  page,
}) => {
  await setUpEditor(page);
  // 2026-08-08 ist ein Samstag — deckt das AK6-Beispiel „Sa. 8. August" ab.
  await seedEntry(page, '2026-08-08', { text: 'Ein Lauf am Samstag', tags: [] });

  const fab = page.getByRole('button', { name: 'Eintragen', exact: true });
  await expect(fab).toBeVisible();

  await openSearch(page);
  // AK6: im Suchmodus gibt es keinen FAB.
  await expect(fab).toHaveCount(0);

  await page.getByLabel('Journal durchsuchen').fill('lauf');
  const result = page.locator('.journal-search__result').first();

  // Volles, ausgeschriebenes Datum + Uhrzeit (AK6): Wochentag kurz (Intl liefert
  // ihn mit Komma), Tag numerisch, Monat lang, " · ", Zeit.
  await expect(result.locator('.journal-search__result-date')).toHaveText(
    /^Sa\., 8\. August · \d{2}:\d{2}$/,
  );

  // Das Suchwort ist im Snippet als eigenes Element hervorgehoben (AK6).
  await expect(result.locator('.journal-search__hl')).toHaveText(/lauf/i);

  // „Abbrechen" verlässt den Suchmodus und stellt FAB + Strom wieder her.
  await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  await expect(fab).toBeVisible();
  await expect(page.locator('.journal-search')).toHaveCount(0);
});

test('issue #847 AK1: die Lupe zeigt ohne jede Eingabe sofort alle Einträge, neuester zuerst', async ({
  page,
}) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-01', { text: 'Alter Eintrag', tags: [] });
  await seedEntry(page, '2026-07-02', { text: 'Neuerer Eintrag', tags: [] });

  await openSearch(page);
  await expect(page.getByLabel('Journal durchsuchen')).toHaveValue('');

  // Weder Enter noch das Filter-Menü nötig — die Liste steht sofort.
  const results = page.locator('.journal-search__result');
  await expect(results).toHaveCount(2);
  await expect(results).toContainText(['Neuerer Eintrag', 'Alter Eintrag']);
});

test('issue #847 AK2: Leeren des Suchfelds stellt die volle Liste wieder her statt in die leere Ansicht zurückzufallen', async ({
  page,
}) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-01', { text: 'Ruhiger Lauf', tags: [] });
  await seedEntry(page, '2026-07-02', { text: 'Büro-Tag', tags: [] });

  await openSearch(page);
  const search = page.getByLabel('Journal durchsuchen');
  const results = page.locator('.journal-search__result');
  await expect(results).toHaveCount(2);

  await search.fill('lauf');
  await expect(results).toHaveCount(1);

  await search.fill('');
  await expect(results).toHaveCount(2);
  await expect(results).toContainText(['Büro-Tag', 'Ruhiger Lauf']);
});

test('issue #847 AK3: „Keine Treffer." erscheint nur bei einer echten Nulltreffer-Suche, nie bei leerem Feld', async ({
  page,
}) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-01', { text: 'Ein Eintrag', tags: [] });

  await openSearch(page);
  await expect(page.locator('.journal-search__empty')).toHaveCount(0);

  await page.getByLabel('Journal durchsuchen').fill('nichtvorhandenesding');
  await expect(page.locator('.journal-search__empty')).toBeVisible();
});

test('issue #847 AK3: ein Journal ganz ohne Einträge zeigt beim Öffnen der Suche kein „Keine Treffer."', async ({
  page,
}) => {
  await setUpEditor(page);

  await openSearch(page);
  await expect(page.locator('.journal-search__result')).toHaveCount(0);
  await expect(page.locator('.journal-search__empty')).toHaveCount(0);
});

test('issue #847 AK4: „Abbrechen" und erneutes Öffnen zeigen ein zurückgesetztes, geschlossenes Suchfeld mit voller Liste', async ({
  page,
}) => {
  await setUpEditor(page);
  await seedEntry(page, '2026-07-01', { text: 'Eintrag A', mood: '5', tags: ['sport'] });
  await seedEntry(page, '2026-07-02', { text: 'Eintrag B', tags: [] });

  await openSearch(page);
  await page.getByLabel('Journal durchsuchen').fill('eintrag a');
  await openFilters(page);
  const moodFilter = page.locator('.journal-search__mood-filter');
  await moodFilter.getByRole('button', { name: 'Stimmung 5 filtern', exact: true }).click();

  await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  await openSearch(page);

  await expect(page.getByLabel('Journal durchsuchen')).toHaveValue('');
  await expect(page.locator('.journal-search__filters')).toHaveCount(0);
  const results = page.locator('.journal-search__result');
  await expect(results).toHaveCount(2);
});

test('issue #847 AK5: „Abbrechen" ist ein randloser Textknopf in Akzentfarbe mit 44px Tap-Ziel', async ({
  page,
}) => {
  await setUpEditor(page);
  await openSearch(page);

  const cancel = page.getByRole('button', { name: 'Abbrechen', exact: true });
  const lightStyles = await cancel.evaluate((el) => {
    const computed = getComputedStyle(el);
    return { borderWidth: computed.borderWidth, backgroundColor: computed.backgroundColor, color: computed.color };
  });
  expect(lightStyles.borderWidth).toBe('0px');
  expect(['rgba(0, 0, 0, 0)', 'transparent']).toContain(lightStyles.backgroundColor);

  // Farbe kommt aus --accent, nicht aus einer festen Farbe (probe-Element mit
  // demselben Custom Property, gleiche Technik wie AC7 unten) — angehängt
  // innerhalb von .journal-search, damit es denselben [data-module='journal']
  // -Scope erbt, der --accent auf das Journal-Violett umbiegt (journal-page.css).
  const accentColor = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.color = 'var(--accent)';
    document.querySelector('.journal-search')!.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });
  expect(lightStyles.color).toBe(accentColor);

  const box = (await cancel.boundingBox())!;
  expect(box).not.toBeNull();
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);

  // Dark Mode (AK8): --accent ändert sich zwischen den Themes (tokens.css),
  // die Textfarbe des Knopfs folgt.
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const darkColor = await cancel.evaluate((el) => getComputedStyle(el).color);
  expect(darkColor).not.toBe(lightStyles.color);
});

test('issue #847 AK6: bei 375px bleibt das Suchfeld mindestens 200px breit und die Zeile einzeilig', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await setUpEditor(page);
  await openSearch(page);

  const input = page.locator('.journal-search__input');
  const filterToggle = page.getByRole('button', { name: 'Filter', exact: true });
  const cancel = page.getByRole('button', { name: 'Abbrechen', exact: true });

  const inputBox = (await input.boundingBox())!;
  const filterBox = (await filterToggle.boundingBox())!;
  const cancelBox = (await cancel.boundingBox())!;
  expect(inputBox.width).toBeGreaterThanOrEqual(200);

  // Einzeilig: alle drei Elemente liegen auf derselben Höhe, kein Umbruch.
  expect(Math.abs(inputBox.y - filterBox.y)).toBeLessThan(2);
  expect(Math.abs(inputBox.y - cancelBox.y)).toBeLessThan(2);

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
});
