import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Client } from 'pg';
import {
  FIXED_NOW,
  freezeClock,
  installClockAt,
  openSecondDevice,
  registerPasskey,
  resetAppData,
  settleJournalHabitBoot,
  withDb,
} from './helpers';

/**
 * S2 of #302 (issue #338): journal_entries + journal_keys, the Dexie bump, the
 * SYNC_REGISTRY entries and the pull-side conflict copy. Every test drives the
 * real write path (src/features/journal/write.ts) via the E2E bridge
 * (src/ui/e2e-bridge.tsx), never a duplicated stand-in.
 *
 * issue #376/ADR-0018 replaced "one entry per day, deterministic id" with
 * "any number of entries per day, random uuidv7 id" — the old AC5 (same day ->
 * same row) and AC6 (same-day concurrent create -> deterministic-id collision
 * -> conflict copy) tests tested exactly the invariant that is now gone; they
 * are replaced below by the AC8 test proving the opposite (two devices, same
 * day, two independent rows, no overwrite).
 */

test.beforeEach(async () => {
  await resetAppData();
});

/* -------------------------------------------------------------------------- */
/* issue #338: offline geschrieben -> online -> serverseitig angekommen, kein */
/* Klartext-Fragment (CLAUDE.md Regel 9)                                      */
/* -------------------------------------------------------------------------- */

test('offline geschriebener Eintrag erreicht online die Datenbank ohne Klartext-Fragment', async ({
  page,
  context,
}) => {
  await registerPasskey(page);
  await settleJournalHabitBoot(page);
  await context.setOffline(true);

  const entryDate = '2026-07-29';
  const passphrase = 'offline passphrase';
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
/* issue #338 AC3: bestehende lokale Daten überleben den Dexie-Versions-Bump  */
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
  // dabei ein zweites Mal — und prüft, dass der Record noch da ist UND der
  // `journalConflicts`-Store (issue #338, entfernt in #477/ADR-0018 über Version 5)
  // tatsächlich weg ist. Schwächer als eine echte Alt-Installation, aber
  // deterministisch und beweist denselben Kern der AC: bestehende Daten übersteht
  // einen Dexie-Reopen, auf dem sich die Store-Liste verändert hat.
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
  expect(storeNames).not.toContain('journalConflicts');
});

/* -------------------------------------------------------------------------- */
/* issue #338 AC2: Down-Pfad entfernt journal_entries/journal_keys, Up-Pfad   */
/* stellt sie wieder her — in einer rückgerollten Transaktion                */
/* -------------------------------------------------------------------------- */

async function tableExists(client: Client, name: string): Promise<boolean> {
  const { rows } = await client.query('SELECT to_regclass($1) AS reg', [name]);
  return rows[0].reg !== null;
}

test('AC2 (#338): Down-Pfad von 0012 räumt sauber ab, Up-Pfad stellt wieder her, andere Tabellen bleiben unberührt', async () => {
  const downSql = readFileSync(
    path.join(__dirname, '../src/db/migrations/down/0012_journal.down.sql'),
    'utf8',
  );
  const upSql = readFileSync(
    path.join(__dirname, '../src/db/migrations/0012_sweet_impossible_man.sql'),
    'utf8',
  );

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
/* issue #376: Migration 0014 (created_at, entry_date nicht mehr eindeutig)   */
/* -------------------------------------------------------------------------- */

test('Down-Pfad von 0014 entfernt created_at und macht entry_date wieder eindeutig, Up-Pfad stellt beides wieder her', async () => {
  const downSql = readFileSync(
    path.join(__dirname, '../src/db/migrations/down/0014_journal_multiple_entries.down.sql'),
    'utf8',
  );
  const upSql = readFileSync(path.join(__dirname, '../src/db/migrations/0014_steep_james_howlett.sql'), 'utf8');

  async function columns(client: Client): Promise<string[]> {
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'journal_entries'`,
    );
    return rows.map((r) => r.column_name as string);
  }

  async function entryDateIsUnique(client: Client): Promise<boolean> {
    const { rows } = await client.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'journal_entries' AND indexname = 'journal_entries_entry_date_idx'`,
    );
    return (rows[0]?.indexdef as string | undefined)?.includes('UNIQUE') ?? false;
  }

  await withDb(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(downSql);
      expect(await columns(client)).not.toContain('created_at');
      expect(await entryDateIsUnique(client)).toBe(true);

      await client.query(upSql);
      expect(await columns(client)).toContain('created_at');
      expect(await entryDateIsUnique(client)).toBe(false);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* issue #342 AC3: journal_entries trägt kein neues Klartext-*Inhalts*-Feld — */
/* created_at ist Metadaten (Zeitpunkt), kein Journal-Inhalt (ADR-0004/-0018) */
/* -------------------------------------------------------------------------- */

test('AC3 (#342): journal_entries trägt kein neues Klartext-Inhaltsfeld — nur die bekannten Spalten plus created_at', async () => {
  const columns = await withDb((client) =>
    client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'journal_entries'`,
    ),
  );

  expect(new Set(columns.rows.map((r) => r.column_name as string))).toEqual(
    new Set([
      'id',
      'updated_at',
      'deleted_at',
      'synced_at',
      'sync_seq',
      'entry_date',
      'ciphertext',
      'nonce',
      'created_at',
    ]),
  );
});

/* -------------------------------------------------------------------------- */
/* issue #376: der Editor — Absenden statt Autosave, mehrere Einträge pro Tag */
/* Baut auf S3a (#339, journal-lock.spec.ts) auf.                            */
/* -------------------------------------------------------------------------- */

const EDITOR_PASSPHRASE = '376 editor passphrase';

/** Same wait-for-settled-state reasoning as journal-lock.spec.ts's setUpJournal:
 * journalSetup() derives a key and writes before the button resolves. */
async function setUpEditor(page: Page, passphrase = EDITOR_PASSPHRASE): Promise<void> {
  await registerPasskey(page);
  await page.goto('/journal');
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('Passphrase wiederholen').fill(passphrase);
  await page.getByRole('button', { name: 'Einrichten' }).click();
  await page.getByTestId('journal-recovery-key').waitFor();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();
}

async function unlockEditor(page: Page, passphrase = EDITOR_PASSPHRASE): Promise<void> {
  await page.locator('.journal-gate[data-state="locked"]').waitFor();
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Entsperren', exact: true }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();
}

/** Opens the create sheet (AK2, #701) — while the sheet is closed, only the
 * FAB carries the accessible name "Eintragen" (the form is unmounted, see
 * journal-entry-sheet.tsx), so the plain role query is still unambiguous. */
async function openSheet(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Eintragen', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Eintragen' })).toBeVisible();
}

/** Once the sheet is open, the FAB and the sheet's own submit button share the
 * accessible name "Eintragen" (Sheet, by design, leaves the trigger untouched
 * — see src/ui/sheet.tsx) — scope to the dialog first (issue #714: the action
 * now lives in the shared sheet header, `.sheet__action`, not a form-local
 * button). */
async function submit(page: Page): Promise<void> {
  await page.getByRole('dialog', { name: 'Eintragen' }).locator('.sheet__action').click();
  await expect(page.getByRole('dialog', { name: 'Eintragen' })).toBeHidden();
}

/** Sets (or, with '', clears) the mood via the native select (issue #785,
 * replaces the ten-point MoodScale in the create sheet). Scoped to the open
 * dialog — the 14-day mood band (issue #703, journal-mood-band.tsx) sits on
 * the same page and also carries "Stimmung" in its aria-labels once at least
 * one entry exists, which made the unscoped `page.getByLabel('Stimmung')`
 * ambiguous as soon as a prior entry had been submitted. */
async function setMood(page: Page, value: number | ''): Promise<void> {
  await page
    .getByRole('dialog', { name: 'Eintragen' })
    .getByLabel('Stimmung')
    .selectOption(String(value));
}

async function entryCountInDb(entryDate: string): Promise<number> {
  const rows = await withDb((client) =>
    client.query('SELECT count(*)::int AS n FROM journal_entries WHERE entry_date = $1', [entryDate]),
  );
  return rows.rows[0].n as number;
}

/** Same probe-element pattern as habits-week-grid.spec.ts's resolveBackgroundToken —
 * compares against the real token value instead of a hardcoded colour string, so a
 * later token-value change elsewhere can't silently break this assertion. */
async function resolveBackgroundToken(page: Page, token: string): Promise<string> {
  return page.evaluate((cssVar) => {
    const probe = document.createElement('div');
    probe.style.background = `var(${cssVar})`;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }, token);
}

test('AK2 (#700/#701): der FAB öffnet ein Sheet mit Mood/Text/Tags, trägt die Journal-Bereichsfarbe statt der App-Akzentfarbe, kein Formular auf der Seite selbst', async ({
  page,
}) => {
  await setUpEditor(page);

  const fab = page.getByRole('button', { name: 'Eintragen', exact: true });
  const fabBg = await fab.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(fabBg).toBe(await resolveBackgroundToken(page, '--area-journal'));
  expect(fabBg).not.toBe(await resolveBackgroundToken(page, '--area-tasks'));

  // Kein Formular sichtbar, bevor der FAB geklickt wurde.
  await expect(page.locator('.journal-editor__form')).toHaveCount(0);

  await openSheet(page);
  const dialog = page.getByRole('dialog', { name: 'Eintragen' });
  await expect(dialog.getByLabel('Stimmung')).toBeVisible();
  await expect(dialog.getByLabel('Journal-Text')).toBeVisible();
  await expect(dialog.getByLabel('Tags')).toBeVisible();
});

test('AK2 (#714, seit #785 vertauscht): Stimmung und Tags stehen jetzt vor der Textfläche in der Fußleiste, die Textfläche dominiert weiterhin die Höhe', async ({
  page,
}) => {
  await setUpEditor(page);
  await openSheet(page);

  // Sheet.tsx's enter transition (translateY 100% -> 0) is still running right
  // after openSheet()'s toBeVisible() resolves — boundingBox() includes the
  // in-flight transform, and a native <select> vs a plain <input> settle onto
  // the final position via different paint paths, which can read a sub-pixel
  // apart mid-transition (same failure mode as checkoff-motion.spec.ts, issue
  // #430; already guarded this way in the AC3 test below). Wait for it to
  // settle first.
  const sheetContent = page.getByRole('dialog', { name: 'Eintragen' }).locator('.sheet__content');
  await sheetContent.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));

  const textBox = await page.locator('.journal-editor__text').boundingBox();
  const moodBox = await page.getByLabel('Stimmung').boundingBox();
  const tagsBox = await page.getByLabel('Tags').boundingBox();
  expect(textBox).not.toBeNull();
  expect(moodBox).not.toBeNull();
  expect(tagsBox).not.toBeNull();

  expect(moodBox!.y).toBeLessThan(textBox!.y);
  expect(tagsBox!.y).toBeLessThan(textBox!.y);
  expect(moodBox!.y).toBe(tagsBox!.y);
  expect(textBox!.height).toBeGreaterThan(moodBox!.height);
  expect(textBox!.height).toBeGreaterThan(tagsBox!.height);
});

test('AC2 (#785): selectOption setzt die Stimmung, selectOption(\'\') nimmt sie zurück', async ({
  page,
}) => {
  await setUpEditor(page);
  await openSheet(page);

  const select = page.getByLabel('Stimmung');
  await expect(select).toHaveValue('');
  await setMood(page, 7);
  await expect(select).toHaveValue('7');
  await setMood(page, '');
  await expect(select).toHaveValue('');

  await page.getByLabel('Journal-Text').fill('Ohne Stimmung abgesendet');
  await submit(page);
  // Scoped auf das Mood-Badge (journal-editor.tsx), nicht auf den ganzen Eintrag —
  // der eingegebene Text selbst enthält "Stimmung" als Substring.
  await expect(page.locator('.journal-editor__entry-mood')).toHaveCount(0);
});

test('AC1: ein gesetzter Mood-Wert allein schreibt noch nichts — erst der Eintragen-Knopf legt einen Eintrag an', async ({
  page,
}) => {
  await setUpEditor(page);
  await openSheet(page);

  await setMood(page, 8);
  // Kein Debounce mehr (ADR-0018) — ein Mood-Select-Change ruft nur setMood(),
  // kein async Schreibpfad, die Prüfung braucht also keine Wartezeit. Lokal
  // statt gegen Postgres geprüft (AC8 deckt den Server-Sync-Pfad separat ab)
  // — kein window.__starship.sync() nötig, der ohnehin erst alle 30s
  // automatisch liefe.
  await expect(page.locator('.journal-editor__entry')).toHaveCount(0);

  await submit(page);
  await expect(page.locator('.journal-editor__entry')).toHaveCount(1);
});

test('AC3 (#785): Auswahlfeld und Tags-Feld bleiben bei 375px kompakt in einer Reihe, ohne horizontalen Scroll', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await setUpEditor(page);
  await openSheet(page);

  // Sheet.tsx's enter transition (translateY 100% -> 0) is still running right
  // after openSheet()'s toBeVisible() resolves — boundingBox() includes the
  // in-flight transform, so reading positions too early makes the height
  // comparisons below flaky by sub-pixel amounts (same failure mode as
  // checkoff-motion.spec.ts, issue #430). Wait for it to settle first.
  const sheetContent = page.getByRole('dialog', { name: 'Eintragen' }).locator('.sheet__content');
  await sheetContent.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));

  const form = page.locator('.journal-editor__form');
  const scrollWidth = await form.evaluate((el) => el.scrollWidth);
  const clientWidth = await form.evaluate((el) => el.clientWidth);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

  const moodBox = await page.getByLabel('Stimmung').boundingBox();
  const tagsBox = await page.getByLabel('Tags').boundingBox();
  expect(moodBox).not.toBeNull();
  expect(tagsBox).not.toBeNull();
  expect(moodBox!.height).toBeGreaterThanOrEqual(44);
  expect(tagsBox!.height).toBeGreaterThanOrEqual(44);

  const footerBox = await page.locator('.journal-editor__footer').boundingBox();
  expect(footerBox).not.toBeNull();
  expect(footerBox!.height).toBeLessThanOrEqual(48);

  const docScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const docClientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(docScrollWidth).toBeLessThanOrEqual(docClientWidth);
});

test('AC2/AC3: das Sheet schließt nach dem Absenden, ein neu geöffnetes startet leer; mehrere Einträge stehen darunter, neueste zuerst, mit Uhrzeit', async ({
  page,
}) => {
  await setUpEditor(page);

  await openSheet(page);
  await page.getByLabel('Journal-Text').fill('Erster Eintrag');
  await submit(page);

  await expect(page.locator('.journal-editor__entry')).toHaveCount(1);

  // Create-Sheet startet bei jedem Öffnen leer (#701) — das ersetzt die alte
  // "Feld leer nach dem Absenden"-Prüfung, die ein sichtbar bleibendes
  // Formular voraussetzte.
  await openSheet(page);
  await expect(page.getByLabel('Journal-Text')).toHaveValue('');

  await page.getByLabel('Journal-Text').fill('Zweiter Eintrag');
  await submit(page);

  const entries = page.locator('.journal-editor__entry');
  await expect(entries).toHaveCount(2);
  // Neuester zuerst.
  await expect(entries.nth(0)).toContainText('Zweiter Eintrag');
  await expect(entries.nth(1)).toContainText('Erster Eintrag');
  await expect(entries.nth(0).locator('.journal-editor__entry-time')).toHaveText(/^\d{2}:\d{2}$/);
});

test('mehrere Einträge stehen nach Neuladen und erneutem Entsperren weiterhin da — aus dem Chiffrat, nicht aus einem Klartextfeld', async ({
  page,
}) => {
  await setUpEditor(page);

  await openSheet(page);
  await page.getByLabel('Journal-Text').fill('Erster Eintrag');
  await submit(page);
  await openSheet(page);
  await page.getByLabel('Journal-Text').fill('Zweiter Eintrag');
  await submit(page);
  await expect(page.locator('.journal-editor__entry')).toHaveCount(2);

  await page.reload();
  await unlockEditor(page);

  const entries = page.locator('.journal-editor__entry');
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(0)).toContainText('Zweiter Eintrag');
  await expect(entries.nth(1)).toContainText('Erster Eintrag');
});

test('AC4: Stimmung und Tags gehören zum einzelnen Eintrag, nicht zum Tag — zwei Einträge tragen unterschiedliche Werte', async ({
  page,
}) => {
  await installClockAt(page);
  await setUpEditor(page);
  const entryDate = await page.evaluate(
    (iso) => new Date(iso).toLocaleDateString('en-CA'),
    FIXED_NOW,
  );

  await openSheet(page);
  await setMood(page, 5);
  await page.getByLabel('Journal-Text').fill('Ruhiger Moment');
  await page.getByLabel('Tags').fill('arbeit, sport');
  await submit(page);

  await openSheet(page);
  await setMood(page, 9);
  await page.getByLabel('Journal-Text').fill('Anderer Moment, andere Stimmung');
  await page.getByLabel('Tags').fill('familie');
  await submit(page);

  const entries = page.locator('.journal-editor__entry');
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(0)).toContainText('Stimmung 9/10');
  await expect(entries.nth(0).locator('.journal-editor__entry-tag')).toHaveText(['familie']);
  await expect(entries.nth(1)).toContainText('Stimmung 5/10');
  await expect(entries.nth(1).locator('.journal-editor__entry-tag')).toHaveText(['arbeit', 'sport']);

  // Server-Sync ist sonst passiv (alle 30s) — explizit anstoßen, statt auf das
  // Intervall zu warten (Muster wie jede andere withDb()-Prüfung in dieser Datei).
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => entryCountInDb(entryDate)).toBe(2);
});

test('AK4 (#700/#701)/AC6 (#785): Tags erscheinen als einzelne Pillen unter dem Eintragstext, aus --surface-raised/--area-journal', async ({
  page,
}) => {
  await setUpEditor(page);

  await openSheet(page);
  await page.getByLabel('Journal-Text').fill('Eintrag mit drei Tags');
  await page.getByLabel('Tags').fill('eins, zwei, drei');
  await submit(page);

  const pills = page.locator('.journal-editor__entry-tag');
  await expect(pills).toHaveCount(3);
  await expect(pills).toHaveText(['eins', 'zwei', 'drei']);

  const pillBg = await pills.first().evaluate((el) => getComputedStyle(el).backgroundColor);
  const pillBorder = await pills.first().evaluate((el) => getComputedStyle(el).borderColor);
  expect(pillBg).toBe(await resolveBackgroundToken(page, '--surface-raised'));
  expect(pillBorder).toBe(await resolveBackgroundToken(page, '--area-journal'));
});

test('AC5: ein abgesendeter Eintrag lässt sich löschen — Soft-Delete über den bestehenden Sync-Pfad, kein Hard-Delete', async ({
  page,
}) => {
  await installClockAt(page);
  await setUpEditor(page);
  const entryDate = await page.evaluate(
    (iso) => new Date(iso).toLocaleDateString('en-CA'),
    FIXED_NOW,
  );

  await openSheet(page);
  await page.getByLabel('Journal-Text').fill('Wird gelöscht');
  await submit(page);
  await expect(page.locator('.journal-editor__entry')).toHaveCount(1);

  await page.getByRole('button', { name: 'Eintrag löschen' }).click();
  await expect(page.locator('.journal-editor__entry')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeHidden();

  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT deleted_at FROM journal_entries WHERE entry_date = $1', [entryDate]),
  );
  expect(row.rowCount).toBe(1); // Soft-Delete: die Zeile existiert weiterhin.
  expect(row.rows[0].deleted_at).not.toBeNull();
});

test('AC5: offline gelöschter Eintrag bleibt ohne Rückgängig-Popup weg und erreicht online den Server als Tombstone', async ({
  page,
  context,
}) => {
  await installClockAt(page);
  await setUpEditor(page);
  // setUpEditor's own "Einrichten" (journal_keys envelope write) and the
  // boot-time Journal-habit creation (issue #505 AC1, same ripple
  // settleJournalHabitBoot documents) can both still be sitting in the
  // outbox at this point — drain them while still online, before the
  // offline scenario's own exact-size assertion below.
  await settleJournalHabitBoot(page);
  const entryDate = await page.evaluate(
    (iso) => new Date(iso).toLocaleDateString('en-CA'),
    FIXED_NOW,
  );

  await openSheet(page);
  await page.getByLabel('Journal-Text').fill('Offline gelöscht');
  await submit(page);
  await expect(page.locator('.journal-editor__entry')).toHaveCount(1);

  await context.setOffline(true);
  await page.getByRole('button', { name: 'Eintrag löschen' }).click();
  await expect(page.locator('.journal-editor__entry')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeHidden();
  // Two entries for the create (journal_entries + the auto-checked-off Journal
  // habit, issue #505 AC4 — appendJournalEntry's logJournalHabit call), one
  // more for the delete — all three still queued offline.
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(3);

  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT deleted_at FROM journal_entries WHERE entry_date = $1', [entryDate]),
  );
  expect(row.rowCount).toBe(1);
  expect(row.rows[0].deleted_at).not.toBeNull();
});

/* -------------------------------------------------------------------------- */
/* issue #505 AC4: ein abgesendeter Eintrag hakt die Journal-Routine ab    */
/* -------------------------------------------------------------------------- */

async function journalHabitLogRows(entryDate: string): Promise<Array<{ id: string; done: boolean }>> {
  const rows = await withDb((client) =>
    client.query(
      `SELECT hl.id, hl.done FROM habit_logs hl
       JOIN habits h ON h.id = hl.habit_id
       WHERE h.name = 'Journal' AND hl.log_date = $1 AND hl.deleted_at IS NULL`,
      [entryDate],
    ),
  );
  return rows.rows;
}

test('AC4 (#505): ein abgesendeter Eintrag hakt die Journal-Routine für den Tag ab, ein zweiter Eintrag erzeugt keinen zweiten Log', async ({
  page,
}) => {
  await installClockAt(page);
  await setUpEditor(page);
  const entryDate = await page.evaluate(
    (iso) => new Date(iso).toLocaleDateString('en-CA'),
    FIXED_NOW,
  );

  await openSheet(page);
  await page.getByLabel('Journal-Text').fill('Erster Eintrag');
  await submit(page);
  // submit() only clicks — appendJournalEntry (entry.ts) keeps running after the
  // click resolves, and logJournalHabit is its *last* await. Racing straight into
  // sync() below can catch it between the journal_entries write and the habit_logs
  // one, pushing the entry but not yet the log. The rendered entry is the signal
  // that the whole chain, auto-log included, has settled.
  await expect(page.locator('.journal-editor__entry').filter({ hasText: 'Erster Eintrag' })).toBeVisible();
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => journalHabitLogRows(entryDate)).toHaveLength(1);
  const [first] = await journalHabitLogRows(entryDate);
  expect(first.done).toBe(true);

  await openSheet(page);
  await page.getByLabel('Journal-Text').fill('Zweiter Eintrag');
  await submit(page);
  await expect(page.locator('.journal-editor__entry').filter({ hasText: 'Zweiter Eintrag' })).toBeVisible();
  await page.evaluate(() => window.__starship.sync());

  // Idempotent (ADR-0018): der zweite Eintrag am selben Tag findet die bestehende
  // Log-Zeile wieder statt eine zweite gegen UNIQUE(habit_id, log_date) anzulegen.
  const rows = await journalHabitLogRows(entryDate);
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe(first.id);
  expect(rows[0].done).toBe(true);
});

/* -------------------------------------------------------------------------- */
/* issue #505 AC1: das aktive Journal-Modul legt genau eine feste Routine  */
/* an, ein zweiter Boot (Reload) keine zweite                                 */
/* -------------------------------------------------------------------------- */

test('AC1 (#505): das Journal-Modul legt genau eine Journal-Routine an, ein zweiter Boot keine zweite', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/uebersicht');

  await expect
    .poll(async () => {
      const records = await page.evaluate(() => window.__starship.debugRecords());
      return records.filter((r) => r.table === 'habits' && r.data.name === 'Journal').length;
    })
    .toBe(1);
  await page.evaluate(() => window.__starship.sync());

  const rows = await withDb((client) =>
    client.query("SELECT id, schedule, color, archived_at FROM habits WHERE name = 'Journal'"),
  );
  expect(rows.rowCount).toBe(1);
  expect(rows.rows[0].schedule).toBe('daily');
  expect(rows.rows[0].color).toBe('--area-journal');
  expect(rows.rows[0].archived_at).toBeNull();
  const habitId = rows.rows[0].id as string;

  // Zweiter Boot (Reload) — Anlegen ist idempotent auf Existenz, nicht auf "wurde
  // je aufgerufen" (issue #505 AC1): keine zweite Zeile, dieselbe id wie zuvor.
  await page.reload();
  await expect
    .poll(async () => {
      const records = await page.evaluate(() => window.__starship.debugRecords());
      return records.filter((r) => r.table === 'habits' && r.data.name === 'Journal').length;
    })
    .toBe(1);
  await page.evaluate(() => window.__starship.sync());

  const rowsAfter = await withDb((client) => client.query("SELECT id FROM habits WHERE name = 'Journal'"));
  expect(rowsAfter.rowCount).toBe(1);
  expect(rowsAfter.rows[0].id).toBe(habitId);
});

/* -------------------------------------------------------------------------- */
/* issue #374: Datum im Journal-Kopf, Eintrag trägt den Tag des Absendens     */
/* -------------------------------------------------------------------------- */

const JOURNAL_DATE_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  weekday: 'short',
  day: 'numeric',
  month: 'long',
});

const WEEKDAY_LONG_FORMATTER = new Intl.DateTimeFormat('de-DE', { weekday: 'long' });

test('AK3 (#700/#701, Nachfolger von #374 AC1): „Heute · <Wochentag>“ steht über der Eintragsliste des heutigen Tages', async ({
  page,
}) => {
  await installClockAt(page);
  await setUpEditor(page);

  await openSheet(page);
  await page.getByLabel('Journal-Text').fill('Eintrag für heute');
  await submit(page);

  const header = page.locator('.journal-editor__day-header');
  await expect(header).toHaveText(`Heute · ${WEEKDAY_LONG_FORMATTER.format(new Date(FIXED_NOW))}`);

  const headerBox = await header.boundingBox();
  const listBox = await page.locator('.journal-editor__entries').boundingBox();
  expect(headerBox).not.toBeNull();
  expect(listBox).not.toBeNull();
  expect(headerBox!.y).toBeLessThan(listBox!.y);
});

test('AK3 (#700/#701, Nachfolger von #423): Tagesköpfe zeigen Heute/Gestern/Datum, Tagesgruppen absteigend sortiert', async ({
  page,
}) => {
  await installClockAt(page);
  await setUpEditor(page);

  // FIXED_NOW ist der 18.07.2026 — vorgestern und gestern über den E2E-Bridge-Pfad
  // geseedet (wie AC2 #480 unten), damit der Test nicht auf eine Mitternachts-
  // Grenze der Fake-Uhr angewiesen ist.
  await page.evaluate(async () => {
    await window.__starship.appendJournalEntry('2026-07-16', { text: 'Vorgestern geschrieben', tags: [] });
    await window.__starship.appendJournalEntry('2026-07-17', { text: 'Gestern geschrieben', tags: [] });
  });
  await expect(page.locator('.journal-editor__day-header')).toHaveCount(2);

  await openSheet(page);
  await page.getByLabel('Journal-Text').fill('Heute geschrieben');
  await submit(page);

  const headers = page.locator('.journal-editor__day-header');
  await expect(headers).toHaveCount(3);
  await expect(headers.nth(0)).toHaveText(`Heute · ${WEEKDAY_LONG_FORMATTER.format(new Date(FIXED_NOW))}`);
  await expect(headers.nth(1)).toHaveText('Gestern');
  await expect(headers.nth(2)).toHaveText(JOURNAL_DATE_FORMATTER.format(new Date(2026, 6, 16)));
});

test('issue #469: das heutige Datum steht neben der Überschrift "Journal", auf deren Höhe, oben rechts', async ({
  page,
}) => {
  await installClockAt(page);
  await registerPasskey(page);
  await page.goto('/journal');

  const heading = page.getByRole('heading', { name: 'Journal', exact: true });
  const headerDate = page.locator('.journal-header-date');
  await expect(heading).toBeVisible();
  await expect(headerDate).toHaveText(JOURNAL_DATE_FORMATTER.format(new Date(FIXED_NOW)));

  const headingBox = await heading.boundingBox();
  const dateBox = await headerDate.boundingBox();
  expect(headingBox).not.toBeNull();
  expect(dateBox).not.toBeNull();

  // Auf Höhe: vertikale Ausdehnung von Datum und Überschrift überlappt.
  expect(dateBox!.y).toBeLessThan(headingBox!.y + headingBox!.height);
  expect(dateBox!.y + dateBox!.height).toBeGreaterThan(headingBox!.y);
  // Rechts: das Datum liegt rechts von der Überschrift.
  expect(dateBox!.x).toBeGreaterThan(headingBox!.x + headingBox!.width);
});

test('AK4 (#714, ehem. AC-D/#423): der Eintragen-Knopf in der Kopfzeile ist blass und wirkungslos, solange weder Stimmung noch Text gesetzt sind', async ({
  page,
}) => {
  await setUpEditor(page);
  await openSheet(page);

  // Die FAB trägt denselben Namen (AK2, #701) und bleibt im offenen Sheet
  // unverändert im DOM (src/ui/sheet.tsx rührt den Trigger nicht an) — auf den
  // Dialog scopen, sonst träfe das hier auch die FAB.
  const action = page.getByRole('dialog', { name: 'Eintragen' }).locator('.sheet__action');
  await expect(action).toBeVisible();
  await expect(action).toBeDisabled();

  // Ein disabled Submit-Button submittet nicht (native Browser-Semantik) —
  // force, weil Playwright einen disabled-Klick sonst gar nicht erst versucht.
  await action.click({ force: true });
  await expect(page.locator('.journal-editor__entry')).toHaveCount(0);

  await setMood(page, 6);
  await expect(action).toBeEnabled();
  await setMood(page, ''); // zurücknehmen
  await expect(action).toBeDisabled();

  await page.getByLabel('Journal-Text').fill('Nur Text, kein Mood');
  await expect(action).toBeEnabled();
  await page.getByLabel('Journal-Text').fill('');
  await expect(action).toBeDisabled();

  // Nur Tags reicht nicht (AK4).
  await page.getByLabel('Tags').fill('privat');
  await expect(action).toBeDisabled();
});

test('AC2/AC3: bleibt die App über Mitternacht offen, trägt ein danach abgesendeter Eintrag den neuen Kalendertag und erscheint unter „Heute · <neuer Wochentag>“', async ({
  page,
}) => {
  const now = new Date(FIXED_NOW);
  const beforeMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 58, 0, 0);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const tomorrowKey = tomorrow.toLocaleDateString('en-CA');

  await installClockAt(page, beforeMidnight.toISOString());
  await setUpEditor(page);

  await freezeClock(page);
  await page.clock.fastForward(5 * 60 * 1000); // über Mitternacht, ohne Neuladen

  // Ab hier ist der deterministische Fast-Forward erledigt. Die Uhr läuft
  // wieder in Echtzeit, damit Dexies liveQuery-Signal nach dem Absenden
  // geflusht wird (unter angehaltener Fake-Uhr feuert der gefakte Timer der
  // Zustellung nicht, die Tagesliste bliebe leer). In Produktion steht die
  // Uhr nie — dieser Zustand ist ein reines Testartefakt.
  await page.clock.resume();

  // Kein eigener Tages-State mehr, der über Mitternacht "rollen" könnte
  // (#701 entfernt den entryDate-State + Mitternachts-Timer) — der Beweis ist
  // der Tageskopf, unter dem der neue Eintrag tatsächlich erscheint.
  await openSheet(page);
  await page.getByLabel('Journal-Text').fill('Nach Mitternacht geschrieben');
  await submit(page);
  await expect(page.locator('.journal-editor__entry')).toHaveCount(1);
  await expect(page.locator('.journal-editor__day-header')).toHaveText(
    `Heute · ${WEEKDAY_LONG_FORMATTER.format(tomorrow)}`,
  );

  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => entryCountInDb(tomorrowKey)).toBe(1);
});

/* -------------------------------------------------------------------------- */
/* issue #376 AC8: das Kernszenario — zwei Geräte legen offline unabhängig    */
/* je einen Eintrag für denselben Tag an. Vor #376 kollidierten deren ids     */
/* (deterministisch aus entry_date, ADR-0017) und einer verdrängte den        */
/* anderen; seit #376 ist die id zufällig (uuidv7) — beide Einträge landen    */
/* nebeneinander, keiner überschreibt den anderen, kein Konflikt entsteht.    */
/* -------------------------------------------------------------------------- */

test('AC8: zwei Geräte legen offline unabhängig je einen Eintrag für denselben Tag an — keiner überschreibt den anderen', async ({
  page,
  browser,
}) => {
  const entryDate = '2026-07-29';
  await registerPasskey(page);
  const deviceB = await openSecondDevice(browser, page);

  // writeJournalEntry braucht keinen DEK (roher Ciphertext, wie AC7 oben) — der
  // Fokus dieses Tests ist der Sync-/id-Pfad, nicht die Verschlüsselung selbst.
  await page.evaluate((d) => window.__starship.writeJournalEntry(d, [1, 2, 3], [9, 9, 9]), entryDate);
  await deviceB.evaluate((d) => window.__starship.writeJournalEntry(d, [4, 5, 6], [8, 8, 8]), entryDate);

  await page.evaluate(() => window.__starship.sync());
  await deviceB.evaluate(() => window.__starship.sync());
  // Zweite Runde, damit beide Geräte auch die Zeile des jeweils anderen pullen.
  await page.evaluate(() => window.__starship.sync());
  await deviceB.evaluate(() => window.__starship.sync());

  expect(await entryCountInDb(entryDate)).toBe(2);

  const rows = await withDb((client) =>
    client.query('SELECT ciphertext FROM journal_entries WHERE entry_date = $1', [entryDate]),
  );
  const distinctCiphertexts = new Set(rows.rows.map((r) => r.ciphertext as string));
  expect(distinctCiphertexts.size).toBe(2); // zwei verschiedene Zeilen, kein Überschreiben.

  // Kein falsch-positiver Konflikt — der Producer aus ADR-0017 Punkt 3 ist seit
  // issue #395 entfernt (er griff ohnehin nur bei einer id-Kollision, die es seit
  // ADR-0018 nicht mehr geben kann); der Store selbst ist seit #477 entfernt.
});

/* -------------------------------------------------------------------------- */
/* issue #394 (Fund aus #377 Punkt 3): debugDumpStores (e2e-bridge.tsx)       */
/* serialisierte bis #477 auch journalConflicts (Store seither entfernt).    */
/* Diese zwei Tests beweisen aktiv, dass die Verdrängung eines Eintrags       */
/* KEINEN Klartext in einem JSON-serialisierbaren Store hinterlässt und dass  */
/* die Tagesliste (mehrere Einträge an einem Tag, #376) es ebenso wenig tut   */
/* (Regel 9).                                                                */
/*                                                                            */
/* #395 (Owner-Entscheidung „B", 30.07.): AC1 hat ursprünglich zusätzlich     */
/* behauptet, die Verdrängung LEGE eine Konflikt-Kopie an. Mit dem Entfernen  */
/* des toten Producers in pull() gilt das nicht mehr — der Eintrag wird still */
/* überschrieben. Der Klartext-Beweis, der Zweck von #394, bleibt unverändert */
/* und ist hier sogar schärfer: er deckt jetzt auch den Fall ab, dass gar     */
/* keine Kopie mehr existiert, in der etwas lecken könnte.                    */
/* -------------------------------------------------------------------------- */

/**
 * Schreibt eine journal_entries-Zeile mit einer FEST VORGEGEBENEN rowId über den
 * rohen `mutate()` statt über write.ts/entry.ts — der einzige Weg, die Zeilen-id-
 * Kollision zu erzwingen, die seit #376/ADR-0018 (zufällige uuidv7 statt
 * deterministischer id) über den normalen Schreibpfad praktisch nie mehr vorkommt
 * (siehe Kommentar bei AC8 oben). `mutate` ist dafür real genug — es ist derselbe
 * Aufruf, den write.ts selbst macht, nur mit expliziter statt zufälliger rowId.
 */
async function writeRawEntry(devicePage: Page, rowId: string, entryDate: string, text: string): Promise<void> {
  await devicePage.evaluate(
    async ({ rowId, entryDate, text }) => {
      const envelope = await window.__starship.createEnvelope('raw entry passphrase', {
        name: 'PBKDF2',
        hash: 'SHA-256',
        iterations: 1000,
      });
      const dek = await window.__starship.openEnvelope(envelope, 'raw entry passphrase');
      const { ciphertext, nonce } = await window.__starship.encryptJournal(dek, { text, tags: [] });
      await window.__starship.mutate({
        table: 'journal_entries',
        rowId,
        op: 'upsert',
        payload: {
          entryDate,
          ciphertext: window.__starship.bytesToBase64(ciphertext),
          nonce: window.__starship.bytesToBase64(nonce),
        },
      });
    },
    { rowId, entryDate, text },
  );
}

test('AC1 (#394, nach #395): ein per pull() verdrängter Eintrag hinterlässt keine Konflikt-Kopie und keinen Klartext in irgendeinem Store', async ({
  page,
  browser,
  context,
}) => {
  await registerPasskey(page);
  const deviceB = await openSecondDevice(browser, page);

  const rowId = randomUUID();
  const entryDate = '2026-07-29';
  const secretA = 'GERAET-A-VERDRAENGTER-KLARTEXT';
  const secretB = 'GERAET-B-GEWINNT-KLARTEXT';

  // Offline-Pfad (AC3): beide Geräte schreiben zunächst ohne Netz.
  await context.setOffline(true);
  await deviceB.context().setOffline(true);
  await writeRawEntry(page, rowId, entryDate, secretA);
  await writeRawEntry(deviceB, rowId, entryDate, secretB);

  // Gerät A geht zuerst online: seine Zeile landet als Erste auf dem Server,
  // der anschließende pull() im selben sync() stempelt ihren echten syncSeq.
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());

  // Gerät B geht online und überschreibt dieselbe Server-Zeile mit seinem
  // eigenen Chiffrat (Push/Pull sind real, kein Stand-in).
  await deviceB.context().setOffline(false);
  await deviceB.evaluate(() => window.__starship.sync());

  // Gerät A pullt erneut: sein lokaler Stand (secretA) weicht jetzt vom Server
  // (secretB) ab — vor #395 lief das in den PRESERVE_DISPLACED-Zweig in
  // src/local/sync.ts, seitdem überschreibt der pull() die Zeile schlicht.
  await page.evaluate(() => window.__starship.sync());

  // #395: kein Producer mehr (#477: der Store selbst ist weg), also keine Kopie.
  // Der Verlust von secretA ist der bewusst akzeptierte Preis der Entscheidung,
  // nicht ein Fehlschlag dieses Tests.
  const dump = await page.evaluate(() => window.__starship.debugDumpStores());
  expect(dump).not.toContain(secretA);
  expect(dump).not.toContain(secretB);
});

test('AC2 (#394): mehrere Einträge an einem Tag, offline geschrieben, landen nie als Klartext in einem Store', async ({
  page,
  context,
}) => {
  await registerPasskey(page);
  await page.goto('/journal');
  // Offline-Pfad (AC3): Einrichten und alle drei Einträge entstehen ohne Netz.
  await context.setOffline(true);

  await page.getByLabel('Passphrase', { exact: true }).fill(EDITOR_PASSPHRASE);
  await page.getByLabel('Passphrase wiederholen').fill(EDITOR_PASSPHRASE);
  await page.getByRole('button', { name: 'Einrichten' }).click();
  await page.getByTestId('journal-recovery-key').waitFor();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();

  const secrets = ['TAGESEINTRAG-EINS-GEHEIM', 'TAGESEINTRAG-ZWEI-GEHEIM', 'TAGESEINTRAG-DREI-GEHEIM'];
  for (const text of secrets) {
    await openSheet(page);
    await page.getByLabel('Journal-Text').fill(text);
    await submit(page);
  }
  await expect(page.locator('.journal-editor__entry')).toHaveCount(secrets.length);

  const dumpOffline = await page.evaluate(() => window.__starship.debugDumpStores());
  for (const secret of secrets) expect(dumpOffline).not.toContain(secret);

  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const dumpOnline = await page.evaluate(() => window.__starship.debugDumpStores());
  for (const secret of secrets) expect(dumpOnline).not.toContain(secret);
});

/* -------------------------------------------------------------------------- */
/* issue #477 (ADR-0018): das Konflikt-Teilsystem aus #340/#376 ist entfernt  */
/* — kein Produzent mehr seit #395, Eintrags-Konflikte sind seit ADR-0018     */
/* strukturell unmöglich (jeder Eintrag eine eigene uuidv7-Zeile). Dieser     */
/* Test ersetzt den früheren Seed-Test 1:1 (Regel 5: Testzahl sinkt nicht)    */
/* und beweist stattdessen aktiv, dass Banner und Bridge-Handle weg sind.     */
/* -------------------------------------------------------------------------- */

test('Konflikt-Banner erscheint nie und das Bridge-Handle dafür existiert nicht mehr (#477)', async ({
  page,
}) => {
  await setUpEditor(page);

  await openSheet(page);
  await page.getByLabel('Journal-Text').fill('Normaler Eintrag');
  await submit(page);
  await expect(page.locator('.journal-editor__entry')).toHaveCount(1);

  await expect(page.locator('.journal-editor__conflict')).toHaveCount(0);

  const hasDebugJournalConflicts = await page.evaluate(
    () => 'debugJournalConflicts' in window.__starship,
  );
  expect(hasDebugJournalConflicts).toBe(false);
});

test('bei gesperrtem Journal ist der Editor nicht erreichbar, sondern der Entsperr-Zustand', async ({
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
  test(`AC9: Editor bei ${viewport.width}px ohne horizontalen Seiten-Scroll`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await setUpEditor(page);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
}

test('AC7 (#785, ehem. AC9): das Auswahlfeld nutzt Tokens, die sich im Dark Mode tatsächlich unterscheiden', async ({
  page,
}) => {
  await setUpEditor(page);
  await openSheet(page);
  const select = page.getByLabel('Stimmung');
  await setMood(page, 4);

  const lightBg = await select.evaluate((el) => getComputedStyle(el).backgroundColor);

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const darkBg = await select.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(darkBg).not.toBe(lightBg);
});

/* -------------------------------------------------------------------------- */
/* issue #480 (Fund F7): AES-GCM ohne AAD — Chiffrate binden seither id +      */
/* entryDate als Additional Authenticated Data. Bestehende (v1) Chiffrate ohne */
/* AAD bleiben ueber die Nonce-Laenge (12 vs. 13 Byte) weiterhin lesbar — das  */
/* deckt der feste Testvektor in src/crypto/journal.test.ts (AC5 dort) ab.    */
/* -------------------------------------------------------------------------- */

test('AC1/AC4 (#480): ein echter appendJournalEntry erzeugt eine 13-Byte-Nonce mit v2-Versionsmarke', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.evaluate((passphrase) => window.__starship.journalSetup(passphrase), '480 nonce passphrase');

  const entryDate = '2026-08-03';
  await page.evaluate(
    ({ entryDate }) => window.__starship.appendJournalEntry(entryDate, { text: 'v2-Eintrag', tags: [] }),
    { entryDate },
  );

  const records = await page.evaluate(() => window.__starship.debugRecords());
  const row = records.find((r) => r.table === 'journal_entries' && r.data.entryDate === entryDate);
  expect(row).toBeDefined();

  const nonceLength = await page.evaluate(
    (nonceB64) => Uint8Array.from(atob(nonceB64), (c) => c.charCodeAt(0)).length,
    row!.data.nonce as string,
  );
  expect(nonceLength).toBe(13);
});

test('AC2 (#480): ein serverseitig zwischen zwei Zeilen vertauschtes Chiffrat ist unter der fremden Zeile nicht mehr entschluesselbar', async ({
  page,
}) => {
  await registerPasskey(page);
  const passphrase = '480 swap passphrase';
  await page.evaluate((passphrase) => window.__starship.journalSetup(passphrase), passphrase);

  const dateA = '2026-05-03';
  const dateB = '2026-07-12';
  await page.evaluate(
    async ({ dateA, dateB }) => {
      await window.__starship.appendJournalEntry(dateA, { text: 'Eintrag vom dritten Mai', tags: [] });
      await window.__starship.appendJournalEntry(dateB, { text: 'Eintrag vom zwoelften Juli', tags: [] });
    },
    { dateA, dateB },
  );

  // Both rows must actually be synced (real `syncSeq`, empty outbox) before the
  // swap below — otherwise the page.goto()'s own SyncBoot-triggered sync() would
  // push these rows' still-queued ORIGINAL payload and pull it straight back,
  // silently undoing the local patch before the assertions ever run (the swap
  // below only ever touches `data`, never the outbox or `syncSeq`, so a later
  // pull only skips overwriting it once the row is already known-synced).
  await page.evaluate(() => window.__starship.sync());

  const records = await page.evaluate(() => window.__starship.debugRecords());
  const rowA = records.find((r) => r.table === 'journal_entries' && r.data.entryDate === dateA)!;
  const rowB = records.find((r) => r.table === 'journal_entries' && r.data.entryDate === dateB)!;

  // Simuliert einen serverseitigen Zeilentausch (F7): Zeile B traegt jetzt das
  // Chiffrat/die Nonce von Zeile A, ihr eigenes `id`/`entryDate` bleibt gleich.
  await page.evaluate(
    ({ id, ciphertext, nonce }) =>
      window.__starship.debugPatchRecord('journal_entries', id, { ciphertext, nonce }),
    { id: rowB.id, ciphertext: rowA.data.ciphertext, nonce: rowA.data.nonce },
  );

  // journalLockState() only ever leaves 'loading' once JournalGate's
  // useJournalLock() effect has mounted and run initialize() — a bare reload on
  // /uebersicht never mounts it, so the poll below would hang forever. /journal
  // is the one route that does.
  await page.goto('/journal');
  await page.locator('.journal-gate[data-state="locked"]').waitFor();
  await page.evaluate((passphrase) => window.__starship.journalUnlock(passphrase), passphrase);
  await expect.poll(() => page.evaluate(() => window.__starship.journalLockState())).toBe('unlocked');

  const entriesA = await page.evaluate((dateA) => window.__starship.listJournalEntries(dateA), dateA);
  const entriesB = await page.evaluate((dateB) => window.__starship.listJournalEntries(dateB), dateB);

  expect(entriesA).toHaveLength(1);
  expect(entriesA[0]!.content.text).toBe('Eintrag vom dritten Mai');
  expect(entriesB).toHaveLength(0);
});

/* -------------------------------------------------------------------------- */
/* issue #646: Offline-Notiz                                                  */
/* -------------------------------------------------------------------------- */

test('das entsperrte Journal bleibt offline sichtbar, mit einer ruhigen Notiz über dem Editor (issue #646 AC1/AC2)', async ({
  page,
  context,
}) => {
  await setUpEditor(page);

  await context.setOffline(true);

  // A calm status note, not a red alert — nothing here uses role="alert".
  await expect(page.getByRole('status')).toContainText(
    'Offline — dein Eintrag liegt lokal und wird verschlüsselt synchronisiert, sobald du wieder online bist.',
  );
  await expect(page.locator('.journal-editor')).toBeVisible();

  await context.setOffline(false);
});

test('die Offline-Notiz im Journal verschwindet nach dem Onlinegehen wieder, ohne Neuladen (issue #646 AC1)', async ({
  page,
  context,
}) => {
  await setUpEditor(page);

  await context.setOffline(true);
  await expect(page.getByRole('status')).toContainText('Offline');

  await context.setOffline(false);

  await expect(page.getByRole('status')).toHaveCount(0);
});

test('im gesperrten Zustand erscheint offline keine Notiz — dort gibt es nichts zu synchronisieren (issue #646 AC3)', async ({
  page,
  context,
}) => {
  await setUpEditor(page);
  await page.reload();
  await page.locator('.journal-gate[data-state="locked"]').waitFor();

  await context.setOffline(true);

  await expect(page.getByRole('status')).toHaveCount(0);

  await context.setOffline(false);
});

test('im Setup-Zustand erscheint offline keine Notiz (issue #646 AC3)', async ({
  page,
  context,
}) => {
  await registerPasskey(page);
  await page.goto('/journal');
  await page.locator('.journal-gate[data-state="setup"]').waitFor();

  await context.setOffline(true);

  await expect(page.getByRole('status')).toHaveCount(0);

  await context.setOffline(false);
});

/* -------------------------------------------------------------------------- */
/* issue #703: das 14-Tage-Stimmungsband über dem Eintragsstrom               */
/* (Tageswert = arithmetisches Mittel, #700 Q1; reiner Lesekonsument des      */
/* Sitzungs-Caches, kein zusätzlicher Entschlüssel).                          */
/* -------------------------------------------------------------------------- */

/** Seeds a set of moods across days within the 14-day window, offline first
 * (DoD-Offline-Pfad) — every entry runs through the outbox via
 * `appendJournalEntry` (entry.ts → write.ts), never a direct write. FIXED_NOW
 * is 18.07.2026, so 05.–18.07. are the fourteen days the band covers. */
async function seedMoodBandEntries(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__starship.appendJournalEntry('2026-07-10', { text: 'tief', mood: '3', tags: [] });
    await window.__starship.appendJournalEntry('2026-07-14', { text: 'hoch', mood: '9', tags: [] });
    // Zwei Stimmungen an einem Tag -> arithmetisches Mittel (4+9)/2 = 6,5 (#700 Q1).
    await window.__starship.appendJournalEntry('2026-07-16', { text: 'morgens', mood: '4', tags: [] });
    await window.__starship.appendJournalEntry('2026-07-16', { text: 'abends', mood: '9', tags: [] });
    // Ein reiner Text-Eintrag ohne Stimmung -> graue Grundlinie, kein Balken.
    await window.__starship.appendJournalEntry('2026-07-17', { text: 'nur Text', tags: [] });
    await window.__starship.appendJournalEntry('2026-07-18', { text: 'heute', mood: '7', tags: [] });
  });
}

test('AK1 (#703): das Band zeigt 14 Tagesplätze, Höhe spiegelt die Stimmung, Mehrfach-Stimmung als Mittel, leere/stimmungslose Tage als graue Grundlinie, heute markiert', async ({
  page,
  context,
}) => {
  await installClockAt(page);
  await setUpEditor(page);

  // Offline-Pfad (DoD): offline geschrieben, dann online — im Band sichtbar.
  await context.setOffline(true);
  await seedMoodBandEntries(page);
  await context.setOffline(false);

  const band = page.locator('.journal-mood-band');
  await expect(band).toBeVisible();

  const slots = page.locator('.journal-mood-band__slot');
  await expect(slots).toHaveCount(14);
  // Vier Tage mit Stimmung -> vier farbige Balken; die übrigen zehn (inkl. der
  // reine-Text-Tag) sind graue Grundlinien, kein Platz wird ausgelassen (AK1).
  await expect(page.locator('.journal-mood-band__bar')).toHaveCount(4);
  await expect(page.locator('.journal-mood-band__baseline')).toHaveCount(10);

  // Heute (18.07., letzter Platz) trägt den Marker.
  const todaySlot = slots.nth(13);
  await expect(todaySlot).toHaveAttribute('data-today', 'true');
  await expect(todaySlot).toHaveAttribute('aria-current', 'date');
  await expect(todaySlot.locator('.journal-mood-band__bar')).toHaveCount(1);

  // Reiner Text-Eintrag (17.07., vorletzter Platz) -> graue Grundlinie, kein Balken.
  await expect(slots.nth(12).locator('.journal-mood-band__baseline')).toHaveCount(1);
  await expect(slots.nth(12).locator('.journal-mood-band__bar')).toHaveCount(0);

  // Der Tag mit zwei Stimmungen (16.07.) zeigt das arithmetische Mittel 6,5.
  const meanSlot = page.locator('.journal-mood-band__slot[aria-label*="6,5"]');
  await expect(meanSlot).toHaveCount(1);

  // Höhe ∝ Stimmung: Stimmung 9 (14.07.) höher als Stimmung 3 (10.07.); das
  // Mittel 6,5 (16.07.) liegt messbar dazwischen.
  const lowBar = slots.nth(5).locator('.journal-mood-band__bar'); // 10.07., Stimmung 3
  const highBar = slots.nth(9).locator('.journal-mood-band__bar'); // 14.07., Stimmung 9
  const meanBar = meanSlot.locator('.journal-mood-band__bar'); // 16.07., Mittel 6,5
  const lowBox = await lowBar.boundingBox();
  const highBox = await highBar.boundingBox();
  const meanBox = await meanBar.boundingBox();
  expect(lowBox).not.toBeNull();
  expect(highBox).not.toBeNull();
  expect(meanBox).not.toBeNull();
  expect(highBox!.height).toBeGreaterThan(lowBox!.height);
  expect(meanBox!.height).toBeGreaterThan(lowBox!.height);
  expect(meanBox!.height).toBeLessThan(highBox!.height);

  // Mobil (375px) ohne horizontalen Seiten-Scroll trotz 14 Plätze.
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
});

test('AK8 (#703): frisch entsperrt ohne Einträge zeigt eine ruhige Notiz statt eines leeren Bands', async ({
  page,
}) => {
  await installClockAt(page);
  await setUpEditor(page);

  await expect(page.locator('.journal-mood-band__empty')).toBeVisible();
  await expect(page.locator('.journal-mood-band')).toHaveCount(0);
  await expect(page.locator('.journal-mood-band__slot')).toHaveCount(0);
});

test('AK8 (#703): wenige Einträge zeigen das vollständige Band (14 Plätze), kein zerbrochenes Gerüst und keine Notiz', async ({
  page,
}) => {
  await installClockAt(page);
  await setUpEditor(page);

  await page.evaluate(() =>
    window.__starship.appendJournalEntry('2026-07-18', { text: 'einziger', mood: '5', tags: [] }),
  );

  await expect(page.locator('.journal-mood-band')).toBeVisible();
  await expect(page.locator('.journal-mood-band__empty')).toHaveCount(0);
  await expect(page.locator('.journal-mood-band__slot')).toHaveCount(14);
  await expect(page.locator('.journal-mood-band__bar')).toHaveCount(1);
  await expect(page.locator('.journal-mood-band__baseline')).toHaveCount(13);
});

test('AK6 (#703): im Suchmodus ist das Stimmungsband abwesend', async ({ page }) => {
  await installClockAt(page);
  await setUpEditor(page);

  await page.evaluate(() =>
    window.__starship.appendJournalEntry('2026-07-18', { text: 'heute', mood: '6', tags: [] }),
  );
  await expect(page.locator('.journal-mood-band')).toBeVisible();

  // Suchmodus über die Lupe in der Titelzeile öffnen (#700 AK5).
  await page.getByRole('button', { name: 'Journal durchsuchen' }).click();
  await expect(page.locator('.journal-search')).toBeVisible();

  await expect(page.locator('.journal-mood-band')).toHaveCount(0);
  await expect(page.locator('.journal-mood-band__empty')).toHaveCount(0);
});

test('AK9 (#703): die Band-Säule füllt mit --area-journal, das sich im Dark Mode tatsächlich unterscheidet', async ({
  page,
}) => {
  await installClockAt(page);
  await setUpEditor(page);

  await page.evaluate(() =>
    window.__starship.appendJournalEntry('2026-07-18', { text: 'heute', mood: '8', tags: [] }),
  );

  const bar = page.locator('.journal-mood-band__bar').first();
  await expect(bar).toBeVisible();

  const lightBg = await bar.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(lightBg).toBe(await resolveBackgroundToken(page, '--area-journal'));

  await page.emulateMedia({ colorScheme: 'dark' });
  const darkBg = await bar.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(darkBg).not.toBe(lightBg);
  expect(darkBg).toBe(await resolveBackgroundToken(page, '--area-journal'));
});

test('AK9 (#703): prefers-reduced-motion unterdrückt die Wachs-Animation der Säule', async ({
  page,
}) => {
  await installClockAt(page);
  await setUpEditor(page);

  await page.evaluate(() =>
    window.__starship.appendJournalEntry('2026-07-18', { text: 'heute', mood: '8', tags: [] }),
  );

  const bar = page.locator('.journal-mood-band__bar').first();
  await expect(bar).toBeVisible();

  // Ohne Reduce: die Säule wächst über eine benannte Keyframe-Animation.
  expect(await bar.evaluate((el) => getComputedStyle(el).animationName)).toBe('mood-bar-grow');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await bar.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
});
