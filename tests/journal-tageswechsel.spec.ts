import { expect, test, type Page } from '@playwright/test';
import { FIXED_NOW, installClockAt, registerPasskey, resetAppData, withDb } from './helpers';

/**
 * Tageswechsel im Journal (issue #1050): Wisch, Chevrons, Pfeiltasten — dieselbe
 * Pointer-Events-Geste, dieselbe Schwelle und derselbe Rückstoß wie
 * weather-day.spec.ts (issue #267), gegen `.journal-day-pager` statt
 * `.weather-day-screen`. FIXED_NOW (helpers.ts) ist Samstag, 18. Juli 2026 —
 * mittags UTC, damit "heute" in jeder realistischen Maschinen-Zeitzone
 * derselbe Kalendertag bleibt.
 */

const PASSPHRASE = 'tageswechsel passphrase';
const TODAY_KEY = '2026-07-18';
const YESTERDAY_KEY = '2026-07-17';
const TODAY_LABEL = 'Samstag, 18. Juli';
const YESTERDAY_LABEL = 'Freitag, 17. Juli';

async function setUpEditor(page: Page): Promise<void> {
  await installClockAt(page, FIXED_NOW);
  await registerPasskey(page, '/journal');
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByLabel('Passphrase wiederholen').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Einrichten' }).click();
  await page.getByTestId('journal-recovery-key').waitFor();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();
}

async function openSheet(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Eintragen', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Eintragen' })).toBeVisible();
}

async function submit(page: Page): Promise<void> {
  await page.getByRole('dialog', { name: 'Eintragen' }).locator('.sheet__action').click();
  await expect(page.getByRole('dialog', { name: 'Eintragen' })).toBeHidden();
}

function eyebrowDate(page: Page) {
  return page.locator('.journal-page__day-nav-date');
}

function previousButton(page: Page) {
  return page.getByRole('button', { name: 'Vorheriger Tag' });
}

function nextButton(page: Page) {
  return page.getByRole('button', { name: 'Nächster Tag' });
}

async function entryCountInDb(entryDate: string): Promise<number> {
  const rows = await withDb((client) =>
    client.query('SELECT count(*)::int AS n FROM journal_entries WHERE entry_date = $1', [entryDate]),
  );
  return rows.rows[0].n as number;
}

test.beforeEach(async () => {
  await resetAppData();
});

/* -------------------------------------------------------------------------- */
/* AK7: leerer Tag zeigt das leere Zeilenfeld; ein Eintrag landet auf dem     */
/* gezeigten Tag, nicht auf heute                                             */
/* -------------------------------------------------------------------------- */

test('AK7: ein auf einem älteren Tag angelegter Eintrag landet auf diesem Tag, nicht auf heute', async ({ page }) => {
  await setUpEditor(page);

  await previousButton(page).click();
  await expect(eyebrowDate(page)).toHaveText(YESTERDAY_LABEL);

  await openSheet(page);
  await page.getByLabel('Journal-Text').fill('Auf gestern geschrieben');
  await submit(page);

  await expect(page.locator('.journal-day-card__line')).toHaveText('Auf gestern geschrieben');

  await nextButton(page).click();
  await expect(eyebrowDate(page)).toHaveText(TODAY_LABEL);
  await expect(page.locator('.journal-day-card--empty')).toBeVisible();

  // Server-Sync ist sonst passiv (alle 30s) — explizit anstoßen, statt auf das
  // Intervall zu warten (Muster wie jede andere withDb()-Prüfung in journal.spec.ts).
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => entryCountInDb(YESTERDAY_KEY)).toBe(1);
  expect(await entryCountInDb(TODAY_KEY)).toBe(0);
});
