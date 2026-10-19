import { expect, test, type Page } from '@playwright/test';
import {
  freezeClock,
  installClockAt,
  openSecondDevice,
  registerPasskey,
  resetAppData,
  withDb,
} from './helpers';

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
  await registerPasskey(page, '/journal');
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('Passphrase wiederholen').fill(passphrase);
  await page.getByRole('button', { name: 'Einrichten' }).click();
  await page.getByTestId('journal-recovery-key').waitFor();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();
}

async function journalKeyRowCount(): Promise<number> {
  const result = await withDb((client) =>
    client.query('SELECT count(*)::int AS n FROM journal_keys'),
  );
  return result.rows[0].n as number;
}

test('Passphrase-Felder tragen autocomplete fuer den Passwortmanager (Fund #392)', async ({
  page,
}) => {
  await registerPasskey(page, '/journal');
  await expect(page.getByLabel('Passphrase', { exact: true })).toHaveAttribute(
    'autocomplete',
    'new-password',
  );

  await setUpJournal(page, PASSPHRASE);
  await page.reload();
  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();
  await expect(page.getByLabel('Passphrase', { exact: true })).toHaveAttribute(
    'autocomplete',
    'current-password',
  );
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
  await expect
    .poll(() => page.evaluate(() => window.__starship.journalHasPersistedDek()))
    .toBe(true);
  await expect(
    page.evaluate(() => window.__starship.journalPersistedDekExtractable()),
  ).resolves.toBe(false);

  await page.reload();
  await page.goto('/journal');
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

/** The stored envelope as the server holds it — unchanged bytes prove no re-wrap. */
async function serverEnvelope(): Promise<string> {
  const result = await withDb((client) => client.query('SELECT envelope FROM journal_keys'));
  return JSON.stringify(result.rows[0]?.envelope ?? null);
}

async function pushEverything(page: Page) {
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
}

test('journalSetup verweigert das Ueberschreiben einer vorhandenen Huelle (#371 AC3)', async ({
  page,
}) => {
  await setUpJournal(page, PASSPHRASE);
  await pushEverything(page);
  const before = await serverEnvelope();

  // Neu geladen, also gesperrt — der Zustand, aus dem heraus ein zweites
  // Einrichten die Huelle ueberschreiben wuerde.
  await page.reload();
  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();

  await page.evaluate((passphrase) => window.__starship.journalSetup(passphrase), WRONG_PASSPHRASE);
  expect(await page.evaluate(() => window.__starship.journalLockState())).toBe('locked');
  await expect(page.locator('.journal-gate__message')).toContainText('bereits eine Passphrase');

  await pushEverything(page);
  expect(await serverEnvelope()).toBe(before);
  expect(await journalKeyRowCount()).toBe(1);

  // Die urspruengliche Passphrase oeffnet weiterhin — der DEK wurde nicht ersetzt.
  expect(
    await page.evaluate((passphrase) => window.__starship.journalUnlock(passphrase), PASSPHRASE),
  ).toBe('ok');
});

test('ohne Verbindung bietet der Gate kein Einrichten an, Wiederholen loest es auf (#371 AC4)', async ({
  page,
  browser,
}) => {
  await setUpJournal(page, PASSPHRASE);
  await pushEverything(page);

  // Zweites Geraet, dieselbe Sitzung, eigener leerer Speichercontainer. Der
  // Sync-Pull wird von der ersten Zeile an abgebrochen (Server weg) — vor jeder
  // Navigation, damit der App-Start-Pull die Huelle nicht doch noch lokal
  // ablegt. So bleibt es der reine Offline-Erststart, den der Gate ohne
  // „einrichten" ueberstehen muss. (`setOffline` scheidet aus: es verschluckt im
  // App Router schon die RSC-Payload der Navigation, die Seite kaeme nie so weit,
  // den Gate ueberhaupt zu rendern. `openSecondDevice` mit spaeterem Abbruch
  // waere ein Rennen: sein Pull auf /uebersicht holt die Huelle sonst schon,
  // bevor wir abbrechen, und der Gate landete zu Recht auf `locked`.)
  const context = await browser.newContext({ storageState: await page.context().storageState() });
  const second = await context.newPage();
  await second.route('**/api/sync/pull**', (route) => route.abort('failed'));
  await second.goto('/journal');

  await expect(second.locator('.journal-gate[data-state="unavailable"]')).toBeVisible();
  await expect(second.locator('.journal-gate[data-state="setup"]')).toHaveCount(0);

  // Server wieder erreichbar: „Erneut versuchen" pullt die Huelle und sperrt,
  // statt einzurichten.
  await second.unroute('**/api/sync/pull**');
  await second.getByRole('button', { name: 'Erneut versuchen' }).click();
  await expect(second.locator('.journal-gate[data-state="locked"]')).toBeVisible();
});

test('mehrere Tabs sperren konsistent, wenn der Auto-Lock-Timer eines Tabs ablaeuft (ADR-0016 Punkt 1)', async ({
  page,
  context,
}) => {
  await installClockAt(page);
  await setUpJournal(page, PASSPHRASE);
  await expect(page.locator('.journal-gate[data-state="unlocked"]')).toBeVisible();

  const secondPage = await context.newPage();
  await secondPage.goto('/journal');
  await expect(secondPage.locator('.journal-gate[data-state="unlocked"]')).toBeVisible();

  // Uhr nur auf Tab A -- Tab Bs eigener 15-min-Echtzeittimer feuert in diesem
  // Testfenster nicht, Tab B sperrt allein durch den Broadcast von A.
  await freezeClock(page);
  await page.clock.fastForward(AUTO_LOCK_MS + 1_000);

  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();
  await expect(secondPage.locator('.journal-gate[data-state="locked"]')).toBeVisible();
});

test('Ent- und Sperren funktioniert vollstaendig offline (ADR-0016 Punkt 2)', async ({
  page,
  context,
}) => {
  await setUpJournal(page, PASSPHRASE);
  // Online neu geladen -- eine Navigation waehrend offline verschluckt im App
  // Router die RSC-Payload (siehe Kommentar am #371-AC4-Test); readEnvelope()
  // liest die schon lokal vorhandene Huelle, kein Pull noetig.
  await page.reload();
  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();

  await context.setOffline(true);

  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Entsperren', exact: true }).click();
  await expect(page.locator('.journal-gate[data-state="unlocked"]')).toBeVisible();

  await page.evaluate(() => window.__starship.journalLock());
  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();

  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Entsperren', exact: true }).click();
  await expect(page.locator('.journal-gate[data-state="unlocked"]')).toBeVisible();

  await context.setOffline(false);
});

test('Opt-in AN schaltet den Auto-Lock-Timer ab (ADR-0016 Punkt 3, AC6 Gegenprobe)', async ({
  page,
}) => {
  await installClockAt(page);
  await setUpJournal(page, PASSPHRASE);

  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await nav.getByRole('link', { name: 'Übersicht' }).click();
  await page.getByRole('link', { name: 'Einstellungen' }).click();
  await expect(page).toHaveURL(/\/einstellungen$/);

  const toggle = page.getByRole('switch', { name: 'Auf diesem Gerät entsperrt lassen' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect
    .poll(() => page.evaluate(() => window.__starship.journalHasPersistedDek()))
    .toBe(true);

  await nav.getByRole('link', { name: 'Journal' }).click();
  await expect(page.locator('.journal-gate[data-state="unlocked"]')).toBeVisible();

  // page.clock ueberlebt die client-seitigen Navigationen (kein Dokument-Reload).
  await freezeClock(page);
  await page.clock.fastForward(AUTO_LOCK_MS + 60_000);

  await expect(page.locator('.journal-gate[data-state="unlocked"]')).toBeVisible();
});

test('Geraetewechsel ohne persistierten DEK landet gesperrt, nicht automatisch offen (ADR-0016 Punkt 4)', async ({
  page,
  browser,
}) => {
  await setUpJournal(page, PASSPHRASE);

  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await nav.getByRole('link', { name: 'Übersicht' }).click();
  await page.getByRole('link', { name: 'Einstellungen' }).click();
  await expect(page).toHaveURL(/\/einstellungen$/);
  const toggle = page.getByRole('switch', { name: 'Auf diesem Gerät entsperrt lassen' });
  await toggle.click();
  await expect
    .poll(() => page.evaluate(() => window.__starship.journalHasPersistedDek()))
    .toBe(true);

  await nav.getByRole('link', { name: 'Journal' }).click();
  await pushEverything(page);

  // openSecondDevice kopiert storageState inkl. localStorage -- das Opt-in-Flag
  // reist also mit. Genau das macht den Test aussagekraeftig: das Flag allein
  // entsperrt B nicht, weil der persistierte DEK im IndexedDB-Store
  // journalSession liegt, der nicht Teil von storageState ist.
  const second = await openSecondDevice(browser, page);
  await second.goto('/journal');

  await expect(second.locator('.journal-gate[data-state="locked"]')).toBeVisible();
  await expect(second.locator('.journal-gate[data-state="setup"]')).toHaveCount(0);
  await expect(second.locator('.journal-gate[data-state="unlocked"]')).toHaveCount(0);
  expect(await second.evaluate(() => window.__starship.journalHasPersistedDek())).toBe(false);

  await second.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await second.getByRole('button', { name: 'Entsperren', exact: true }).click();
  await expect(second.locator('.journal-gate[data-state="unlocked"]')).toBeVisible();
});
