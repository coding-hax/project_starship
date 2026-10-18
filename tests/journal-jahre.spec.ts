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
  await registerPasskey(page, '/journal');
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
