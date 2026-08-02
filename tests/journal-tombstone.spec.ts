import { expect, test, type Browser, type Page } from '@playwright/test';
import { openSecondDevice, registerPasskey, resetAppData, withDb } from './helpers';

/**
 * Issue #453: a tombstone on the one row that carries the account's key material.
 *
 * Observed in production on 02.08.26 — the only soft-deleted row in the whole
 * database, and it made the journal unusable in a way that hid itself: the gate
 * read the deleted row as "no envelope", offered a fresh setup on every cold
 * start, and `resolveDeletedAt` keeps an existing `deletedAt` for an `upsert`
 * (src/local/conflict.ts), so each new passphrase went straight back into the
 * grave. Every round minted a new DEK and orphaned the entries written under the
 * previous one. Nine entries survived on the server that nothing could decrypt.
 *
 * One Playwright test per acceptance criterion.
 */

const PASSPHRASE = 'ac453 passphrase';
const OTHER_PASSPHRASE = 'eine voellig andere passphrase';
/** Mirrors JOURNAL_KEYS_ROW_ID in src/features/journal/journal-keys.ts. */
const JOURNAL_KEYS_ROW_ID = '3f2a9b6e-9d3c-4f7a-8b2e-6b1c9a4d7e05';

test.beforeEach(async () => {
  await resetAppData();
});

async function setUpJournal(page: Page, passphrase: string) {
  await registerPasskey(page);
  await page.goto('/journal');
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('Passphrase wiederholen').fill(passphrase);
  await page.getByRole('button', { name: 'Einrichten' }).click();
  await page.getByTestId('journal-recovery-key').waitFor();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();
}

async function flush(page: Page) {
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
}

async function keyRow() {
  const result = await withDb((client) =>
    client.query('SELECT deleted_at, envelope, recovery_envelope FROM journal_keys WHERE id = $1', [
      JOURNAL_KEYS_ROW_ID,
    ]),
  );
  return result.rows[0] as
    | { deleted_at: Date | null; envelope: unknown; recovery_envelope: unknown }
    | undefined;
}

/** The state the bug left behind: the row is deleted, both wraps are still in it. */
async function tombstoneKeyRow(page: Page) {
  await page.evaluate(
    (rowId) => window.__starship.mutate({ table: 'journal_keys', rowId, op: 'delete' }),
    JOURNAL_KEYS_ROW_ID,
  );
  await flush(page);
  const row = await keyRow();
  expect(row?.deleted_at).not.toBeNull();
  expect(row?.envelope).not.toBeNull();
}

/** A cold start: same account and session, empty IndexedDB, pulls from scratch. */
async function coldStart(browser: Browser, page: Page): Promise<Page> {
  const device = await openSecondDevice(browser, page);
  await device.goto('/journal');
  return device;
}

test('AC1: Kaltstart auf einer geloeschten Schluesselzeile zeigt gesperrt, nie einrichten', async ({
  browser,
  page,
}) => {
  await setUpJournal(page, PASSPHRASE);
  await flush(page);
  await tombstoneKeyRow(page);

  const device = await coldStart(browser, page);

  await expect(device.locator('.journal-gate[data-state="locked"]')).toBeVisible();
  await expect(device.locator('.journal-gate[data-state="setup"]')).toHaveCount(0);
});

test('AC2: die bestehende Passphrase entsperrt weiterhin, Eintraege bleiben lesbar', async ({
  browser,
  page,
}) => {
  await setUpJournal(page, PASSPHRASE);
  const entryDate = await page.evaluate(() => new Date().toLocaleDateString('en-CA'));
  await page.evaluate(
    (date) => window.__starship.appendJournalEntry(date, { text: 'vor dem Tombstone' }),
    entryDate,
  );
  await flush(page);
  await tombstoneKeyRow(page);

  const device = await coldStart(browser, page);
  await device.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await device.getByRole('button', { name: 'Entsperren', exact: true }).click();
  await expect(device.locator('.journal-gate[data-state="unlocked"]')).toBeVisible();

  // Derselbe DEK, nicht ein neu erzeugter: sonst waere der Eintrag nicht zu entschluesseln.
  const entries = await device.evaluate(
    (date) => window.__starship.listJournalEntries(date),
    entryDate,
  );
  expect(entries.map((entry) => entry.content.text)).toContain('vor dem Tombstone');
});

test('AC3: der Start heilt den Tombstone, ohne dass jemand ihn anstoesst', async ({
  browser,
  page,
}) => {
  await setUpJournal(page, PASSPHRASE);
  await flush(page);
  await tombstoneKeyRow(page);

  const device = await coldStart(browser, page);
  await expect(device.locator('.journal-gate[data-state="locked"]')).toBeVisible();

  // Kein flush(): der Lauf beweist genau dann etwas, wenn die App den Push von sich
  // aus anstoesst. Beide Wraps muessen die Reparatur unveraendert ueberstehen — sie
  // raeumt nur das deleted_at weg.
  const before = await keyRow();
  await expect.poll(async () => (await keyRow())?.deleted_at).toBeNull();
  const after = await keyRow();
  expect(after?.envelope).toEqual(before?.envelope);
  expect(after?.recovery_envelope).toEqual(before?.recovery_envelope);
});

test('AC4: Einrichten wird auf einer geloeschten Zeile verweigert, beide Wraps bleiben stehen', async ({
  page,
}) => {
  await setUpJournal(page, PASSPHRASE);
  await flush(page);
  await tombstoneKeyRow(page);
  const before = await keyRow();

  // Direkt am Automaten vorbei am UI: der Riegel darf nicht daran haengen, dass der
  // Einrichten-Screen ohnehin nicht mehr erscheint (AC1).
  const recoveryKey = await page.evaluate(
    (passphrase) => window.__starship.journalSetup(passphrase),
    OTHER_PASSPHRASE,
  );
  expect(recoveryKey).toBeNull();

  await flush(page);
  const after = await keyRow();
  expect(after?.envelope).toEqual(before?.envelope);
  expect(after?.recovery_envelope).toEqual(before?.recovery_envelope);
});

test('AC5: ohne Schluesselzeile bleibt der Einrichten-Weg, und er legt eine lebende Zeile an', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/journal');

  await expect(page.locator('.journal-gate[data-state="setup"]')).toBeVisible();

  await setUpJournal(page, PASSPHRASE);
  await flush(page);

  const row = await keyRow();
  expect(row?.deleted_at).toBeNull();
  expect(row?.envelope).not.toBeNull();
});
