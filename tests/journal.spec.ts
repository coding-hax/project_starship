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
      // `user_id` kam mit #1200 dazu (ADR-0031): wem der Eintrag gehört, nicht
      // was darin steht. Wie `entry_date` ist das Metadatum, das der
      // inkrementelle Sync braucht — der Server lernt daraus, an wen die Zeile
      // auszuliefern ist, und weiterhin nichts über ihren Inhalt.
      'user_id',
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
  await registerPasskey(page, '/journal');
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

async function entryCountInDb(entryDate: string): Promise<number> {
  const rows = await withDb((client) =>
    client.query('SELECT count(*)::int AS n FROM journal_entries WHERE entry_date = $1', [entryDate]),
  );
  return rows.rows[0].n as number;
}

/** Opens the "N weitere Notizen" panel (AK2, #1048) — present once today
 * carries more than one entry, revealing every entry but the day's line
 * (the first created, AK2) via the existing `.journal-editor__entry` markup. */
async function expandMoreNotes(page: Page): Promise<void> {
  await page.locator('.journal-day-card__more').click();
}

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
  await expect(page.locator('.journal-day-card__more')).toHaveText('1 weitere Notiz');

  await page.reload();
  await unlockEditor(page);

  await expect(page.locator('.journal-day-card__line')).toHaveText('Erster Eintrag');
  await expandMoreNotes(page);
  await expect(page.locator('.journal-editor__entry')).toHaveCount(1);
  await expect(page.locator('.journal-editor__entry').first()).toContainText('Zweiter Eintrag');
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
  await expect(page.locator('.journal-day-card__line')).toHaveText('Offline gelöscht');

  await context.setOffline(true);
  await page.getByRole('button', { name: 'Eintrag löschen' }).click();
  await expect(page.locator('.journal-day-card--empty')).toBeVisible();
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
  await expect(page.locator('.journal-day-card__line')).toHaveText('Erster Eintrag');
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => journalHabitLogRows(entryDate)).toHaveLength(1);
  const [first] = await journalHabitLogRows(entryDate);
  expect(first.done).toBe(true);

  await openSheet(page);
  await page.getByLabel('Journal-Text').fill('Zweiter Eintrag');
  await submit(page);
  // Die Zeile des Tages bleibt der zuerst angelegte Eintrag (AK1) — der
  // zweite landet hinter AK2's "1 weitere Notiz", ist aber trotzdem das
  // Signal, dass auch sein Schreibpfad (inkl. Habit-Log) durchgelaufen ist.
  await expect(page.locator('.journal-day-card__more')).toHaveText('1 weitere Notiz');
  await page.evaluate(() => window.__starship.sync());

  // Idempotent (ADR-0018): der zweite Eintrag am selben Tag findet die bestehende
  // Log-Zeile wieder statt eine zweite gegen UNIQUE(habit_id, log_date) anzulegen.
  const rows = await journalHabitLogRows(entryDate);
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe(first.id);
  expect(rows[0].done).toBe(true);
});

/* -------------------------------------------------------------------------- */
/* issue #374: Datum im Journal-Kopf, Eintrag trägt den Tag des Absendens     */
/* -------------------------------------------------------------------------- */

/** Langes Datumsformat, geteilt von der Augenbraue (`TodayLongDate`, issue
 * #868) und der Zeile-des-Tages-Karte (`journal-day-card__date`, #1048) —
 * beide rendern denselben `<TodayLongDate/>`. */
const EYEBROW_DATE_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

/* -------------------------------------------------------------------------- */
/* AK1–AK5 (#1048, erster Schnitt von #1046): der Eintragsstrom weicht der   */
/* Zeile des Tages — ein Fläche für heute statt Tagesgruppe → n Karten.       */
/* -------------------------------------------------------------------------- */

test('AK2 (#1048): eine im Panel gelöschte weitere Notiz nimmt die Zeile des Tages nicht mit und erreicht als Tombstone die Datenbank', async ({
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
  await openSheet(page);
  await page.getByLabel('Journal-Text').fill('Zweiter Eintrag');
  await submit(page);

  await expandMoreNotes(page);
  // Scoped to the panel: the headline now carries its own "Eintrag löschen"
  // button too (journal-day-card__delete), so the bare role query is ambiguous.
  await page.locator('#journal-day-card-more').getByRole('button', { name: 'Eintrag löschen' }).click();

  await expect(page.locator('.journal-day-card__line')).toHaveText('Erster Eintrag');
  await expect(page.locator('.journal-day-card__more')).toHaveCount(0);

  await page.evaluate(() => window.__starship.sync());
  const rows = await withDb((client) =>
    client.query(
      'SELECT deleted_at FROM journal_entries WHERE entry_date = $1 ORDER BY created_at',
      [entryDate],
    ),
  );
  expect(rows.rowCount).toBe(2);
  expect(rows.rows[0].deleted_at).toBeNull(); // "Erster Eintrag" bleibt.
  expect(rows.rows[1].deleted_at).not.toBeNull(); // "Zweiter Eintrag" ist ein Tombstone.
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
  // (#701 entfernt den entryDate-State + Mitternachts-Timer, #1048 hat keinen
  // neuen eingeführt) — der Beweis ist die Zeile des Tages, unter der der neue
  // Eintrag tatsächlich erscheint, mit dem langen Datum des neuen Tages.
  await openSheet(page);
  await page.getByLabel('Journal-Text').fill('Nach Mitternacht geschrieben');
  await submit(page);
  await expect(page.locator('.journal-day-card__line')).toHaveText('Nach Mitternacht geschrieben');
  await expect(page.locator('.journal-day-card__date')).toHaveText(EYEBROW_DATE_FORMATTER.format(tomorrow));

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

  // writeJournalEntry braucht keinen DEK (roher Ciphertext) — der
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
  await registerPasskey(page, '/journal');
  // Drains the boot-time Journal-habit mutation while still online. It used to ride out on
  // the throwaway /uebersicht load registerPasskey no longer does (#1075); left queued it
  // inflates the outbox count below and lets the test go offline before the page is live.
  await settleJournalHabitBoot(page);
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
  // Der erste Eintrag ist die Zeile des Tages (AK1), die anderen beiden das
  // Signal für "alle drei Schreibpfade sind durchgelaufen".
  await expect(page.locator('.journal-day-card__more')).toHaveText('2 weitere Notizen');

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

test('bei gesperrtem Journal ist der Editor nicht erreichbar, sondern der Entsperr-Zustand', async ({
  page,
}) => {
  await setUpEditor(page);
  await page.reload();

  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();
  await expect(page.locator('.journal-editor')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* issue #480 (Fund F7): AES-GCM ohne AAD — Chiffrate binden seither id +      */
/* entryDate als Additional Authenticated Data. Bestehende (v1) Chiffrate ohne */
/* AAD bleiben ueber die Nonce-Laenge (12 vs. 13 Byte) weiterhin lesbar — das  */
/* deckt der feste Testvektor in src/crypto/journal.test.ts (AC5 dort) ab.    */
/* -------------------------------------------------------------------------- */

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
