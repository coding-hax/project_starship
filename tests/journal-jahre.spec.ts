import { expect, test, type Page } from '@playwright/test';
import { installClockAt, registerPasskey, resetAppData } from './helpers';

/**
 * Issue #1049 (Teil von #1046): „An diesem Tag" unter der Zeile des Tages
 * (#1048) — jeder andere Jahrgang mit einem Eintrag am selben Monat+Tag.
 * `installClockAt(page)` ohne Argument pinnt den 18.07.2026 (FIXED_NOW,
 * helpers.ts), also „heute" für die meisten Tests hier; AK7/AK8 pinnen ihre
 * eigene Uhr.
 */

test.beforeEach(async () => {
  await resetAppData();
});

const PASSPHRASE = '1049 jahre passphrase';

/** Wie setUpEditor in journal.spec.ts: Setup-Formular auf /journal, endet
 * entsperrt — von hier aus laufen Seeds direkt über den echten Schreibpfad
 * (window.__starship.appendJournalEntry), nie eine Test-Fake-Zeile. */
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

async function seedEntry(
  page: Page,
  entryDate: string,
  text: string,
  options: { mood?: string } = {},
): Promise<void> {
  await page.evaluate(
    ({ entryDate, text, mood }) => window.__starship.appendJournalEntry(entryDate, { text, tags: [], mood }),
    { entryDate, text, mood: options.mood },
  );
}

test('AK1: „An diesem Tag" listet jeden anderen Jahrgang mit Eintrag am selben Kalendertag, neueste zuerst, ohne obere Grenze', async ({
  page,
}) => {
  await installClockAt(page);
  await setUpEditor(page);

  await seedEntry(page, '2025-07-18', 'Vor einem Jahr');
  await seedEntry(page, '2019-07-18', 'Vor sieben Jahren');
  await seedEntry(page, '2009-07-18', 'Vor 17 Jahren');

  const years = page.locator('.journal-same-day__year');
  await expect(years).toHaveCount(3);
  await expect(years).toHaveText(['2025', '2019', '2009']);
});

test('AK2: Jahre ohne Eintrag an diesem Kalendertag erscheinen nicht, auch wenn sie an einem anderen Tag geschrieben haben', async ({
  page,
}) => {
  await installClockAt(page);
  await setUpEditor(page);

  await seedEntry(page, '2025-07-18', 'Trifft den Tag');
  await seedEntry(page, '2024-03-01', 'Anderer Tag, anderes Jahr');

  await expect(page.locator('.journal-same-day__year')).toHaveText(['2025']);
});

test('AK3: eine Zeile trägt Jahr, Abstand in Worten, die zuerst angelegte Notiz jenes Tages und den Stimmungspunkt — ohne Stimmung kein Punkt', async ({
  page,
}) => {
  await installClockAt(page);
  await setUpEditor(page);

  await seedEntry(page, '2020-07-18', 'Morgens geschrieben', { mood: '8' });
  await seedEntry(page, '2020-07-18', 'Abends geschrieben');
  await seedEntry(page, '2009-07-18', 'Ohne Stimmung');

  const rows = page.locator('.journal-same-day__row');
  await expect(rows).toHaveCount(2);

  const row2020 = rows.filter({ has: page.locator('.journal-same-day__year', { hasText: '2020' }) });
  await expect(row2020.locator('.journal-same-day__distance')).toHaveText('vor sechs Jahren');
  await expect(row2020.locator('.journal-same-day__line')).toHaveText('Morgens geschrieben');
  await expect(row2020.locator('.journal-same-day__mood')).toHaveText('8');

  const row2009 = rows.filter({ has: page.locator('.journal-same-day__year', { hasText: '2009' }) });
  await expect(row2009.locator('.journal-same-day__line')).toHaveText('Ohne Stimmung');
  await expect(row2009.locator('.journal-same-day__mood')).toHaveCount(0);
});

test('AK4: der Abschnittskopf zeigt die Anzahl — Mehrzahl mit Ziffer, ein Treffer als „ein Jahr"', async ({
  page,
}) => {
  await installClockAt(page);
  await setUpEditor(page);

  await seedEntry(page, '2025-07-18', 'Eins');
  await expect(page.locator('.journal-same-day__count')).toHaveText('ein Jahr');

  await seedEntry(page, '2024-07-18', 'Zwei');
  await seedEntry(page, '2023-07-18', 'Drei');
  await seedEntry(page, '2022-07-18', 'Vier');
  await expect(page.locator('.journal-same-day__count')).toHaveText('4 Jahre');
  await expect(page.locator('.journal-same-day__eyebrow')).toHaveText('An diesem Tag');
});

test('AK5: ohne ein anderes Jahr mit Eintrag fehlt der ganze Abschnitt — kein leerer Rahmen', async ({ page }) => {
  await installClockAt(page);
  await setUpEditor(page);

  await expect(page.locator('.journal-same-day')).toHaveCount(0);

  // Auch ein Eintrag an einem anderen Tag desselben (anderen) Jahres genügt
  // nicht — erst ein Treffer am selben Monat+Tag lässt den Abschnitt entstehen.
  await seedEntry(page, '2024-01-05', 'Anderer Tag');
  await expect(page.locator('.journal-same-day')).toHaveCount(0);
});

test('AK6: „An diesem Tag" startet keinen dritten Entschlüsselungslauf — es liest denselben Sitzungs-Cache wie die Suche', async ({
  page,
}) => {
  await installClockAt(page);
  await setUpEditor(page);

  // Zwei Hooks abonnieren beim Mount dieselbe journal_entries-Tabelle: die
  // Tageskarte (use-journal-entries.ts) und der geteilte Suche/Jahresliste-
  // Cache (use-journal-search-entries.ts, in journal-editor.tsx hochgezogen)
  // — je ein initialer liveQuery-Callback macht das 2.
  await expect
    .poll(() => page.evaluate(() => window.__starship.debugJournalDecryptRunCount()))
    .toBe(2);

  await seedEntry(page, '2025-07-18', 'Vor einem Jahr');

  // Ein journal_entries-Schreibvorgang löst genau einen weiteren Callback je
  // Hook aus — +2, nicht +3. Ein dritter, eigener useJournalSearchEntries()-
  // Aufruf in der Jahresliste würde hier +3 zeigen.
  await expect
    .poll(() => page.evaluate(() => window.__starship.debugJournalDecryptRunCount()))
    .toBe(4);
  await expect(page.locator('.journal-same-day__row')).toHaveCount(1);
});

test('AK7: der 29. Februar zeigt nur andere Schalttage, kein Ausweichen auf den 28.', async ({ page }) => {
  await installClockAt(page, '2024-02-29T12:00:00.000Z'); // 2024 ist ein Schaltjahr
  await setUpEditor(page);

  await seedEntry(page, '2020-02-29', 'Vorheriger Schalttag'); // 2020 ebenfalls Schaltjahr
  await seedEntry(page, '2023-02-28', 'Kein Schalttag, falscher Tag');

  await expect(page.locator('.journal-same-day__year')).toHaveText(['2020']);
});

test('AK8: der Tagesschlüssel wird gerätelokal gebildet, nicht über die UTC-basierte toISOString-Uhrzeit', async ({
  browser,
}) => {
  // Westlich von Greenwich, kurz vor Mitternacht lokal ist es in UTC bereits
  // der nächste Kalendertag — toISOString() würde hier auf den falschen (zu
  // frühen) Jahresvergleich verrutschen.
  const context = await browser.newContext({ timezoneId: 'Pacific/Honolulu' });
  const page = await context.newPage();
  try {
    // 2026-08-15 23:50 in Honolulu (UTC-10) = 2026-08-16 09:50 UTC.
    await installClockAt(page, '2026-08-16T09:50:00.000Z');
    await setUpEditor(page);

    await seedEntry(page, '2025-08-15', 'Lokal gestern Nacht, nicht UTC-morgen');

    await expect(page.locator('.journal-same-day__year')).toHaveText(['2025']);
    await expect(page.locator('.journal-same-day__distance')).toHaveText('vor einem Jahr');
  } finally {
    await context.close();
  }
});

test('AK9: mobil (375×812) sichtbar, Dark Mode nutzt eine tatsächlich andere Fläche', async ({ page }) => {
  await installClockAt(page);
  await setUpEditor(page);
  await seedEntry(page, '2025-07-18', 'Für Dark Mode');

  const section = page.locator('.journal-same-day');
  await expect(section).toBeVisible();
  const box = await section.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);

  const lightBg = await section.evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.emulateMedia({ colorScheme: 'dark' });
  const darkBg = await section.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(darkBg).not.toBe(lightBg);
});
