import { expect, test, type Page } from '@playwright/test';
import { installClockAt, registerPasskey, resetAppData, withDb } from './helpers';

/**
 * Datumsvokabular, Tagesgrenze 04:00, rückwirkendes Abhaken (issue #689, Teil 3 von 3
 * des Parser-Umbaus, Epic #617). Alle Tests dieses Tickets in einer Datei
 * (45-Minuten-Fenster, CLAUDE.md) — die erschöpfende Datums-/Zeit-Arithmetik läuft als
 * Vitest-Korpus (corpus.ts, parse-task-input.test.ts); hier geht es um das
 * end-to-end sichtbare Verhalten je AK.
 *
 * Eigene Bezugspunkte statt `FIXED_NOW` aus helpers.ts: Montag 10:00 Berlin (wie der
 * Bezugspunkt des Tickets selbst) und, für AK5/AK6, Dienstag 01:30 Berlin — die Nacht
 * über die Tagesgrenze 04:00 hinweg, an der der logische Tag noch der Montag ist.
 * Januar, damit die Zeitzone durchgehend CET bleibt (kein DST-Wechsel mittendrin).
 */
const MO = new Date(2026, 0, 12, 10, 0, 0); // Montag, 12.01.2026, 10:00 Berlin
const NACHT = new Date(2026, 0, 13, 1, 30, 0); // Dienstag, 13.01.2026, 01:30 Berlin — logischer Tag: Montag

const CAPTURE_LABEL = 'Aufgabe erfassen';
const CONFIRM_LABEL = 'Aufgabe bestätigen';
const EVENT_LABEL = 'Termin erfassen';

function captureButton(page: Page) {
  return page.getByRole('button', { name: CAPTURE_LABEL });
}

function captureTitleField(page: Page) {
  return page.getByRole('textbox', { name: 'Titel der Aufgabe' });
}

function confirmDialog(page: Page) {
  return page.getByRole('dialog', { name: CONFIRM_LABEL });
}

function eventDialog(page: Page) {
  return page.getByRole('dialog', { name: EVENT_LABEL });
}

function taskItems(page: Page) {
  return page.getByRole('list', { name: 'Aufgaben' }).getByRole('listitem');
}

async function submitUebersichtCapture(page: Page, text: string) {
  await captureButton(page).click();
  await captureTitleField(page).fill(text);
  await page.getByRole('button', { name: 'Hinzufügen' }).click();
}

async function seedHabit(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'habits', op: 'upsert', payload: p }),
    payload,
  );
}

/** Tag relativ zu `base`, nie hart codiert (Muster aus capture-zeigerzeit.spec.ts). */
function dueAt(base: Date, daysFromNow: number, hours: number, minutes: number): Date {
  const date = new Date(base);
  date.setDate(date.getDate() + daysFromNow);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function dateKeyOf(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `datetime-local` arbeitet in der lokalen Zeit des Browsers, ohne Zeitzonen-Suffix. */
function isoToLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function pendingHabitLogDates(page: Page): Promise<string[]> {
  const entries = await page.evaluate(() => window.__starship.pending());
  return entries
    .filter((entry) => entry.table === 'habit_logs')
    .map((entry) => entry.payload.logDate as string);
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // Weder Aufgaben- noch Termin-Pfad dürfen je direkt fetchen (CLAUDE.md Regel 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await installClockAt(page, MO.toISOString());
  await registerPasskey(page);
});

test('AK1: Monatsname löst auf, ein kalendarisch ungültiges Datum wird verworfen statt gerollt', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const due = new Date(2026, 7, 4, 9, 0, 0);

  await submitUebersichtCapture(page, 'am 4. August Zahnarzt');

  await page.waitForURL('**/aufgaben');
  const confirm = confirmDialog(page);
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole('textbox', { name: 'Titel der Aufgabe' })).toHaveValue('Zahnarzt');
  await expect(confirm.getByLabel('Fälligkeit')).toHaveValue(isoToLocalInput(due));
  await confirm.getByRole('button', { name: 'Anlegen' }).click();
  await expect(confirm).toBeHidden();
  await expect(taskItems(page).filter({ hasText: 'Zahnarzt' })).toBeVisible();

  // "31.6." existiert nicht — der Kandidat wird verworfen (kein Rollover auf den 1.
  // Juli), der Rohtext bleibt Titel. "Termin" im Satz ist reines Vokabular ohne Datum
  // -> ganztägiger Termin auf heute, derselbe Fallback wie "Meeting mit Chef"
  // (capture-router.spec.ts AC2).
  await page.goto('/uebersicht');
  await submitUebersichtCapture(page, 'am 31.6. Termin');

  await page.waitForURL('**/kalender');
  const event = eventDialog(page);
  await expect(event).toBeVisible();
  await expect(event.getByLabel('Titel')).toHaveValue('am 31.6. Termin');
  await expect(event.getByRole('switch', { name: 'Ganztägig' })).toHaveAttribute('aria-checked', 'true');
  await expect(event.getByLabel('Von')).toHaveValue(dateKeyOf(MO));
});

test('AK2: relative Spannen "in N Tagen"/"in einer Woche"', async ({ page }) => {
  await page.goto('/uebersicht');
  const in3Days = dueAt(MO, 3, 9, 0);

  await submitUebersichtCapture(page, 'in drei Tagen Rechnung zahlen');

  await page.waitForURL('**/aufgaben');
  let dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Titel der Aufgabe' })).toHaveValue('Rechnung zahlen');
  await expect(dialog.getByLabel('Fälligkeit')).toHaveValue(isoToLocalInput(in3Days));
  await dialog.getByRole('button', { name: 'Anlegen' }).click();
  await expect(dialog).toBeHidden();

  await page.goto('/uebersicht');
  const in1Week = dueAt(MO, 7, 9, 0);
  await submitUebersichtCapture(page, 'in einer Woche nachfassen');

  await page.waitForURL('**/aufgaben');
  dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Titel der Aufgabe' })).toHaveValue('nachfassen');
  await expect(dialog.getByLabel('Fälligkeit')).toHaveValue(isoToLocalInput(in1Week));
  await dialog.getByRole('button', { name: 'Anlegen' }).click();
  await expect(taskItems(page).filter({ hasText: 'nachfassen' })).toBeVisible();
});

test('AK3: "nächsten" überspringt eine Woche gegenüber der bloßen Wochentagsform', async ({ page }) => {
  await page.goto('/uebersicht');
  const bareDienstag = dueAt(MO, 1, 9, 0);

  await submitUebersichtCapture(page, 'Dienstag Steuer machen');

  await page.waitForURL('**/aufgaben');
  let dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Titel der Aufgabe' })).toHaveValue('Steuer machen');
  await expect(dialog.getByLabel('Fälligkeit')).toHaveValue(isoToLocalInput(bareDienstag));
  await dialog.getByRole('button', { name: 'Anlegen' }).click();
  await expect(dialog).toBeHidden();

  await page.goto('/uebersicht');
  const naechstenDienstag = dueAt(MO, 8, 9, 0);
  await submitUebersichtCapture(page, 'nächsten Dienstag Zahnarzt');

  await page.waitForURL('**/aufgaben');
  dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Titel der Aufgabe' })).toHaveValue('Zahnarzt');
  await expect(dialog.getByLabel('Fälligkeit')).toHaveValue(isoToLocalInput(naechstenDienstag));
  await dialog.getByRole('button', { name: 'Anlegen' }).click();
  await expect(taskItems(page).filter({ hasText: 'Zahnarzt' })).toBeVisible();
});

test('AK4: der Satz aus #620 fällt lokal', async ({ page }) => {
  await page.goto('/uebersicht');
  const due = dueAt(MO, 8, 8, 45);

  await submitUebersichtCapture(
    page,
    'kannst du mir für nächsten Dienstag viertel vor neun einen Zahnarzttermin einstellen',
  );

  await page.waitForURL('**/kalender');
  const dialog = eventDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Titel')).toHaveValue('Zahnarzttermin');
  await expect(dialog.getByLabel('Von')).toHaveValue(isoToLocalInput(due));
});

test('AK5: Tagesgrenze 04:00 — zwischen 00:00 und 03:59 zählt noch der vorherige Kalendertag als "heute"', async ({
  page,
}) => {
  await installClockAt(page, NACHT.toISOString());
  await page.goto('/uebersicht');
  const morgen14Uhr = dueAt(MO, 1, 14, 0);

  await submitUebersichtCapture(page, 'morgen 14 Uhr Zahnarzt');

  await page.waitForURL('**/kalender');
  let dialog = eventDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Titel')).toHaveValue('Zahnarzt');
  await expect(dialog.getByLabel('Von')).toHaveValue(isoToLocalInput(morgen14Uhr));
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Reine Uhrzeit ohne Datum: "sonst morgen" rechnet ab dem logischen, nicht dem
  // realen Tag — 8 Uhr am logischen Montag ist um 01:30 Dienstag längst vorbei.
  await page.goto('/uebersicht');
  const umAcht = dueAt(MO, 1, 8, 0);
  await submitUebersichtCapture(page, 'Zahnarzt um 8');

  await page.waitForURL('**/kalender');
  dialog = eventDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Von')).toHaveValue(isoToLocalInput(umAcht));
});

test('AK6: Abhaken folgt dem logischen Tag, nicht dem realen', async ({ page }) => {
  await installClockAt(page, NACHT.toISOString());
  await page.goto('/uebersicht');
  await seedHabit(page, { name: 'Sport', schedule: 'daily', color: null, archivedAt: null });

  await submitUebersichtCapture(page, 'Sport gemacht');

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(page.getByRole('status').filter({ hasText: 'abgehakt' })).toBeVisible();

  await page.goto('/uebersicht');
  await submitUebersichtCapture(page, 'gestern Sport gemacht');
  await expect(page.getByRole('status').filter({ hasText: 'abgehakt' })).toBeVisible();

  const logDates = (await pendingHabitLogDates(page)).sort();
  expect(logDates).toEqual([dateKeyOf(dueAt(MO, -1, 0, 0)), dateKeyOf(MO)].sort());
});

test('AK6/R7: ein genanntes Datum steuert bis 7 Tage rückwärts den Log-Tag, Zukunft wird ignoriert', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedHabit(page, { name: 'Sport', schedule: 'daily', color: null, archivedAt: null });

  await submitUebersichtCapture(page, 'Sport für gestern abhaken');
  await expect(page.getByRole('status').filter({ hasText: 'abgehakt' })).toBeVisible();

  await page.goto('/uebersicht');
  await submitUebersichtCapture(page, 'Sport für morgen abhaken');
  await expect(page.getByRole('status').filter({ hasText: 'abgehakt' })).toBeVisible();

  const logDates = (await pendingHabitLogDates(page)).sort();
  expect(logDates).toEqual([dateKeyOf(dueAt(MO, -1, 0, 0)), dateKeyOf(MO)].sort());
});

test('Offline-Pfad: eine Erfassung mit relativem Datum offline erreicht online die Datenbank', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  // beforeEach hat die Sync-Endpunkte bereits gekappt — das ist der Tunnel ohne Netz.
  const due = dueAt(MO, 3, 9, 0);

  await submitUebersichtCapture(page, 'in drei Tagen Rechnung zahlen');

  await page.waitForURL('**/aufgaben');
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Titel der Aufgabe' })).toHaveValue('Rechnung zahlen');
  await expect(dialog.getByLabel('Fälligkeit')).toHaveValue(isoToLocalInput(due));
  await dialog.getByRole('button', { name: 'Anlegen' }).click();

  await expect(taskItems(page).filter({ hasText: 'Rechnung zahlen' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  const row = await withDb((client) =>
    client.query('SELECT due_at FROM tasks WHERE title = $1', ['Rechnung zahlen']),
  );
  expect(row.rowCount).toBe(1);
  expect(new Date(row.rows[0].due_at).toISOString()).toBe(due.toISOString());
});
