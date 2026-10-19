import { expect, test, type Page } from '@playwright/test';
import {
  FIXED_NOW,
  installClockAt,
  registerPasskey,
  resetAppData,
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
