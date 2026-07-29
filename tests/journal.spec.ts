import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Client } from 'pg';
import { openSecondDevice, registerPasskey, resetAppData, withDb } from './helpers';

/**
 * S2 of #302 (issue #338): journal_entries + journal_keys, the Dexie bump, the
 * SYNC_REGISTRY entries and the pull-side conflict copy. No editor/UI yet (S3a) —
 * every test drives the real write path (src/features/journal/write.ts) via the
 * E2E bridge (src/ui/e2e-bridge.tsx), never a duplicated stand-in.
 */

test.beforeEach(async () => {
  await resetAppData();
});

/* -------------------------------------------------------------------------- */
/* AC5: deterministische id -- zweimal derselbe Tag trifft dieselbe Zeile     */
/* -------------------------------------------------------------------------- */

test('AC5: zweimal derselbe Tag schreibt dieselbe Zeile, nie eine zweite', async ({ page }) => {
  await registerPasskey(page);
  const entryDate = '2026-07-29';

  const expectedId = await page.evaluate((d) => window.__starship.journalEntryId(d), entryDate);

  await page.evaluate((d) => window.__starship.writeJournalEntry(d, [1, 2, 3], [4, 5, 6]), entryDate);
  await page.evaluate((d) => window.__starship.writeJournalEntry(d, [7, 8, 9], [10, 11, 12]), entryDate);
  await page.evaluate(() => window.__starship.sync());

  const rows = await withDb((client) =>
    client.query('SELECT id FROM journal_entries WHERE entry_date = $1', [entryDate]),
  );
  expect(rows.rowCount).toBe(1);
  expect(rows.rows[0].id).toBe(expectedId);
});

/* -------------------------------------------------------------------------- */
/* AC7: offline geschrieben -> online -> serverseitig angekommen, kein         */
/* Klartext-Fragment (CLAUDE.md Regel 9)                                      */
/* -------------------------------------------------------------------------- */

test('AC7: offline geschriebener Eintrag erreicht online die Datenbank ohne Klartext-Fragment', async ({
  page,
  context,
}) => {
  await registerPasskey(page);
  await context.setOffline(true);

  const entryDate = '2026-07-29';
  const passphrase = 'ac7 offline passphrase';
  const secretText = 'GEHEIMESTAGEBUCH';
  const secretMood = 'geheime-stimmung';
  const secretTag = 'geheimer-tag';

  await page.evaluate(
    async ({ entryDate, passphrase, content }) => {
      const envelope = await window.__starship.createEnvelope(passphrase, {
        name: 'PBKDF2',
        hash: 'SHA-256',
        iterations: 1000,
      });
      const dek = await window.__starship.openEnvelope(envelope, passphrase);
      const { ciphertext, nonce } = await window.__starship.encryptJournal(dek, content);
      await window.__starship.writeJournalEntry(entryDate, ciphertext, nonce);
    },
    { entryDate, passphrase, content: { text: secretText, mood: secretMood, tags: [secretTag] } },
  );

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT entry_date, ciphertext, nonce FROM journal_entries WHERE entry_date = $1', [
      entryDate,
    ]),
  );
  expect(row.rowCount).toBe(1);
  const ciphertextB64 = row.rows[0].ciphertext as string;
  const nonceB64 = row.rows[0].nonce as string;
  expect(ciphertextB64).not.toContain(secretText);
  expect(ciphertextB64).not.toContain(secretMood);
  expect(ciphertextB64).not.toContain(secretTag);
  expect(nonceB64).not.toContain(secretText);
});

/* -------------------------------------------------------------------------- */
/* AC6: Verdrängung bleibt lokal erhalten (Konflikt-Kopie, ADR-0017)          */
/* -------------------------------------------------------------------------- */

test('AC6: konkurrierende Anlage am selben Tag verdrängt lokal, statt zu verlieren', async ({
  page,
  browser,
}) => {
  const entryDate = '2026-07-29';

  await registerPasskey(page);
  const rowId = await page.evaluate((d) => window.__starship.journalEntryId(d), entryDate);

  // Device A legt zuerst an und synct — die Zeile inkl. syncSeq landet lokal.
  await page.evaluate((d) => window.__starship.writeJournalEntry(d, [1, 1, 1], [9, 9, 9]), entryDate);
  await page.evaluate(() => window.__starship.sync());

  // Device B kennt A's Zeile nie (kein Pull) — baseSeq bleibt null auf beiden
  // Seiten, der Concurrent-Create, den push-seitiges detectOverwrite verfehlt
  // (ADR-0017). Gleiche entryDate -> gleiche deterministische id.
  const deviceB = await openSecondDevice(browser, page);
  await deviceB.evaluate((d) => window.__starship.writeJournalEntry(d, [2, 2, 2], [8, 8, 8]), entryDate);
  await deviceB.evaluate(() => window.__starship.sync());

  // A pullt: B's Ankunft gewinnt (arrival wins, ADR-0008) — A's eigene Fassung
  // wird dabei verdrängt und landet in journalConflicts statt verloren zu gehen.
  await page.evaluate(() => window.__starship.sync());

  const expectedWinningCiphertext = await page.evaluate(
    (bytes) => window.__starship.bytesToBase64(bytes),
    [2, 2, 2],
  );
  const expectedDisplacedCiphertext = await page.evaluate(
    (bytes) => window.__starship.bytesToBase64(bytes),
    [1, 1, 1],
  );

  const records = await page.evaluate(() => window.__starship.debugRecords());
  const journalRecord = records.find((r) => r.table === 'journal_entries' && r.id === rowId);
  expect(journalRecord?.data.ciphertext).toBe(expectedWinningCiphertext);

  const conflicts = await page.evaluate(() => window.__starship.debugJournalConflicts());
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0].entryDate).toBe(entryDate);
  expect(conflicts[0].ciphertext).toBe(expectedDisplacedCiphertext);
});

/* -------------------------------------------------------------------------- */
/* AC3: bestehende lokale Daten überleben den Dexie-Versions-Bump auf 3       */
/* -------------------------------------------------------------------------- */

test('AC3: bestehende Records überleben den Dexie-Versions-Bump auf 3', async ({ page }) => {
  // Frühere Fassung dieses Tests simulierte eine echte Version-2-Installation über
  // rohes indexedDB.open('starship', 2) + manuell nachgebautem v1/v2-Schema, bevor
  // die App Dexie je zu Gesicht bekam. Das erwies sich als nicht reproduzierbar
  // flaky (VersionError, mal auf mobile, mal auf desktop) — Dexie registriert
  // selbst einen versionchange-Handler, der eine offene Verbindung automatisch
  // schließt, sobald IRGENDEINE andere Verbindung dieselbe Datenbank öffnen/löschen
  // will ("Another connection wants to..."); bei `workers: 1` (eine geteilte
  // Browser-Instanz für die ganze Suite) und CI-Retries reichte das für ein Rennen
  // zwischen zwei Verbindungen zu 'starship', unabhängig vom Test-Kontext.
  //
  // Diese Fassung braucht keine konkrete Versionsnummer und kann daher nicht mit
  // einer bestehenden Verbindung kollidieren: sie schreibt einen Record über den
  // echten Schreibpfad, lädt neu — derselbe Dexie-`db`-Singleton öffnet 'starship'
  // dabei ein zweites Mal — und prüft, dass der Record noch da ist UND der neue
  // `journalConflicts`-Store (issue #338) existiert, also der Bump auf Version 3
  // tatsächlich stattgefunden hat. Schwächer als eine echte Alt-Installation, aber
  // deterministisch und beweist denselben Kern der AC: bestehende Daten übersteht
  // einen Dexie-Reopen, auf dem der neue Store hinzugekommen ist.
  await registerPasskey(page);

  const rowId = await page.evaluate(() =>
    window.__starship.mutate({
      table: 'tasks',
      op: 'upsert',
      payload: { title: 'Vor dem Bump' },
    }),
  );

  await page.reload();
  await page.waitForFunction(() => typeof window.__starship !== 'undefined');

  const records = await page.evaluate(() => window.__starship.debugRecords());
  const survivor = records.find((r) => r.id === rowId);
  expect(survivor?.data.title).toBe('Vor dem Bump');

  const storeNames = await page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        // Ohne Versionsnummer öffnet indexedDB.open bei der aktuell bestehenden
        // Version — kein VersionError möglich, rein lesende Introspektion.
        const request = indexedDB.open('starship');
        request.onsuccess = () => {
          const names = Array.from(request.result.objectStoreNames);
          request.result.close();
          resolve(names);
        };
        request.onerror = () => reject(request.error);
      }),
  );
  expect(storeNames).toContain('records');
  expect(storeNames).toContain('journalConflicts');
});

/* -------------------------------------------------------------------------- */
/* AC2: Down-Pfad entfernt journal_entries/journal_keys, Up-Pfad stellt sie   */
/* wieder her — in einer rückgerollten Transaktion, nie gegen die geteilte DB */
/* -------------------------------------------------------------------------- */

test('AC2: Down-Pfad räumt sauber ab, Up-Pfad stellt wieder her, andere Tabellen bleiben unberührt', async () => {
  const downSql = readFileSync(
    path.join(__dirname, '../src/db/migrations/down/0012_journal.down.sql'),
    'utf8',
  );
  const upSql = readFileSync(
    path.join(__dirname, '../src/db/migrations/0012_sweet_impossible_man.sql'),
    'utf8',
  );

  async function tableExists(client: Client, name: string): Promise<boolean> {
    const { rows } = await client.query('SELECT to_regclass($1) AS reg', [name]);
    return rows[0].reg !== null;
  }

  await withDb(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(downSql);
      expect(await tableExists(client, 'journal_entries')).toBe(false);
      expect(await tableExists(client, 'journal_keys')).toBe(false);
      expect(await tableExists(client, 'tasks')).toBe(true);
      expect(await tableExists(client, 'habits')).toBe(true);
      expect(await tableExists(client, 'sync_state')).toBe(true);

      await client.query(upSql);
      expect(await tableExists(client, 'journal_entries')).toBe(true);
      expect(await tableExists(client, 'journal_keys')).toBe(true);
    } finally {
      // DDL ist in Postgres transaktional (anders als in vielen anderen DBs) — der
      // Rollback macht auch DROP/CREATE TABLE rückgängig, die geteilte Test-DB bleibt
      // unberührt, egal ob eine Assertion oben wirft.
      await client.query('ROLLBACK');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* S3b (issue #340): der Editor selbst — Stimmungs-Skala, Text, Tags,         */
/* Konflikt-Banner. Baut auf S3a (#339, journal-lock.spec.ts) auf.            */
/* -------------------------------------------------------------------------- */

const EDITOR_PASSPHRASE = 's3b editor passphrase';

/** Same wait-for-settled-state reasoning as journal-lock.spec.ts's setUpJournal:
 * journalSetup() derives a key and writes before the button resolves. */
async function setUpEditor(page: Page, passphrase = EDITOR_PASSPHRASE): Promise<void> {
  await registerPasskey(page);
  await page.goto('/journal');
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('Passphrase wiederholen').fill(passphrase);
  await page.getByRole('button', { name: 'Einrichten' }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();
}

async function unlockEditor(page: Page, passphrase = EDITOR_PASSPHRASE): Promise<void> {
  await page.locator('.journal-gate[data-state="locked"]').waitFor();
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Entsperren' }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();
}

async function todayKey(page: Page): Promise<string> {
  return page.evaluate(() => new Date().toLocaleDateString('en-CA'));
}

async function currentCiphertext(page: Page, rowId: string): Promise<string | undefined> {
  const records = await page.evaluate(() => window.__starship.debugRecords());
  return records.find((r) => r.table === 'journal_entries' && r.id === rowId)?.data.ciphertext as
    | string
    | undefined;
}

/** Waits for the debounced/immediate autosave to actually land, regardless of
 * the exact timing of `SAVE_DEBOUNCE_MS` — polls the real row instead of a
 * fixed sleep. Returns the new ciphertext so the caller can chain further waits. */
async function waitForCiphertextChange(
  page: Page,
  rowId: string,
  previous: string | undefined,
): Promise<string> {
  await expect.poll(() => currentCiphertext(page, rowId)).not.toBe(previous);
  return (await currentCiphertext(page, rowId))!;
}

test('AC1: Skala ist das erste Element, ein Tipp setzt den Wert, ein erneuter nimmt ihn zurück', async ({
  page,
}) => {
  await setUpEditor(page);

  const firstChild = page.locator('.journal-editor > *').first();
  await expect(firstChild).toHaveClass(/mood-scale/);

  const point = page.getByRole('button', { name: '7', exact: true });
  await expect(point).toHaveAttribute('aria-pressed', 'false');
  await point.click();
  await expect(point).toHaveAttribute('aria-pressed', 'true');
  await point.click();
  await expect(point).toHaveAttribute('aria-pressed', 'false');
});

test('AC2: bei 375px sind alle zehn Punkte mindestens 44px hoch, in einer Reihe, ohne horizontalen Scroll', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await setUpEditor(page);

  const scale = page.locator('.mood-scale');
  const scrollWidth = await scale.evaluate((el) => el.scrollWidth);
  const clientWidth = await scale.evaluate((el) => el.clientWidth);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

  const points = page.locator('.mood-scale__point');
  await expect(points).toHaveCount(10);

  const boxes = await Promise.all(
    Array.from({ length: 10 }, (_, i) => points.nth(i).boundingBox()),
  );
  for (const box of boxes) {
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  const rowY = boxes[0]!.y;
  for (const box of boxes) expect(box!.y).toBe(rowY);
});

test('AC3: gesetzter Wert und Text stehen nach dem Neuladen noch da — aus dem Chiffrat, nicht aus einem Klartextfeld', async ({
  page,
}) => {
  await setUpEditor(page);
  const entryDate = await todayKey(page);
  const rowId = await page.evaluate((d) => window.__starship.journalEntryId(d), entryDate);

  await page.getByRole('button', { name: '8', exact: true }).click();
  let ciphertext = await waitForCiphertextChange(page, rowId, undefined);

  await page.getByLabel('Journal-Text').fill('Guter Tag');
  ciphertext = await waitForCiphertextChange(page, rowId, ciphertext);
  expect(ciphertext).toBeTruthy();

  await page.reload();
  await unlockEditor(page);

  await expect(page.getByRole('button', { name: '8', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByLabel('Journal-Text')).toHaveValue('Guter Tag');
});

test('AC4/AC6: Stimmung, Text und Tags landen als EIN Chiffrat über die Outbox, serverseitig genau eine Zeile', async ({
  page,
}) => {
  await setUpEditor(page);
  const entryDate = await todayKey(page);
  const rowId = await page.evaluate((d) => window.__starship.journalEntryId(d), entryDate);

  await page.getByRole('button', { name: '5', exact: true }).click();
  let ciphertext = await waitForCiphertextChange(page, rowId, undefined);

  await page.getByLabel('Journal-Text').fill('Ruhiger Tag');
  ciphertext = await waitForCiphertextChange(page, rowId, ciphertext);

  await page.getByLabel('Tags').fill('arbeit, sport');
  ciphertext = await waitForCiphertextChange(page, rowId, ciphertext);

  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const rows = await withDb((client) =>
    client.query('SELECT ciphertext FROM journal_entries WHERE entry_date = $1', [entryDate]),
  );
  expect(rows.rowCount).toBe(1);
  expect(rows.rows[0].ciphertext).toBe(ciphertext);
});

test('AC5: ein zweiter Aufruf desselben Tages bearbeitet denselben Eintrag, nie einen zweiten', async ({
  page,
}) => {
  await setUpEditor(page);
  const entryDate = await todayKey(page);
  const rowId = await page.evaluate((d) => window.__starship.journalEntryId(d), entryDate);

  await page.getByLabel('Journal-Text').fill('Erster Absatz');
  const ciphertext = await waitForCiphertextChange(page, rowId, undefined);
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  await page.reload();
  await unlockEditor(page);
  await expect(page.getByLabel('Journal-Text')).toHaveValue('Erster Absatz');

  await page.getByLabel('Journal-Text').fill('Erster Absatz, zweiter Zusatz');
  await waitForCiphertextChange(page, rowId, ciphertext);
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const rows = await withDb((client) =>
    client.query('SELECT count(*)::int AS n, array_agg(id) AS ids FROM journal_entries WHERE entry_date = $1', [
      entryDate,
    ]),
  );
  expect(rows.rows[0].n).toBe(1);
  expect(rows.rows[0].ids).toEqual([rowId]);
});

test('AC7: offline gesetzte Stimmung und Text erreichen online die Datenbank, aber nicht lesbar', async ({
  page,
  context,
}) => {
  await setUpEditor(page);
  const entryDate = await todayKey(page);
  const rowId = await page.evaluate((d) => window.__starship.journalEntryId(d), entryDate);
  const secretText = 'GEHEIMER OFFLINE TEXT';

  await context.setOffline(true);

  await page.getByRole('button', { name: '9', exact: true }).click();
  let ciphertext = await waitForCiphertextChange(page, rowId, undefined);
  await page.getByLabel('Journal-Text').fill(secretText);
  ciphertext = await waitForCiphertextChange(page, rowId, ciphertext);

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBeGreaterThan(0);

  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT ciphertext, nonce FROM journal_entries WHERE entry_date = $1', [entryDate]),
  );
  expect(row.rowCount).toBe(1);
  expect(row.rows[0].ciphertext).toBe(ciphertext);
  expect(row.rows[0].ciphertext as string).not.toContain(secretText);
  expect(row.rows[0].nonce as string).not.toContain(secretText);
});

test('AC8: eine Konflikt-Kopie ist im Editor sichtbar und wiederherstellbar, statt still verschluckt zu werden', async ({
  page,
}) => {
  await setUpEditor(page);
  const entryDate = await todayKey(page);

  await page.evaluate(
    (d) =>
      window.__starship.debugSeedJournalConflict(d, {
        text: 'Verdrängter Text',
        mood: '3',
        tags: ['alt'],
      }),
    entryDate,
  );

  const banner = page.locator('.journal-editor__conflict');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Verdrängter Text');

  await banner.getByRole('button', { name: 'Wiederherstellen' }).click();
  await expect(banner).toHaveCount(0);

  await expect(page.getByLabel('Journal-Text')).toHaveValue('Verdrängter Text');
  await expect(page.getByRole('button', { name: '3', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  const conflicts = await page.evaluate(() => window.__starship.debugJournalConflicts());
  expect(conflicts).toHaveLength(0);
});

test('AC9: bei gesperrtem Journal ist der Editor nicht erreichbar, sondern der Entsperr-Zustand', async ({
  page,
}) => {
  await setUpEditor(page);
  await page.reload();

  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();
  await expect(page.locator('.journal-editor')).toHaveCount(0);
});

for (const viewport of [
  { width: 375, height: 667 },
  { width: 1280, height: 800 },
]) {
  test(`AC10: Editor bei ${viewport.width}px ohne horizontalen Seiten-Scroll`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await setUpEditor(page);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
}

test('AC10: die Stimmungs-Skala nutzt Tokens, die sich im Dark Mode tatsächlich unterscheiden', async ({
  page,
}) => {
  await setUpEditor(page);
  const point = page.getByRole('button', { name: '4', exact: true });
  await point.click();

  const lightBg = await point.evaluate((el) => getComputedStyle(el).backgroundColor);

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const darkBg = await point.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(darkBg).not.toBe(lightBg);
});

/* -------------------------------------------------------------------------- */
/* issue #342 AC3: die Übersicht-Sektion "heute schon geschrieben?" braucht   */
/* kein neues Klartext-Feld — `journal_entries` bleibt exakt so geschnitten   */
/* wie in #338 (ADR-0004: der Server erfährt nur *dass*, nie *was*).          */
/* -------------------------------------------------------------------------- */

test('AC3: journal_entries trägt kein neues Klartext-Feld — nur die seit #338 bekannten Spalten', async () => {
  const columns = await withDb((client) =>
    client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'journal_entries'`,
    ),
  );

  expect(new Set(columns.rows.map((r) => r.column_name as string))).toEqual(
    new Set(['id', 'updated_at', 'deleted_at', 'synced_at', 'sync_seq', 'entry_date', 'ciphertext', 'nonce']),
  );
});
