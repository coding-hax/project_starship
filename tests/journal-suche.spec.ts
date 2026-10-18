import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData } from './helpers';

/**
 * S4 of #302 (issue #341): local full-text search over already-decrypted journal
 * entries. Owner decision "3a" in #301 — decrypt on load, scan in memory, no
 * on-disk index — drives AC2 below. Builds on the real editor (S3b, #340).
 *
 * issue #376/ADR-0018: a day can carry any number of entries — a result is one
 * entry, not a day, sorted and shown with date AND time.
 *
 * issue #1051 restructured the search UI: a pill in the eyebrow (AK1), three
 * filter chips in the header's `extra` slot instead of a single "Filter"
 * toggle (AK2/AK3), and results grouped by year with a new row shape
 * (AK4/AK5). Tests below carrying an old AC/issue name were adapted where the
 * UI they pinned moved; tests named "AKn (#1051)" cover this ticket's own
 * criteria directly.
 */

test.beforeEach(async () => {
  await resetAppData();
});

const SEARCH_PASSPHRASE = 's4 suche passphrase';

/** Same wait-for-settled-state reasoning as journal.spec.ts's setUpEditor. */
async function setUpEditor(page: Page, passphrase = SEARCH_PASSPHRASE): Promise<void> {
  await registerPasskey(page, '/journal');
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('Passphrase wiederholen').fill(passphrase);
  await page.getByRole('button', { name: 'Einrichten' }).click();
  await page.getByTestId('journal-recovery-key').waitFor();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();
}

/** issue #700 AK5: das Suchfeld ist nicht mehr dauerhaft sichtbar — die Lupe in
 * der Titelzeile öffnet erst den Suchmodus. Die Lupe ist ein Button mit der
 * `aria-label` „Journal durchsuchen"; das Suchfeld trägt dieselbe Beschriftung,
 * beide stehen aber nie gleichzeitig im DOM (die Lupe verschwindet im
 * Suchmodus), daher bleibt der Button-Zugriff eindeutig. */
async function openSearch(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Journal durchsuchen' }).click();
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
