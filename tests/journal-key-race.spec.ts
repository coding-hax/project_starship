import { expect, test, type Browser, type Page } from '@playwright/test';
import { PULL_PAGE_LIMIT } from '@/local/conflict';
import { openSecondDevice, registerPasskey, resetAppData, settleJournalHabitBoot, withDb } from './helpers';

/**
 * issue #518 (Weg B aus #477): the journal_keys first-setup race. Two devices
 * offline both mint a DEK onto the fixed key row; arrival-wins (ADR-0008) lets
 * one win, and the loser's envelope would otherwise vanish everywhere — this
 * suite proves the stash-and-recover path that replaces that silent loss.
 *
 * `debugCompetingSetup` (see its doc comment in lock-store.ts) stands in for the
 * losing side of a real race: two genuinely concurrent setups depend on the
 * timing of two network round trips, which Playwright cannot force
 * deterministically. What matters for every AK below is what happens *after* the
 * race — the race itself is simulated, everything downstream (stash, pull merge,
 * recovery, sync) is the real code path.
 */

// Every AK test drives at least two real envelope setups (A + B), each a real
// PBKDF2 derivation at production iteration count (no FAST_KDF_PARAMS override
// exists on journalSetup/debugCompetingSetup/journalUnlock/recoverOrphaned — the
// real functions never accept one). Several tests add a third (unlock after
// reload) or fourth (opening the stashed envelope during recovery) derivation on
// top of two real device syncs against Postgres — comfortably past the default
// 30s test timeout on its own, without needing anything to be slow or wrong.
test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetAppData();
});

const PASSPHRASE_A = '518 race passphrase A';
const PASSPHRASE_B = '518 race passphrase B';
const ENTRY_DATE = '2026-08-04';
const TEXT_A = 'GERAET-A-ALTER-KLARTEXT';
const TEXT_B = 'GERAET-B-GEWINNT-KLARTEXT';

async function setUpEditorA(page: Page): Promise<{ recoveryKey: string }> {
  await registerPasskey(page, '/journal');
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE_A);
  await page.getByLabel('Passphrase wiederholen').fill(PASSPHRASE_A);
  await page.getByRole('button', { name: 'Einrichten' }).click();
  const recoveryKey = (await page.getByTestId('journal-recovery-key').textContent())!.trim();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();
  return { recoveryKey };
}

/**
 * Drives the race up to the point AK1 fires: A sets up + writes a real entry via
 * the genuine UI, syncs; B (a second, independent device) races in with
 * `debugCompetingSetup` + its own entry, syncs and wins (later arrival, higher
 * syncSeq — ADR-0008); A syncs again, pulls B's now-winning envelope, and stashes
 * its own before it is overwritten.
 */
async function raceUntilDisplaced(
  page: Page,
  browser: Browser,
): Promise<{ deviceB: Page; recoveryKeyA: string }> {
  const { recoveryKey: recoveryKeyA } = await setUpEditorA(page);
  const deviceB = await openSecondDevice(browser, page);

  await page.evaluate(
    ({ entryDate, text }) => window.__starship.appendJournalEntry(entryDate, { text, tags: [] }),
    { entryDate: ENTRY_DATE, text: TEXT_A },
  );
  await page.evaluate(() => window.__starship.sync());

  await deviceB.evaluate((passphrase) => window.__starship.debugCompetingSetup(passphrase), PASSPHRASE_B);
  await deviceB.evaluate(
    ({ entryDate, text }) => window.__starship.appendJournalEntry(entryDate, { text, tags: [] }),
    { entryDate: ENTRY_DATE, text: TEXT_B },
  );
  await deviceB.evaluate(() => window.__starship.sync());

  // A pulls B's now-winning envelope -> displacement -> stash.
  await page.evaluate(() => window.__starship.sync());

  return { deviceB, recoveryKeyA };
}

async function entryTexts(devicePage: Page, entryDate: string): Promise<string[]> {
  const entries = await devicePage.evaluate((d) => window.__starship.listJournalEntries(d), entryDate);
  return entries.map((e) => e.content.text);
}

async function entryCountInDb(entryDate: string): Promise<number> {
  const rows = await withDb((client) =>
    client.query('SELECT count(*)::int AS n FROM journal_entries WHERE entry_date = $1', [entryDate]),
  );
  return rows.rows[0].n as number;
}

test('AK1: der verdrängte Envelope landet im Stash, bevor die fremde Hülle ihn überschreibt', async ({
  page,
  browser,
}) => {
  await registerPasskey(page, '/journal');

  // Baseline: A's own first setup + push/pull round trip stashes nothing — a
  // pull that echoes back this device's own just-pushed row must not look like
  // a foreign displacement.
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE_A);
  await page.getByLabel('Passphrase wiederholen').fill(PASSPHRASE_A);
  await page.getByRole('button', { name: 'Einrichten' }).click();
  await page.getByTestId('journal-recovery-key').waitFor();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();

  const envelopeABeforeRace = await page.evaluate(async () => {
    const records = await window.__starship.debugRecords();
    return records.find((r) => r.table === 'journal_keys')!.data.envelope;
  });

  await page.evaluate(() => window.__starship.sync());
  expect(await page.evaluate(() => window.__starship.debugJournalKeyStash())).toEqual([]);

  const deviceB = await openSecondDevice(browser, page);
  await deviceB.evaluate((passphrase) => window.__starship.debugCompetingSetup(passphrase), PASSPHRASE_B);
  await deviceB.evaluate(() => window.__starship.sync());

  // A pulls B's now-winning envelope.
  await page.evaluate(() => window.__starship.sync());

  const stash = await page.evaluate(() => window.__starship.debugJournalKeyStash());
  expect(stash).toHaveLength(1);
  expect(stash[0].envelope).toEqual(envelopeABeforeRace);
});

test('AK2: nach der Verdrängung öffnet die alte Passphrase das Journal nicht mehr, die neue schon', async ({
  page,
  browser,
}) => {
  await raceUntilDisplaced(page, browser);

  // A cold restart (reload) re-reads the local envelope from scratch instead of
  // trusting the DEK still held in this tab's memory — the real symptom is what
  // a freshly opened tab or a reinstalled app sees, not an already-unlocked one.
  await page.reload();
  await page.locator('.journal-gate[data-state="locked"]').waitFor();

  expect(await page.evaluate((p) => window.__starship.journalUnlock(p), PASSPHRASE_A)).toBe('wrong');
  expect(await page.evaluate((p) => window.__starship.journalUnlock(p), PASSPHRASE_B)).toBe('ok');

  const texts = await entryTexts(page, ENTRY_DATE);
  expect(texts).not.toContain(TEXT_A);
  expect(texts).toContain(TEXT_B);
});

test('AK3: die alte Passphrase im Bergungs-Formular macht die Alt-Einträge wieder lesbar', async ({
  page,
  browser,
}) => {
  await raceUntilDisplaced(page, browser);

  await page.reload();
  await page.locator('.journal-gate[data-state="locked"]').waitFor();
  await page.evaluate((p) => window.__starship.journalUnlock(p), PASSPHRASE_B);
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();

  await expect(page.locator('.journal-orphaned-key')).toBeVisible();
  await page.getByLabel('Damalige Passphrase').fill(PASSPHRASE_A);
  await page.getByRole('button', { name: 'Bergen', exact: true }).click();
  await expect(page.locator('.journal-orphaned-key__message')).toHaveText('1 Eintrag geborgen.');

  const texts = await entryTexts(page, ENTRY_DATE);
  expect(texts).toContain(TEXT_A);
  expect(texts).toContain(TEXT_B);

  // Recovered, not duplicated — same two rows as before, one re-encrypted.
  expect(await entryCountInDb(ENTRY_DATE)).toBe(2);
  expect(await page.evaluate(() => window.__starship.debugJournalKeyStash())).toEqual([]);
});

test('AK4: ein zweites Gerät liest den neu verschlüsselten Alt-Eintrag nach dem nächsten Sync', async ({
  page,
  browser,
}) => {
  const { deviceB } = await raceUntilDisplaced(page, browser);

  await page.reload();
  await page.locator('.journal-gate[data-state="locked"]').waitFor();
  await page.evaluate((p) => window.__starship.journalUnlock(p), PASSPHRASE_B);
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();
  await page.getByLabel('Damalige Passphrase').fill(PASSPHRASE_A);
  await page.getByRole('button', { name: 'Bergen', exact: true }).click();
  await expect(page.locator('.journal-orphaned-key__message')).toHaveText('1 Eintrag geborgen.');

  await page.evaluate(() => window.__starship.sync());
  await deviceB.evaluate(() => window.__starship.sync());

  const texts = await entryTexts(deviceB, ENTRY_DATE);
  expect(texts).toContain(TEXT_A);
  expect(texts).toContain(TEXT_B);
  expect(await entryCountInDb(ENTRY_DATE)).toBe(2); // same row, no duplicate.
});

test('AK5: der damalige Wiederherstellungsschlüssel bergt die Alt-Einträge genauso wie die Passphrase', async ({
  page,
  browser,
}) => {
  const { recoveryKeyA } = await raceUntilDisplaced(page, browser);

  await page.reload();
  await page.locator('.journal-gate[data-state="locked"]').waitFor();
  await page.evaluate((p) => window.__starship.journalUnlock(p), PASSPHRASE_B);
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();

  await page.getByRole('button', { name: 'Mit Wiederherstellungsschlüssel bergen' }).click();
  await page.getByLabel('Damaliger Wiederherstellungsschlüssel').fill(recoveryKeyA);
  await page.getByRole('button', { name: 'Bergen', exact: true }).click();
  await expect(page.locator('.journal-orphaned-key__message')).toHaveText('1 Eintrag geborgen.');

  const texts = await entryTexts(page, ENTRY_DATE);
  expect(texts).toContain(TEXT_A);
});

test('AK6: weder die Verdrängung noch die Bergung hinterlassen Klartext in einem JSON-serialisierbaren Store', async ({
  page,
  browser,
}) => {
  await raceUntilDisplaced(page, browser);

  const dumpAfterDisplacement = await page.evaluate(() => window.__starship.debugDumpStores());
  expect(dumpAfterDisplacement).not.toContain(TEXT_A);
  expect(dumpAfterDisplacement).not.toContain(TEXT_B);

  await page.reload();
  await page.locator('.journal-gate[data-state="locked"]').waitFor();
  await page.evaluate((p) => window.__starship.journalUnlock(p), PASSPHRASE_B);
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();
  await page.getByLabel('Damalige Passphrase').fill(PASSPHRASE_A);
  await page.getByRole('button', { name: 'Bergen', exact: true }).click();
  await expect(page.locator('.journal-orphaned-key__message')).toHaveText('1 Eintrag geborgen.');

  const dumpAfterRecovery = await page.evaluate(() => window.__starship.debugDumpStores());
  expect(dumpAfterRecovery).not.toContain(TEXT_A);
  expect(dumpAfterRecovery).not.toContain(TEXT_B);
});

test('AK7: Bergung offline geschrieben erreicht online die Datenbank', async ({ page, browser, context }) => {
  await raceUntilDisplaced(page, browser);

  await page.reload();
  await page.locator('.journal-gate[data-state="locked"]').waitFor();
  await page.evaluate((p) => window.__starship.journalUnlock(p), PASSPHRASE_B);
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();

  await context.setOffline(true);
  await page.getByLabel('Damalige Passphrase').fill(PASSPHRASE_A);
  await page.getByRole('button', { name: 'Bergen', exact: true }).click();
  await expect(page.locator('.journal-orphaned-key__message')).toHaveText('1 Eintrag geborgen.');
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT ciphertext FROM journal_entries WHERE entry_date = $1', [ENTRY_DATE]),
  );
  expect(row.rowCount).toBe(2); // recovered, not duplicated — same two rows as before.
  for (const r of row.rows) {
    const ciphertextB64 = r.ciphertext as string;
    expect(ciphertextB64).not.toContain(TEXT_A);
    expect(ciphertextB64).not.toContain(TEXT_B);
  }
});

test('Bergung vor dem Reload wirft den Stash nicht weg (#1143)', async ({ page, browser }) => {
  await raceUntilDisplaced(page, browser);

  // No reload yet — A is still the DEK in memory, B is the now-current local
  // envelope. "Readable under A" must not count as proof of safety under B:
  // the recovery has to refuse, not silently report success.
  const recoveredBeforeReload = await page.evaluate(
    (p) => window.__starship.journalRecoverOrphaned(p, false),
    PASSPHRASE_A,
  );
  expect(recoveredBeforeReload).toBe(0);

  // The line that is red before the fix: the bug deletes the stash
  // unconditionally, even though nothing was actually recovered under the
  // stale DEK — after that, TEXT_A would be gone for good once B takes over.
  expect(await page.evaluate(() => window.__starship.debugJournalKeyStash())).toHaveLength(1);

  await page.reload();
  await page.locator('.journal-gate[data-state="locked"]').waitFor();
  await page.evaluate((p) => window.__starship.journalUnlock(p), PASSPHRASE_B);
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();

  await expect(page.locator('.journal-orphaned-key')).toBeVisible();
  await page.getByLabel('Damalige Passphrase').fill(PASSPHRASE_A);
  await page.getByRole('button', { name: 'Bergen', exact: true }).click();
  await expect(page.locator('.journal-orphaned-key__message')).toHaveText('1 Eintrag geborgen.');

  const texts = await entryTexts(page, ENTRY_DATE);
  expect(texts).toContain(TEXT_A);
  expect(texts).toContain(TEXT_B);
  expect(await entryCountInDb(ENTRY_DATE)).toBe(2); // recovered, not duplicated.
});

test.describe('Journal-Setup erst nach vollständig geprüftem Konto (#1135)', () => {
  const PASSPHRASE = '1135 vollstaendigkeit passphrase';

  /** Bulk-seeds `count` task rows directly in Postgres, each with its own sync_seq —
   *  local copy of sync.spec.ts's helper (that file stays untouched). */
  async function seedTasks(count: number, titlePrefix: string) {
    await withDb((c) =>
      c.query(
        `INSERT INTO tasks (id, title, sync_seq)
         SELECT gen_random_uuid(), $1 || g, nextval('sync_seq')
         FROM generate_series(1, $2) AS g`,
        [titlePrefix, count],
      ),
    );
  }

  /**
   * A fresh device (own context, own IndexedDB) whose `/api/sync/pull` route is
   * wired up *before* the one navigation to `/journal` — the app-start pull (the
   * root layout's `SyncBoot`) and the journal page's own bootstrap pull
   * (`lock-store.ts` `initialize()`) both fire on that single load, and a route
   * attached afterwards would miss whichever got there first (see the sibling
   * `#371 AC4` test in journal-lock.spec.ts for the same reasoning). Gating on
   * each request's own `since` — not on call order — keeps this race-free
   * against however many concurrent pull requests those two triggers produce.
   */
  async function openGatedDevice(
    browser: Browser,
    page: Page,
    allowSince: (since: number) => boolean,
  ): Promise<Page> {
    const context = await browser.newContext({ storageState: await page.context().storageState() });
    const devicePage = await context.newPage();
    await devicePage.route('**/api/sync/pull**', async (route) => {
      const since = Number(new URL(route.request().url()).searchParams.get('since'));
      if (allowSince(since)) {
        await route.continue();
      } else {
        await route.abort('failed');
      }
    });
    await devicePage.goto('/journal');
    return devicePage;
  }

  test('abgebrochen mitten im Pull: unavailable, nicht setup (der Datenverlust-Fall)', async ({
    page,
    browser,
  }) => {
    await registerPasskey(page, '/uebersicht');
    await settleJournalHabitBoot(page);
    await seedTasks(PULL_PAGE_LIMIT, 'Seed #1135 ');

    // Pushed after every seeded task, so the envelope gets the highest sync_seq and
    // sits on the page after the first PULL_PAGE_LIMIT rows.
    await page.evaluate((p) => window.__starship.journalSetup(p), PASSPHRASE);
    await page.evaluate(() => window.__starship.sync());

    // since=0 (page 1) lands, every later page (holding the envelope) is aborted.
    const deviceB = await openGatedDevice(browser, page, (since) => since === 0);

    await expect
      .poll(() => deviceB.evaluate(() => window.__starship.journalLockState()))
      .toBe('unavailable');

    await deviceB.close();
  });

  test('durchgelaufen mit Envelope: locked, benutzt die spätere Seite, kein Ersatz', async ({
    page,
    browser,
  }) => {
    await registerPasskey(page, '/uebersicht');
    await settleJournalHabitBoot(page);
    await seedTasks(PULL_PAGE_LIMIT, 'Seed #1135 ');
    await page.evaluate((p) => window.__starship.journalSetup(p), PASSPHRASE);
    await page.evaluate(() => window.__starship.sync());

    const deviceB = await openGatedDevice(browser, page, () => true);

    await expect.poll(() => deviceB.evaluate(() => window.__starship.journalLockState())).toBe('locked');

    await deviceB.close();
  });

  test('durchgelaufen ohne Envelope: setup erlaubt', async ({ page, browser }) => {
    await registerPasskey(page, '/uebersicht');
    await settleJournalHabitBoot(page);
    await seedTasks(PULL_PAGE_LIMIT, 'Seed #1135 ');
    // Kein journalSetup — kein journal_keys-Eintrag existiert für dieses Konto.

    const deviceB = await openGatedDevice(browser, page, () => true);

    await expect.poll(() => deviceB.evaluate(() => window.__starship.journalLockState())).toBe('setup');

    await deviceB.close();
  });
});
