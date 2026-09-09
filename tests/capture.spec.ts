import { expect, test, type Page } from '@playwright/test';
import {
  FIXED_NOW,
  installClockAt,
  registerPasskey,
  resetAppData,
  selectView,
  withDb,
} from './helpers';

const QUICK_ADD_LABEL = 'Aufgabe erfassen';
const CONFIRM_LABEL = 'Aufgabe bestätigen';
const EVENT_LABEL = 'Termin erfassen';

/** Wie `confirmDialog`, aber für den vollen Termin-Editor, den "Mehr" auf
 *  `/uebersicht` öffnet (`uebersicht-capture.tsx`'s `openMoreForEvent`, issue
 *  #1138). `[open]` filtert das noch schließende Kern-Sheet heraus — beide
 *  tragen während dessen Exit-Transition kurz denselben Namen. */
function eventEditorDialog(page: Page) {
  return page.getByRole('dialog', { name: EVENT_LABEL }).and(page.locator('[open]'));
}

/** Von/Bis sitzen hinter dem Wann-Chip — vor jedem Zugriff öffnen. */
function openWannChip(dialog: ReturnType<typeof eventEditorDialog>) {
  return dialog.getByRole('button', { name: /^Wann/ }).click();
}

async function openQuickAdd(page: Page) {
  await page.getByRole('button', { name: QUICK_ADD_LABEL }).click();
}

function quickAddTitleField(page: Page) {
  return page.getByRole('textbox', { name: 'Titel der Aufgabe' });
}

function confirmDialog(page: Page) {
  return page.getByRole('dialog', { name: CONFIRM_LABEL });
}

function taskItems(page: Page) {
  return page.getByRole('list', { name: 'Aufgaben' }).getByRole('listitem');
}

async function submitQuickAdd(page: Page, text: string) {
  await openQuickAdd(page);
  await quickAddTitleField(page).fill(text);
  await page.getByRole('button', { name: 'Anlegen' }).click();
}

/** Mirrors parse-task-input.ts's own default time (09:00) and the summary formatting
 * in capture-confirm.tsx, computed at run time — never hard-coded (helper.ts pattern
 * used elsewhere: the assertion must not depend on which day the suite runs). */
function expectedDueAt(daysFromNow: number, hours: number, minutes: number): Date {
  const date = new Date(FIXED_NOW);
  date.setDate(date.getDate() + daysFromNow);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function formatSummary(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}. ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `datetime-local` works in the browser's local time, with no timezone suffix. */
function isoToLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function enableDirectCapture(page: Page) {
  await page.goto('/einstellungen');
  await page.getByRole('switch', { name: 'Ohne Bestätigung direkt anlegen' }).click();
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // The list must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await installClockAt(page);
  // No target: every test in this file opens with its own goto, so loading
  // /uebersicht here would only be thrown away (issue #1075).
  await registerPasskey(page, null);
});

test('AC1: eine erkannte Fälligkeit öffnet das Bestätigungs-Sheet mit aufgelöstem Datum', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  const due = expectedDueAt(1, 12, 0);

  await submitQuickAdd(page, 'Arzt anrufen morgen um 12');

  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Titel der Aufgabe' })).toHaveValue(
    'Arzt anrufen',
  );
  await expect(dialog.getByLabel('Fälligkeit')).toHaveValue(isoToLocalInput(due));
  await expect(dialog.locator('.capture-confirm__summary')).toHaveText(formatSummary(due));

  await dialog.getByRole('button', { name: 'Anlegen' }).click();

  await expect(dialog).toBeHidden();
  await expect(taskItems(page).filter({ hasText: 'Arzt anrufen' })).toBeVisible();

  // beforeEach cuts the sync endpoints so the list can only ever come from
  // IndexedDB — lift that here to let the queued mutation actually reach Postgres.
  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT due_at FROM tasks WHERE title = $1', ['Arzt anrufen']),
  );
  expect(new Date(row.rows[0].due_at).toISOString()).toBe(due.toISOString());
});

test('AC1: "Abbrechen" verwirft den Entwurf, es wird nichts angelegt', async ({ page }) => {
  await page.goto('/aufgaben');
  await submitQuickAdd(page, 'Zahnarzt morgen um 9');

  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();

  await expect(dialog).toBeHidden();
  await expect(taskItems(page).filter({ hasText: 'Zahnarzt' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
});

test('AC2: eine Eingabe ohne Datum legt sofort an, ohne Bestätigungs-Sheet', async ({ page }) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await submitQuickAdd(page, 'Wäsche waschen');

  await expect(confirmDialog(page)).toBeHidden();
  await expect(taskItems(page).filter({ hasText: 'Wäsche waschen' })).toBeVisible();
});

test('AC3+AC4: Direkt-Pfad übergeht das Sheet und legt ohne Rückgängig-Popup an', async ({
  page,
}) => {
  await enableDirectCapture(page);
  await page.goto('/aufgaben');
  const due = expectedDueAt(1, 15, 0);

  await submitQuickAdd(page, 'Übergabe morgen 15:00');

  await expect(confirmDialog(page)).toBeHidden();
  await expect(taskItems(page).filter({ hasText: 'Übergabe' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeHidden();

  const row = await withDb((client) =>
    client.query('SELECT title FROM tasks WHERE title = $1', ['Übergabe']),
  );
  expect(row.rowCount).toBe(0); // noch nicht synchronisiert, aber lokal schon sichtbar
  const entries = await page.evaluate(() => window.__starship.pending());
  expect(entries[entries.length - 1].payload).toMatchObject({ dueAt: due.toISOString() });
});

test('AC5: offline im Bestätigungs-Sheet angelegt übersteht den Reload und erreicht online die Datenbank', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  // beforeEach already cut the sync endpoints — exactly what a train tunnel looks
  // like to the outbox (sync.spec.ts). `context.setOffline` would also block the
  // reload below (ERR_INTERNET_DISCONNECTED), so this mirrors sync.spec.ts's own
  // "survives a reload" test rather than tasks.spec.ts's offline-banner tests.

  await submitQuickAdd(page, 'Im Zug notiert morgen um 8');
  await confirmDialog(page).getByRole('button', { name: 'Anlegen' }).click();

  await expect(taskItems(page).filter({ hasText: 'Im Zug notiert' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  await page.reload();
  await expect(taskItems(page).filter({ hasText: 'Im Zug notiert' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  const row = await withDb((client) =>
    client.query('SELECT due_at FROM tasks WHERE title = $1', ['Im Zug notiert']),
  );
  expect(row.rowCount).toBe(1);
  expect(row.rows[0].due_at).not.toBeNull();
});

test('AC7: die Summary im Bestätigungs-Sheet nutzt tabular-nums und reserviert feste Höhe', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await submitQuickAdd(page, 'Vorsorge morgen um 10');

  const summary = confirmDialog(page).locator('.capture-confirm__summary');
  await expect(summary).toBeVisible();
  const { fontVariantNumeric, minHeight } = await summary.evaluate((el) => {
    const style = getComputedStyle(el);
    return { fontVariantNumeric: style.fontVariantNumeric, minHeight: style.minHeight };
  });
  expect(fontVariantNumeric).toBe('tabular-nums');
  expect(minHeight).not.toBe('0px');
});

test('AC7: bei reduzierter Bewegung öffnet das Bestätigungs-Sheet nur mit einem Opacity-Übergang', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/aufgaben');
  await submitQuickAdd(page, 'Ruhig bitte morgen um 10');

  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  const transitionProperty = await dialog.evaluate(
    (el) => getComputedStyle(el.firstElementChild as Element).transitionProperty,
  );
  expect(transitionProperty).toBe('opacity');
});

/**
 * issue #1138: "Mehr" auf `/uebersicht` (`uebersicht-capture.tsx`'s
 * `openMoreForEvent`) warf die vom Erkenner gelieferte Endzeit und die
 * Mehrtagesspanne bisher weg und rechnete `endsAt` hart als `start + 1h` neu —
 * jeder Test hier tippt echten Freitext und klickt "Mehr" (AK6), statt einen
 * Prefill direkt zu setzen.
 */
test('AK1 (#1138): eine erkannte Zwei-Stunden-Spanne steht im "Mehr"-Editor exakt wie erkannt, Speichern ohne Änderung behält sie', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  // 15/17 statt 14/16: 14 Uhr fällt exakt auf FIXED_NOW's Berlin-lokale Uhrzeit (12:00 UTC
  // = 14:00 CEST) — resolveTimeOnlyDate vergleicht `candidate > now`, und auf einem
  // Berlin-Rechner (lokale Entwicklung/Runner) ist das dann ein Gleichstand (→ morgen),
  // während CI in UTC läuft und 14:00 noch als Rest des heutigen Tages sieht (→ heute) —
  // derselbe Lauf liefert je nach Host-Zeitzone ein anderes Ergebnis. Wichtig auch: eine
  // Stunde ≤ 12 ohne Doppelpunkt/Tageszeitwort ist mehrdeutig (findTimeCandidate) und
  // würde über die Vormittags/Nachmittags-Heuristik zusätzlich unabhängig verfälscht (z. B.
  // "10" → 22 Uhr, weil `now` nachmittags liegt) — 15/17 bleibt über 12 und damit eindeutig,
  // und liegt in beiden Zeitzonen klar nach „jetzt" (12:00 UTC / 14:00 CEST), bleibt also
  // konsistent „heute".
  const start = expectedDueAt(0, 15, 0);
  const end = expectedDueAt(0, 17, 0);

  await openQuickAdd(page);
  await quickAddTitleField(page).fill('Termin von 15 bis 17 Uhr Zahnarzt');
  await page.getByRole('button', { name: 'Mehr' }).click();

  const dialog = eventEditorDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Titel')).toHaveValue('Zahnarzt');
  await openWannChip(dialog);
  await expect(dialog.getByRole('switch', { name: 'Ganztägig' })).not.toBeChecked();
  await expect(dialog.getByLabel('Von')).toHaveValue(isoToLocalInput(start));
  await expect(dialog.getByLabel('Bis')).toHaveValue(isoToLocalInput(end));

  await dialog.getByRole('button', { name: 'Anlegen' }).click();

  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.find((entry) => entry.table === 'events');
  expect(created?.payload).toMatchObject({
    title: 'Zahnarzt',
    allDay: false,
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
  });
});

test('AK2 (#1138): eine erkannte Mehrtagesspanne ist im "Mehr"-Editor ganztägig mit dem erkannten Start- und Enddatum, nicht ein einstündiger Termin am ersten Tag', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  // "3. März" liegt vor dem fixierten Juli-"heute" — die Spanne fällt damit auf
  // das nächste Jahr (findDateCandidate/findDateRangeEnd, parse-task-input.ts).
  const year = new Date(FIXED_NOW).getFullYear() + 1;
  const startDate = `${year}-03-03`;
  const endDate = `${year}-03-10`;

  await openQuickAdd(page);
  await quickAddTitleField(page).fill('Termin Urlaub vom 3. bis 10. März');
  await page.getByRole('button', { name: 'Mehr' }).click();

  const dialog = eventEditorDialog(page);
  await expect(dialog).toBeVisible();
  await openWannChip(dialog);
  await expect(dialog.getByRole('switch', { name: 'Ganztägig' })).toBeChecked();
  await expect(dialog.getByLabel('Von')).toHaveValue(startDate);
  await expect(dialog.getByLabel('Bis')).toHaveValue(endDate);

  await dialog.getByRole('button', { name: 'Anlegen' }).click();

  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.find((entry) => entry.table === 'events');
  expect(created?.payload).toMatchObject({ allDay: true, startDate, endDate });
});

test('AK3 (#1138): eine erkannte Spanne über Mitternacht behält im "Mehr"-Editor neben der Uhrzeit auch das richtige Enddatum', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  // Kein erkanntes Spannen-Ende, also greift der Ein-Stunden-Default aus
  // route-capture.ts — die reine Datumsarithmetik rollt dabei über Mitternacht.
  const start = expectedDueAt(0, 23, 30);
  const end = expectedDueAt(1, 0, 30);

  await openQuickAdd(page);
  await quickAddTitleField(page).fill('Termin 23:30 Uhr Kino');
  await page.getByRole('button', { name: 'Mehr' }).click();

  const dialog = eventEditorDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Titel')).toHaveValue('Kino');
  await openWannChip(dialog);
  await expect(dialog.getByRole('switch', { name: 'Ganztägig' })).not.toBeChecked();
  await expect(dialog.getByLabel('Von')).toHaveValue(isoToLocalInput(start));
  await expect(dialog.getByLabel('Bis')).toHaveValue(isoToLocalInput(end));
});

test('AK4 (#1138): eine Eingabe ohne Endzeit bleibt im "Mehr"-Editor beim heutigen Ein-Stunden-Default', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  // Weder Datum noch Uhrzeit erkannt — derselbe Rückfall wie event-editor.tsx's
  // eigener Create-Modus (defaultEventStart, route-capture.ts), kein Sprung auf
  // den ganztägig-Fallback, den `eventFieldsFromDraft` sonst für diesen Fall liefert.
  const start = expectedDueAt(0, 9, 0);
  const end = expectedDueAt(0, 10, 0);

  await openQuickAdd(page);
  await quickAddTitleField(page).fill('Termin Kino');
  await page.getByRole('button', { name: 'Mehr' }).click();

  const dialog = eventEditorDialog(page);
  await expect(dialog).toBeVisible();
  await openWannChip(dialog);
  await expect(dialog.getByRole('switch', { name: 'Ganztägig' })).not.toBeChecked();
  await expect(dialog.getByLabel('Von')).toHaveValue(isoToLocalInput(start));
  await expect(dialog.getByLabel('Bis')).toHaveValue(isoToLocalInput(end));
});

test('AK5 (#1138): der Direkt-Speichern-Pfad bleibt beim Ein-Stunden-Default, das Start-/Dauer-Verhalten des Editors bleibt unverändert', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  // 15/17 statt 14/16 — siehe AK1: 14 Uhr fällt exakt auf FIXED_NOW's Berlin-lokale Uhrzeit
  // und macht das Testergebnis von der Host-Zeitzone abhängig; eine Stunde ≤ 12 wäre zudem
  // über die Vormittags/Nachmittags-Heuristik mehrdeutig. 15/17 bleibt eindeutig und liegt
  // in beiden Zeitzonen klar nach „jetzt".
  const start = expectedDueAt(0, 15, 0);
  const directEnd = expectedDueAt(0, 16, 0);

  // Direkt-Pfad ("Anlegen" im Kern-Sheet, kein "Mehr"): dieser Fix ändert nur
  // `openMoreForEvent`, nicht `handleSubmit` — der erkannte 17-Uhr-Endpunkt wird
  // hier weiterhin verworfen, genau wie vor dem Fix (Nicht-Ziele, kein Doppel zu #1104).
  await openQuickAdd(page);
  await quickAddTitleField(page).fill('Termin von 15 bis 17 Uhr Zahnarzt');
  await page.getByRole('button', { name: 'Anlegen' }).click();

  const directEntries = await page.evaluate(() => window.__starship.pending());
  const directCreated = directEntries.find((entry) => entry.table === 'events');
  expect(directCreated?.payload).toMatchObject({
    title: 'Zahnarzt',
    allDay: false,
    startsAt: start.toISOString(),
    endsAt: directEnd.toISOString(),
  });

  // Editor-Verhalten (#1104): dieselbe Eingabe über "Mehr" — die jetzt korrekt
  // übernommene Zwei-Stunden-Dauer bleibt beim Verschieben von "Von" erhalten,
  // die Zusammenführungslogik in event-editor.tsx bleibt unangetastet.
  await openQuickAdd(page);
  await quickAddTitleField(page).fill('Termin von 15 bis 17 Uhr Zahnarzt');
  await page.getByRole('button', { name: 'Mehr' }).click();

  const dialog = eventEditorDialog(page);
  await openWannChip(dialog);
  const shiftedStart = expectedDueAt(1, 20, 0);
  const shiftedEnd = expectedDueAt(1, 22, 0);
  await dialog.getByLabel('Von').fill(isoToLocalInput(shiftedStart));
  await expect(dialog.getByLabel('Bis')).toHaveValue(isoToLocalInput(shiftedEnd));
});
