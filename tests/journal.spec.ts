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

test('AC3: bestehende Records überleben den Dexie-Versions-Bump auf 3', async ({ browser }) => {
  // Ein eigener, storageState-loser Kontext statt der geteilten `page`: die
  // gemeinsame AUTH_STATE-Sitzung hält selbst schon eine offene Verbindung zu
  // 'starship' (aus vorherigen Läufen dieses Kontexts) — ein deleteDatabase()
  // darauf blockiert (`onblocked`) statt zu completen, und wer trotzdem sofort
  // weitermacht, öffnet danach eine `2 < bestehend`-Version (VersionError). Ein
  // frischer Kontext hat garantiert noch nie von 'starship' gehört; der Preis ist
  // die volle Passkey-Zeremonie statt der kurzgeschlossenen Session.
  const context = await browser.newContext();
  const page = await context.newPage();

  // /anmelden mountet weder SyncBoot noch E2EBridge (src/app/(app)/layout.tsx) —
  // die Seite öffnet Dexie nicht selbst, also lässt sich hier unbeobachtet eine
  // Version-2-Datenbank seeden, bevor die echte App sie je zu Gesicht bekommt.
  await page.goto('/anmelden');

  const seeded = {
    table: 'tasks',
    id: 'seed-vor-dem-bump',
    updatedAt: new Date().toISOString(),
    deletedAt: null,
    syncedAt: null,
    syncSeq: null,
    data: { title: 'Vor dem Bump' },
  };

  await page.evaluate(
    (record) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('starship', 2);
        request.onupgradeneeded = () => {
          const db = request.result;
          const outbox = db.createObjectStore('outbox', { keyPath: 'id' });
          outbox.createIndex('createdAt', 'createdAt');
          outbox.createIndex('table', 'table');
          const records = db.createObjectStore('records', { keyPath: ['table', 'id'] });
          records.createIndex('table', 'table');
          records.createIndex('updatedAt', 'updatedAt');
          records.createIndex('syncedAt', 'syncedAt');
          db.createObjectStore('meta', { keyPath: 'key' });
          db.createObjectStore('weather', { keyPath: 'key' });
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('records', 'readwrite');
          tx.objectStore('records').put(record);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }),
    seeded,
  );

  // Die echte App öffnet Dexie jetzt zum ersten Mal in diesem Browser-Kontext —
  // das ist der Versions-Bump 2 -> 3 (journalConflicts kommt dazu).
  await registerPasskey(page);

  const records = await page.evaluate(() => window.__starship.debugRecords());
  const survivor = records.find((r) => r.id === 'seed-vor-dem-bump');
  expect(survivor?.data.title).toBe('Vor dem Bump');
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
