import { expect, test, type Page } from '@playwright/test';
import { FIXED_NOW, installClockAt, registerPasskey, resetAppData, withDb } from './helpers';

/**
 * Dritte Desktop-Stufe (issue #1126, Nachfolger von #1052/ADR-0030): ab
 * 1440px wird `.journal-editor` dreispaltig (`1.5fr / 1fr / 1fr`) — die
 * Tageskarte behält die breite Bahn zum Schreiben, „An diesem Tag" und
 * „Zuletzt geschrieben" laufen als zwei schmale Bahnen daneben statt wie in
 * der zweiten Stufe (journal.desktop.spec.ts, issue #1052) übereinander in
 * der linken Spalte. Läuft im `desktop-wide`-Messplatz (1800 × 1000,
 * playwright.config.ts), wie kalender.wide.spec.ts/uebersicht.wide.spec.ts.
 * Die zweite Stufe (768–1439px) und Mobile (375×812) bleiben unverändert —
 * dafür bürgen journal.desktop.spec.ts (AK5) und die 375×812-Suite.
 */

const PASSPHRASE = 'wide journal passphrase';
const FAST_KDF_PARAMS = { name: 'PBKDF2', hash: 'SHA-256', iterations: 1000 } as const;
// Fixer, eingecheckter Zeilen-Id (ADR-0016, src/features/journal/journal-keys.ts).
const JOURNAL_KEYS_ROW_ID = '3f2a9b6e-9d3c-4f7a-8b2e-6b1c9a4d7e05';

/** Same setup flow as journal.desktop.spec.ts's setUpEditor. */
async function setUpEditor(page: Page): Promise<void> {
  await registerPasskey(page, '/journal');
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByLabel('Passphrase wiederholen').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Einrichten' }).click();
  await page.getByTestId('journal-recovery-key').waitFor();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();
}

/** Same technique as journal.desktop.spec.ts's own seedEntry. */
async function seedEntry(
  page: Page,
  entryDate: string,
  content: { text: string; mood?: string; tags?: string[] },
): Promise<void> {
  await page.evaluate(
    ({ entryDate, content }) => window.__starship.appendJournalEntry(entryDate, content),
    { entryDate, content },
  );
}

/** Mirrors journal.desktop.spec.ts's own dayKeyOffset. */
function dayKeyOffset(days: number): string {
  const date = new Date(FIXED_NOW);
  date.setDate(date.getDate() + days);
  return date.toLocaleDateString('en-CA');
}

/** Mirrors journal.desktop.spec.ts's own sameDayYearOffset. */
function sameDayYearOffset(yearsAgo: number): string {
  const date = new Date(FIXED_NOW);
  date.setFullYear(date.getFullYear() - yearsAgo);
  return date.toLocaleDateString('en-CA');
}

/**
 * Reaches the "displaced envelope" state AK3 needs (issue #518) without a real
 * second device: journal-key-race.spec.ts's own `raceUntilDisplaced` opens a
 * second browser context and pays a second real-iteration KDF derivation
 * (`debugCompetingSetup` accepts no fast-KDF override, by design — see that
 * file's own header) for a check that is actually about the recovery flow.
 * This ticket only needs the resulting grid to hold the orphaned-key card, so
 * it takes the cheap path instead: mint a second, independent envelope
 * straight through the exposed `createEnvelope` bridge (fast KDF override,
 * unlike `debugCompetingSetup`), write it directly onto the fixed
 * `journal_keys` row with a fresh `sync_seq`, and let this same device pull
 * it — `pull()`'s `stashDisplacedJournalKey` (journal-key-stash.ts) sees a
 * different incoming envelope than its own and stashes the local one, exactly
 * as a real second device racing in would.
 */
async function displaceJournalKey(page: Page): Promise<void> {
  await page.evaluate(() => window.__starship.sync());
  const envelope = await page.evaluate(
    (kdf) => window.__starship.createEnvelope('verdraengende passphrase', kdf),
    FAST_KDF_PARAMS,
  );
  await withDb((client) =>
    client.query(
      `UPDATE journal_keys SET envelope = $2, updated_at = now(), sync_seq = nextval('sync_seq') WHERE id = $1`,
      [JOURNAL_KEYS_ROW_ID, JSON.stringify(envelope)],
    ),
  );
  await page.evaluate(() => window.__starship.sync());
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  await installClockAt(page);
});

/* -------------------------------------------------------------------------- */
/* AK1: dreispaltig (1.5fr/1fr/1fr), Tageskarte über beide Zeilen             */
/* -------------------------------------------------------------------------- */

test('AK1: ab 1440px ist .journal-editor dreispaltig (1.5fr/1fr/1fr) — Tageskarte links über beide Zeilen, „An diesem Tag" in der Mitte, „Zuletzt geschrieben" rechts (issue #1126)', async ({
  page,
}) => {
  await setUpEditor(page);
  await seedEntry(page, dayKeyOffset(0), { text: 'Heute geschrieben' });
  await seedEntry(page, dayKeyOffset(-1), { text: 'Gestern geschrieben' });
  await seedEntry(page, sameDayYearOffset(1), { text: 'Vor einem Jahr' });

  const editor = page.locator('.journal-editor');
  const dayCard = page.locator('.journal-day-card');
  const sameDay = page.locator('.journal-same-day');
  const recent = page.locator('.journal-recent');
  await expect(dayCard).toBeVisible();
  await expect(sameDay).toBeVisible();
  await expect(recent).toBeVisible();

  const [display, templateColumns] = await editor.evaluate((el) => {
    const style = getComputedStyle(el);
    return [style.display, style.gridTemplateColumns];
  });
  expect(display, 'dreispaltiges Raster').toBe('grid');
  const columns = templateColumns.split(' ').filter(Boolean).map(parseFloat);
  expect(columns, `Spaltenbreiten: ${templateColumns}`).toHaveLength(3);
  const ratioLeftToMiddle = columns[0] / columns[1];
  expect(ratioLeftToMiddle, `1.5fr/1fr-Verhältnis: ${templateColumns}`).toBeGreaterThan(1.3);
  expect(ratioLeftToMiddle, `1.5fr/1fr-Verhältnis: ${templateColumns}`).toBeLessThan(1.7);
  expect(Math.abs(columns[1] - columns[2]), `mittlere/rechte Bahn gleich breit: ${templateColumns}`).toBeLessThan(2);

  // Die Tageskarte spannt beide Zeilen, „An diesem Tag" und „Zuletzt
  // geschrieben" stehen je in einer einzelnen — derselbe Kunstgriff wie
  // journal-editor.css's 768px-Block, nur mit vertauschten Rollen.
  const dayCardGridRowEnd = await dayCard.evaluate((el) => getComputedStyle(el).gridRowEnd);
  expect(dayCardGridRowEnd, 'Tageskarte spannt beide Zeilen').toContain('span');

  const [dayCardBox, sameDayBox, recentBox] = await Promise.all([
    dayCard.boundingBox(),
    sameDay.boundingBox(),
    recent.boundingBox(),
  ]);
  if (!dayCardBox || !sameDayBox || !recentBox) throw new Error('AK1: fehlende BoundingBox');

  // Von links nach rechts: Tageskarte, „An diesem Tag", „Zuletzt geschrieben".
  expect(dayCardBox.x).toBeLessThan(sameDayBox.x);
  expect(sameDayBox.x).toBeLessThan(recentBox.x);
  // Alle drei kleben an derselben oberen Kante.
  expect(Math.round(dayCardBox.y)).toBe(Math.round(sameDayBox.y));
  expect(Math.round(dayCardBox.y)).toBe(Math.round(recentBox.y));
});

/* -------------------------------------------------------------------------- */
/* AK2: align-items: start, keine Karte streckt sich auf die Nachbarhöhe      */
/* -------------------------------------------------------------------------- */

test('AK2: align-items: start — keine der drei Karten wird auf die Höhe der Nachbarspalte gestreckt (issue #1126)', async ({
  page,
}) => {
  await setUpEditor(page);
  await seedEntry(page, dayKeyOffset(0), { text: 'Erster Eintrag heute' });
  await seedEntry(page, dayKeyOffset(0), { text: 'Zweiter Eintrag heute' });
  await seedEntry(page, dayKeyOffset(0), { text: 'Dritter Eintrag heute' });
  await seedEntry(page, dayKeyOffset(-1), { text: 'Gestern geschrieben' });
  await seedEntry(page, sameDayYearOffset(1), { text: 'Vor einem Jahr' });

  const editor = page.locator('.journal-editor');
  const dayCard = page.locator('.journal-day-card');
  const sameDay = page.locator('.journal-same-day');
  const recent = page.locator('.journal-recent');
  await expect(dayCard).toBeVisible();
  await expect(sameDay).toBeVisible();
  await expect(recent).toBeVisible();

  // Klappt die "N weitere Notizen"-Liste auf — die Tageskarte wird dadurch
  // deutlich höher als ihre beiden Nachbarn.
  await dayCard.getByRole('button', { name: /weitere Notiz/ }).click();

  expect(await editor.evaluate((el) => getComputedStyle(el).alignItems)).toBe('start');

  const [dayCardBox, sameDayBox, recentBox] = await Promise.all([
    dayCard.boundingBox(),
    sameDay.boundingBox(),
    recent.boundingBox(),
  ]);
  if (!dayCardBox || !sameDayBox || !recentBox) throw new Error('AK2: fehlende BoundingBox');

  // Mit dem Grid-Default `stretch` hätten alle drei dieselbe Höhe getragen.
  expect(dayCardBox.height, 'Tageskarte deutlich höher als „An diesem Tag"').toBeGreaterThan(
    sameDayBox.height + 20,
  );
  expect(dayCardBox.height, 'Tageskarte deutlich höher als „Zuletzt geschrieben"').toBeGreaterThan(
    recentBox.height + 20,
  );
});

/* -------------------------------------------------------------------------- */
/* AK3: Bergungskarte volle Breite Zeile 1, alles andere eine Zeile tiefer    */
/* -------------------------------------------------------------------------- */

test('AK3: mit Bergungskarte (#518) steht sie über die volle Breite in Zeile 1, Tageskarte/„An diesem Tag"/„Zuletzt geschrieben" rücken gemeinsam eine Zeile nach unten (issue #1126)', async ({
  page,
}) => {
  await setUpEditor(page);
  await seedEntry(page, dayKeyOffset(0), { text: 'Heute geschrieben' });
  await seedEntry(page, dayKeyOffset(-1), { text: 'Gestern geschrieben' });
  await seedEntry(page, sameDayYearOffset(1), { text: 'Vor einem Jahr' });
  await displaceJournalKey(page);

  const editor = page.locator('.journal-editor');
  const orphaned = page.locator('.journal-orphaned-key');
  const dayCard = page.locator('.journal-day-card');
  const sameDay = page.locator('.journal-same-day');
  const recent = page.locator('.journal-recent');
  await expect(orphaned).toBeVisible();
  await expect(dayCard).toBeVisible();
  await expect(sameDay).toBeVisible();
  await expect(recent).toBeVisible();

  const [editorBox, orphanedBox, dayCardBox, sameDayBox, recentBox] = await Promise.all([
    editor.boundingBox(),
    orphaned.boundingBox(),
    dayCard.boundingBox(),
    sameDay.boundingBox(),
    recent.boundingBox(),
  ]);
  if (!editorBox || !orphanedBox || !dayCardBox || !sameDayBox || !recentBox) {
    throw new Error('AK3: fehlende BoundingBox');
  }

  // Volle Breite in Zeile 1.
  expect(Math.round(orphanedBox.x)).toBe(Math.round(editorBox.x));
  expect(Math.round(orphanedBox.width)).toBe(Math.round(editorBox.width));
  expect(Math.round(orphanedBox.y)).toBe(Math.round(editorBox.y));

  // Alle drei Karten rücken gemeinsam in dieselbe zweite Zeile — anders als im
  // 768px-Block (dort standen „Zuletzt geschrieben" und die Tageskarte noch
  // übereinander in einer Spalte, brauchten also unterschiedliche Zeilen).
  expect(dayCardBox.y).toBeGreaterThanOrEqual(orphanedBox.y + orphanedBox.height - 1);
  expect(Math.round(sameDayBox.y)).toBe(Math.round(dayCardBox.y));
  expect(Math.round(recentBox.y)).toBe(Math.round(dayCardBox.y));
});

/* -------------------------------------------------------------------------- */
/* AK4: Suchtreffer dreibahnig statt zweibahnig                              */
/* -------------------------------------------------------------------------- */

test('AK4: Suchtreffer laufen ab 1440px dreibahnig statt zweibahnig, keine Jahresgruppe bricht an der Bahnengrenze auf (issue #1126)', async ({
  page,
}) => {
  await setUpEditor(page);
  for (let year = 2016; year <= 2024; year += 1) {
    await seedEntry(page, `${year}-03-01`, {
      text: `Eintrag aus ${year} mit etwas mehr Text, damit jede Bahn wirklich Höhe braucht.`,
    });
  }

  await page.getByRole('button', { name: 'Journal durchsuchen' }).click();

  const groups = page.locator('.journal-search__year-group');
  await expect(groups).toHaveCount(9);

  expect(
    await page.locator('.journal-search__groups').evaluate((el) => getComputedStyle(el).columnCount),
  ).toBe('3');
  const breakInsideValues = await groups.evaluateAll((els) => els.map((el) => getComputedStyle(el).breakInside));
  expect(breakInsideValues.every((value) => value === 'avoid'), breakInsideValues.join(', ')).toBe(true);

  const boxes = await Promise.all(Array.from({ length: 9 }, (_, i) => groups.nth(i).boundingBox()));
  const xs = boxes.map((box) => Math.round(box!.x / 10) * 10);
  expect(new Set(xs).size, `Spalten-x-Werte: ${xs.join(', ')}`).toBe(3);
});

/* -------------------------------------------------------------------------- */
/* AK5 (Nicht-Regression): siehe journal.desktop.spec.ts (1280px) und        */
/* journal.spec.ts/journal-suche.spec.ts (375px, mobile-Messplatz) — dort    */
/* unverändert, dieser PR rührt an keiner der dortigen Regeln.               */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* AK6: gesperrtes Journal-Gate bleibt bei 1800 horizontal zentriert (#934)   */
/* -------------------------------------------------------------------------- */

test('AK6: das gesperrte Journal-Gate bleibt bei Viewport 1800 horizontal zentriert (#934) (issue #1126)', async ({
  page,
}) => {
  await setUpEditor(page);
  await page.reload();
  await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();

  const mainBox = await page.locator('main.shell__main').boundingBox();
  const inputBox = await page.getByLabel('Passphrase', { exact: true }).boundingBox();
  const buttonBox = await page.getByRole('button', { name: 'Entsperren', exact: true }).boundingBox();
  expect(mainBox).not.toBeNull();
  expect(inputBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();

  const columnCenter = mainBox!.x + mainBox!.width / 2;
  const inputCenter = inputBox!.x + inputBox!.width / 2;
  const buttonCenter = buttonBox!.x + buttonBox!.width / 2;
  expect(Math.abs(inputCenter - columnCenter)).toBeLessThanOrEqual(1);
  expect(Math.abs(buttonCenter - columnCenter)).toBeLessThanOrEqual(1);
});
