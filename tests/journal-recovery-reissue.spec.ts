import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, withDb } from './helpers';

/**
 * Issue #391: der Recovery-Key aus #343/#372 wird nach dem Setup nie wieder
 * angezeigt. Diese Specs decken das Neu-Ausstellen aus den Journal-Einstellungen
 * ab (Plan-Kommentar an #391): entsperrt stellt neu aus, der alte Key wird dabei
 * ungültig, gesperrt bietet keinen Zugang.
 */

const PASSPHRASE = 'ac391 passphrase';

test.beforeEach(async () => {
  await resetAppData();
});

/** Setup, confirming the one-time recovery-key screen. Returns the key shown. */
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

/**
 * Client-side navigation to /einstellungen (issue #339/#391 pattern, see
 * journal-lock.spec.ts AC5) — `page.goto` is a hard reload that drops the
 * in-memory DEK (module variable, ADR-0016) before the settings panel ever
 * sees `unlocked`. Einstellungen has no main-nav tab (issue #126), so the
 * only client-side path is via Übersicht's inline entry point.
 */
async function goToSettings(page: Page) {
  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await nav.getByRole('link', { name: 'Übersicht' }).click();
  await page.getByRole('link', { name: 'Einstellungen' }).click();
  await expect(page).toHaveURL(/\/einstellungen$/);
}

/** Drives the settings panel's reissue flow end to end, returns the new key. */
async function reissueRecovery(page: Page, passphrase: string): Promise<string> {
  await goToSettings(page);
  await page.getByRole('button', { name: 'Neu ausstellen' }).click();
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Neu ausstellen' }).click();
  const code = page.getByTestId('journal-recovery-key');
  await code.waitFor();
  const key = (await code.textContent())!.trim();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
  return key;
}

async function unlockWithRecovery(page: Page, recoveryKey: string) {
  await page.getByRole('button', { name: 'Mit Wiederherstellungsschlüssel entsperren' }).click();
  await page.getByLabel('Wiederherstellungsschlüssel').fill(recoveryKey);
  await page.getByRole('button', { name: 'Entsperren', exact: true }).click();
}

async function journalKeysRow() {
  const result = await withDb((client) =>
    client.query('SELECT envelope, recovery_envelope FROM journal_keys'),
  );
  return result.rows[0] as { envelope: unknown; recovery_envelope: unknown } | undefined;
}

test('entsperrt stellt einen neuen Recovery-Key aus, der vom Setup-Key abweicht', async ({
  page,
}) => {
  const setupKey = await setUpJournal(page, PASSPHRASE);

  const newKey = await reissueRecovery(page, PASSPHRASE);
  expect(newKey).toMatch(/^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/);
  expect(newKey).not.toBe(setupKey);
  await expect(page.getByTestId('journal-recovery-key')).toHaveCount(0);

  await page.goto('/journal');
  await page.reload();
  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();

  await unlockWithRecovery(page, newKey);
  await expect(page.locator('.journal-gate[data-state="unlocked"]')).toBeVisible();
});

test('der alte Recovery-Key wird nach dem Neu-Ausstellen ungueltig', async ({ page }) => {
  const setupKey = await setUpJournal(page, PASSPHRASE);
  await reissueRecovery(page, PASSPHRASE);

  await page.goto('/journal');
  await page.reload();
  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();

  await unlockWithRecovery(page, setupKey);
  await expect(page.getByRole('status')).toBeVisible();
  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();
});

test('gesperrt bietet keinen Zugang zum Recovery-Key', async ({ page }) => {
  await setUpJournal(page, PASSPHRASE);
  await page.evaluate(() => window.__starship.journalLock());
  await goToSettings(page);

  await expect(page.getByTestId('journal-recovery-key')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Neu ausstellen' })).toHaveCount(0);
  await expect(page.getByText('Entsperre zuerst das Journal')).toBeVisible();
});

test('Regel 9: der Recovery-Key landet in keinem Log, nur die Huelle aendert sich', async ({
  page,
}) => {
  const setupKey = await setUpJournal(page, PASSPHRASE);
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  const before = await journalKeysRow();

  const logs: string[] = [];
  page.on('console', (msg) => logs.push(msg.text()));

  const newKey = await reissueRecovery(page, PASSPHRASE);

  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  const after = await journalKeysRow();

  expect(JSON.stringify(after!.envelope)).toBe(JSON.stringify(before!.envelope));
  expect(JSON.stringify(after!.recovery_envelope)).not.toBe(
    JSON.stringify(before!.recovery_envelope),
  );

  const logged = logs.join('\n');
  expect(logged).not.toContain(setupKey);
  expect(logged).not.toContain(newKey);
});

test('Offline (DoD): offline neu ausgestellt geht in die Outbox, online synct es', async ({
  page,
  context,
}) => {
  await setUpJournal(page, PASSPHRASE);
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  await context.setOffline(true);
  const newKey = await reissueRecovery(page, PASSPHRASE);
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  expect(await journalKeysRow()).toBeDefined();

  await page.goto('/journal');
  await page.reload();
  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();
  await unlockWithRecovery(page, newKey);
  await expect(page.locator('.journal-gate[data-state="unlocked"]')).toBeVisible();
});

for (const viewport of [
  { width: 375, height: 667 },
  { width: 1280, height: 800 },
]) {
  test(`Neu-Ausstellen funktioniert bei ${viewport.width}px, Dark Mode und reduced motion`, async ({
    page,
  }) => {
    await setUpJournal(page, PASSPHRASE);
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await goToSettings(page);

    await page.getByRole('button', { name: 'Neu ausstellen' }).click();
    await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
    await page.getByRole('button', { name: 'Neu ausstellen' }).click();

    const code = page.getByTestId('journal-recovery-key');
    await expect(code).toBeVisible();
    await expect(code).toHaveCSS('font-family', /monospace/);

    await expect(page.locator('.journal-settings-panel__message')).toHaveCount(0);
  });
}
