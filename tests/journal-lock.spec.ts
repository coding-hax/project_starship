import { expect, test, type Page } from '@playwright/test';
import { freezeClock, registerPasskey, resetAppData, withDb } from './helpers';

const PASSPHRASE = 'correct horse battery staple';
const WRONG_PASSPHRASE = 'falsches passwort';
/** Mirrors AUTO_LOCK_MS in src/features/journal/lock-store.ts. */
const AUTO_LOCK_MS = 15 * 60 * 1000;

test.beforeEach(async () => {
  await resetAppData();
});

/**
 * Waits for the resulting `unlocked` state, not just the click — `journalSetup()`
 * runs a PBKDF2 derivation plus an IndexedDB write after the button resolves.
 * A caller that reloads right after the click would race that in-flight write.
 */
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

async function journalKeyRowCount(): Promise<number> {
  const result = await withDb((client) => client.query('SELECT count(*)::int AS n FROM journal_keys'));
  return result.rows[0].n as number;
}

test('Ersteinrichtung erzeugt die Huelle und entsperrt sofort (AC1)', async ({ page }) => {
  await setUpJournal(page, PASSPHRASE);
  await expect(page.locator('.journal-gate[data-state="unlocked"]')).toBeVisible();

  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  expect(await journalKeyRowCount()).toBe(1);
});

test('gesperrt bleibt Uebersicht/Aufgaben/Gewohnheiten voll bedienbar (AC2)', async ({ page }) => {
  await setUpJournal(page, PASSPHRASE);
  await page.reload();
  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();

  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });

  await nav.getByRole('link', { name: 'Übersicht' }).click();
  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(page.getByRole('heading', { name: 'Übersicht', level: 1 })).toBeVisible();

  await nav.getByRole('link', { name: 'Aufgaben' }).click();
  await expect(page).toHaveURL(/\/aufgaben$/);
  await expect(page.getByRole('heading', { name: 'Aufgaben', level: 1 })).toBeVisible();

  await nav.getByRole('link', { name: 'Gewohnheiten' }).click();
  await expect(page).toHaveURL(/\/gewohnheiten$/);
});

test('richtige Passphrase entsperrt, falsche zeigt eine ruhige Meldung ohne Absturz (AC3)', async ({
  page,
}) => {
  await setUpJournal(page, PASSPHRASE);
  await page.reload();
  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();

  await page.getByLabel('Passphrase', { exact: true }).fill(WRONG_PASSPHRASE);
  await page.getByRole('button', { name: 'Entsperren' }).click();

  const message = page.getByRole('status');
  await expect(message).toBeVisible();
  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();

  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Entsperren' }).click();
  await expect(page.locator('.journal-gate[data-state="unlocked"]')).toBeVisible();
});

test('Default speicherresident: Kaltstart sperrt wieder (AC4)', async ({ page }) => {
  await setUpJournal(page, PASSPHRASE);
  await expect(page.locator('.journal-gate[data-state="unlocked"]')).toBeVisible();

  await page.reload();
  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();
});

test('Opt-in Default AUS, eingeschaltet ueberlebt den Neustart, Schluessel bleibt non-extractable (AC5)', async ({
  page,
}) => {
  await setUpJournal(page, PASSPHRASE);

  // A real client-side navigation (not page.goto, which is a hard reload that
  // would drop the in-memory DEK before the toggle ever gets a chance to
  // persist it) -- Übersicht first, then the settings entry point, exactly
  // like a tap through the app.
  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await nav.getByRole('link', { name: 'Übersicht' }).click();
  await page.getByRole('link', { name: 'Einstellungen' }).click();
  await expect(page).toHaveURL(/\/einstellungen$/);

  const toggle = page.getByRole('switch', { name: 'Auf diesem Gerät entsperrt lassen' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => page.evaluate(() => window.__starship.journalHasPersistedDek())).toBe(true);
  await expect(
    page.evaluate(() => window.__starship.journalPersistedDekExtractable()),
  ).resolves.toBe(false);

  await page.reload();
  await page.goto('/journal');
  await expect(page.locator('.journal-gate[data-state="unlocked"]')).toBeVisible();
});

test('Auto-Lock sperrt nach dem Inaktivitaetsfenster, Aktivitaet davor haelt es offen (AC6)', async ({
  page,
}) => {
  await page.clock.install({ time: new Date() });
  await setUpJournal(page, PASSPHRASE);
  await expect(page.locator('.journal-gate[data-state="unlocked"]')).toBeVisible();

  await freezeClock(page);
  await page.clock.fastForward(AUTO_LOCK_MS + 1_000);
  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();
});

test('Aktivitaet vor Ablauf des Fensters haelt das Journal entsperrt (AC6 Gegenprobe)', async ({
  page,
}) => {
  await page.clock.install({ time: new Date() });
  await setUpJournal(page, PASSPHRASE);
  await expect(page.locator('.journal-gate[data-state="unlocked"]')).toBeVisible();

  await freezeClock(page);
  await page.clock.fastForward(AUTO_LOCK_MS - 5_000);
  await page.keyboard.press('Shift');
  // Ohne den Reset durch die Aktivitaet waere das Fenster hier laengst um.
  await page.clock.fastForward(10_000);
  await expect(page.locator('.journal-gate[data-state="unlocked"]')).toBeVisible();
});

test('zweiter Tab ist automatisch entsperrt, journalLock sperrt beide (AC7)', async ({
  page,
  context,
}) => {
  await setUpJournal(page, PASSPHRASE);
  await expect(page.locator('.journal-gate[data-state="unlocked"]')).toBeVisible();

  const secondPage = await context.newPage();
  await secondPage.goto('/journal');
  await expect(secondPage.locator('.journal-gate[data-state="unlocked"]')).toBeVisible();

  await page.evaluate(() => window.__starship.journalLock());
  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();
  await expect(secondPage.locator('.journal-gate[data-state="locked"]')).toBeVisible();
});

test('Tokens/Dark Mode/reduced-motion fuer den Entsperr-Zustand (AC8)', async ({ page }) => {
  await setUpJournal(page, PASSPHRASE);
  await page.reload();
  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();

  const lightColor = await page
    .locator('.journal-gate__submit')
    .evaluate((el) => getComputedStyle(el).backgroundColor);

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const darkColor = await page
    .locator('.journal-gate__submit')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(darkColor).not.toBe(lightColor);

  const message = page.locator('.journal-gate__message');
  await expect(message).toHaveCount(0);
});
