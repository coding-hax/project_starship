import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
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
