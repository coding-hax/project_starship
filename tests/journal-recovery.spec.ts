import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, withDb } from './helpers';

/**
 * Issue #372: wires up the recovery kit from #343 — both KEK wraps at setup,
 * the one-time key display, a second unlock path, and an optional passphrase
 * rewrap that keeps the DEK. One Playwright test per acceptance criterion.
 */

const PASSPHRASE = 'ac372 passphrase';
const WRONG_PASSPHRASE = 'falsches passwort';
const WRONG_RECOVERY_KEY = 'definitely-not-the-recovery-key-0000';

test.beforeEach(async () => {
  await resetAppData();
});

/** Setup, confirming the one-time recovery-key screen. Returns the key shown,
 * so callers can use it for a later recovery unlock. */
async function setUpJournal(page: Page, passphrase: string): Promise<string> {
  await registerPasskey(page);
  await page.goto('/journal');
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('Passphrase wiederholen').fill(passphrase);
  await page.getByRole('button', { name: 'Einrichten' }).click();
  const code = page.getByTestId('journal-recovery-key');
  await code.waitFor();
  const recoveryKey = (await code.textContent())!.trim();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();
  return recoveryKey;
}

async function todayKey(page: Page): Promise<string> {
  return page.evaluate(() => new Date().toLocaleDateString('en-CA'));
}

async function journalKeysRow() {
  const result = await withDb((client) =>
    client.query('SELECT envelope, recovery_envelope FROM journal_keys'),
  );
  return result.rows[0] as { envelope: unknown; recovery_envelope: unknown } | undefined;
}

test('AC1: Ersteinrichtung erzeugt beide KEK-Wraps', async ({ page }) => {
  await setUpJournal(page, PASSPHRASE);

  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await journalKeysRow();
  expect(row).toBeDefined();
  expect(row!.envelope).not.toBeNull();
  expect(row!.recovery_envelope).not.toBeNull();
});

test('AC2: Recovery-Key wird genau einmal angezeigt, gruppiert, erst nach Bestaetigung geht es weiter', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/journal');
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByLabel('Passphrase wiederholen').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Einrichten' }).click();

  const code = page.getByTestId('journal-recovery-key');
  await expect(code).toBeVisible();
  const recoveryKey = (await code.textContent())!.trim();
  // 256 bit als gruppiertes base32 (ADR-0015 Punkt 2): 13 Gruppen von 4 Zeichen.
  expect(recoveryKey).toMatch(/^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/);

  // Vor der Bestaetigung bleibt der Editor verborgen.
  await expect(page.locator('.journal-gate[data-state="unlocked"]')).toHaveCount(0);

  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
  await expect(page.locator('.journal-gate[data-state="unlocked"]')).toBeVisible();
  await expect(page.getByTestId('journal-recovery-key')).toHaveCount(0);

  // Nach einem Reload ist der Key endgueltig weg, nie ein zweites Mal.
  await page.reload();
  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();
  await expect(page.getByTestId('journal-recovery-key')).toHaveCount(0);
});

test('AC3: zweiter Weg entsperrt mit dem korrekten Recovery-Key', async ({ page }) => {
  const recoveryKey = await setUpJournal(page, PASSPHRASE);
  await page.reload();
  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();

  await page.getByRole('button', { name: 'Mit Wiederherstellungsschlüssel entsperren' }).click();
  await page.getByLabel('Wiederherstellungsschlüssel').fill(recoveryKey);
  await page.getByRole('button', { name: 'Entsperren', exact: true }).click();

  await expect
    .poll(() => page.evaluate(() => window.__starship.journalLockState()))
    .toBe('unlocked');
});

test('AC4: nach Recovery-Unlock kann eine neue Passphrase gesetzt werden, der DEK bleibt gleich', async ({
  page,
}) => {
  const recoveryKey = await setUpJournal(page, PASSPHRASE);
  const entryDate = await todayKey(page);
  const entryText = 'ac4 text vor dem sperren';

  await page.evaluate(
    ({ entryDate, content }) => window.__starship.appendJournalEntry(entryDate, content),
    { entryDate, content: { text: entryText } },
  );
  await expect
    .poll(() =>
      page
        .evaluate(() => window.__starship.debugRecords())
        .then((records) => records.some((r) => r.table === 'journal_entries')),
    )
    .toBe(true);

  await page.reload();
  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();

  await page.getByRole('button', { name: 'Mit Wiederherstellungsschlüssel entsperren' }).click();
  await page.getByLabel('Wiederherstellungsschlüssel').fill(recoveryKey);
  await page.getByRole('button', { name: 'Entsperren', exact: true }).click();

  const NEW_PASSPHRASE = 'ac4 neue passphrase';
  await page.getByLabel('Neue Passphrase', { exact: true }).fill(NEW_PASSPHRASE);
  await page.getByLabel('Neue Passphrase wiederholen').fill(NEW_PASSPHRASE);
  await page.getByRole('button', { name: 'Festlegen' }).click();

  // (a) Derselbe DEK -- der vor dem Sperren geschriebene Eintrag bleibt lesbar.
  // Kein Autosave-Entwurffeld mehr, das den Text zeigen würde (issue #376,
  // ADR-0018) -- der Eintrag steht stattdessen in der Liste darunter.
  await expect(page.locator('.journal-gate[data-state="unlocked"]')).toBeVisible();
  await expect(page.locator('.journal-editor__entry')).toContainText(entryText);

  // (b) Reload: die neue Passphrase entsperrt, die alte gibt nur die ruhige Meldung.
  await page.reload();
  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();

  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Entsperren', exact: true }).click();
  await expect(page.getByRole('status')).toBeVisible();
  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();

  await page.getByLabel('Passphrase', { exact: true }).fill(NEW_PASSPHRASE);
  await page.getByRole('button', { name: 'Entsperren', exact: true }).click();
  await expect(page.locator('.journal-gate[data-state="unlocked"]')).toBeVisible();
});

test('AC5: falscher Recovery-Key ist von einer falschen Passphrase nicht zu unterscheiden', async ({
  page,
}) => {
  await setUpJournal(page, PASSPHRASE);
  await page.reload();
  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();

  await page.getByLabel('Passphrase', { exact: true }).fill(WRONG_PASSPHRASE);
  await page.getByRole('button', { name: 'Entsperren', exact: true }).click();
  const passphraseMessage = page.getByRole('status');
  await expect(passphraseMessage).toBeVisible();
  const passphraseText = await passphraseMessage.textContent();
  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();

  await page.getByRole('button', { name: 'Mit Wiederherstellungsschlüssel entsperren' }).click();
  await page.getByLabel('Wiederherstellungsschlüssel').fill(WRONG_RECOVERY_KEY);
  await page.getByRole('button', { name: 'Entsperren', exact: true }).click();
  const recoveryMessage = page.getByRole('status');
  await expect(recoveryMessage).toBeVisible();

  expect(await recoveryMessage.textContent()).toBe(passphraseText);
  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();
});

test('AC6: Warnsatz im Einrichten-Screen verweist auf den gleich angezeigten Key', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/journal');

  const setupForm = page.locator('.journal-gate[data-state="setup"]');
  await expect(setupForm).toContainText('Wiederherstellungsschlüssel');
  await expect(setupForm).not.toContainText('es gibt noch keine Wiederherstellung');
});

test('Offline (DoD): Ersteinrichtung offline schreibt lokal, sync bringt beide Huellen online an', async ({
  page,
  context,
}) => {
  await registerPasskey(page);
  await page.goto('/journal');
  await context.setOffline(true);

  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByLabel('Passphrase wiederholen').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Einrichten' }).click();
  await page.getByTestId('journal-recovery-key').waitFor();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
  await expect(page.locator('.journal-gate[data-state="unlocked"]')).toBeVisible();

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);
  expect(await journalKeysRow()).toBeUndefined();

  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await journalKeysRow();
  expect(row).toBeDefined();
  expect(row!.envelope).not.toBeNull();
  expect(row!.recovery_envelope).not.toBeNull();
});
