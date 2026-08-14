import { expect, test, type Page } from '@playwright/test';
import {
  FIXED_NOW,
  installClockAt,
  registerPasskey,
  resetAppData,
  selectView,
  withDb,
} from './helpers';

/**
 * Ein Test je Akzeptanzkriterium des Span+Ranking-Umbaus (issue #687, Teil 1 von 3 des
 * Parser-Umbaus, Epic #617) — alle über den Erfassungspunkt auf `/uebersicht`, wie in
 * capture-uebersicht.spec.ts/capture-router.spec.ts. Die Klassifikations-Fälle selbst
 * (AC7-Tabelle, bestehender Korpus) laufen als Vitest-Korpus in local-recognizer.test.ts —
 * hier geht es um das end-to-end sichtbare Verhalten je AK.
 */

const CAPTURE_LABEL = 'Aufgabe erfassen';
const EVENT_LABEL = 'Termin erfassen';

function captureButton(page: Page) {
  return page.getByRole('button', { name: CAPTURE_LABEL });
}

function captureTitleField(page: Page) {
  return page.getByRole('textbox', { name: 'Titel der Aufgabe' });
}

function captureDialog(page: Page) {
  return page.getByRole('dialog', { name: CAPTURE_LABEL });
}

function eventDialog(page: Page) {
  return page.getByRole('dialog', { name: EVENT_LABEL });
}

/** Von/Bis sitzen seit #712 hinter dem Wann-Chip — vor jedem Zugriff öffnen. */
function openWannChip(dialog: ReturnType<typeof eventDialog>) {
  return dialog.getByRole('button', { name: /^Wann/ }).click();
}

function taskItems(page: Page) {
  return page.getByRole('list', { name: 'Aufgaben' }).getByRole('listitem');
}

async function submitUebersichtCapture(page: Page, text: string) {
  await captureButton(page).click();
  await captureTitleField(page).fill(text);
  await page.getByRole('button', { name: 'Anlegen' }).click();
}

async function seedHabit(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'habits', op: 'upsert', payload: p }),
    payload,
  );
}

/** Mirrors parse-task-input.ts's own default time (09:00), computed at run time —
 * never hard-coded (helpers.ts pattern used elsewhere). */
function expectedDueAt(daysFromNow: number, hours: number, minutes: number): Date {
  const date = new Date(FIXED_NOW);
  date.setDate(date.getDate() + daysFromNow);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

/** `datetime-local` works in the browser's local time, with no timezone suffix. */
function isoToLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // Weder Aufgaben- noch Termin-Pfad dürfen je direkt fetchen (CLAUDE.md Regel 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await installClockAt(page);
  await registerPasskey(page);
});

test('AK1: Schreibweise der Uhrzeit ändert das Ergebnis nicht — "um H Uhr" bleibt kein Rest im Titel', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const due = expectedDueAt(1, 14, 0);

  await submitUebersichtCapture(page, 'morgen um 14 Uhr Zahnarzt');

  await page.waitForURL('**/kalender');
  const dialog = eventDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Titel')).toHaveValue('Zahnarzt');
  await openWannChip(dialog);
  await expect(dialog.getByLabel('Von')).toHaveValue(isoToLocalInput(due));
});

test('AK2: Uhrzeit ohne Datum wird ausgewertet — heute, wenn noch in der Zukunft, sonst morgen', async ({
  page,
}) => {
  // FIXED_NOW liegt bei 14:00 Berlin (helpers.ts) — 18 Uhr ist noch in der Zukunft.
  await page.goto('/uebersicht');
  const dueToday = expectedDueAt(0, 18, 0);
  await submitUebersichtCapture(page, 'Zahnarzt um 18 Uhr');

  await page.waitForURL('**/kalender');
  let dialog = eventDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Titel')).toHaveValue('Zahnarzt');
  await openWannChip(dialog);
  await expect(dialog.getByLabel('Von')).toHaveValue(isoToLocalInput(dueToday));
  // Kein "Abbrechen"-Button im Event-Editor (event-editor.tsx) — das <dialog> schließt
  // nativ über ESC (sheet.tsx).
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Bewusst eine Doppelpunkt-Uhrzeit ("6:00"), keine Stunde <=12 als "H Uhr" (z. B.
  // "9 Uhr"): die ist seit #688 (R2) tageshälften-mehrdeutig und zur Sprechzeit
  // aufgelöst, das würde diesen Rollover-Test mit R2 vermischen (eigenständig in
  // capture-zeigerzeit.spec.ts abgedeckt). Eine Doppelpunkt-Zeit ist laut R2 Regel 3
  // nie geraten, bleibt also so oder so 6:00 — und diese Suite pinnt keine
  // Prozess-Zeitzone (weder hier noch in CI, siehe playwright.config.ts), FIXED_NOW
  // (12:00 UTC) liest sich je nach Host-TZ als 12:00 (CI, i. d. R. UTC) oder 14:00
  // (lokal, meist Europe/Berlin) — 13 Uhr läge dazwischen und wäre nur in einer der
  // beiden Lesarten schon vergangen (genau der Grund für den vorigen CI-Fehlschlag).
  // 6:00 liegt unter beiden Lesarten sicher in der Vergangenheit -> morgen (AC2, #687).
  await page.goto('/uebersicht');
  const dueTomorrow = expectedDueAt(1, 6, 0);
  await submitUebersichtCapture(page, 'Zahnarzt um 6:00');

  await page.waitForURL('**/kalender');
  dialog = eventDialog(page);
  await expect(dialog).toBeVisible();
  await openWannChip(dialog);
  await expect(dialog.getByLabel('Von')).toHaveValue(isoToLocalInput(dueTomorrow));
});

test('AK3: Titel ist der Rest, nicht das Ergebnis einer Blacklist — Bindewörter fallen nur an der Span-Grenze', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  // "Zahnarzt am Dienstag um 12 in der Klinik": "am"/"um" stehen direkt an
  // Datum-/Zeit-Spans und fallen, "in der Klinik" ist kein Bindewort und bleibt.
  const today = new Date(FIXED_NOW);
  const diff = (2 - today.getDay() + 7) % 7 || 7; // nächster Dienstag, nie heute
  const due = expectedDueAt(diff, 12, 0);

  await submitUebersichtCapture(page, 'Zahnarzt am Dienstag um 12 in der Klinik');

  await page.waitForURL('**/kalender');
  const dialog = eventDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Titel')).toHaveValue('Zahnarzt in der Klinik');
  await openWannChip(dialog);
  await expect(dialog.getByLabel('Von')).toHaveValue(isoToLocalInput(due));
});

test('AK4: Kommandopräfixe fallen, Inhalt bleibt — "Termin" nur vor einem Datum-/Zeit-Span, "beim" als Bindewort danach', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const due = expectedDueAt(1, 12, 0);

  await submitUebersichtCapture(page, 'Termin morgen um 12 beim Zahnarzt');

  await page.waitForURL('**/kalender');
  const dialog = eventDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Titel')).toHaveValue('Zahnarzt');
  await openWannChip(dialog);
  await expect(dialog.getByLabel('Von')).toHaveValue(isoToLocalInput(due));
});

test('AK5: bleibt kein Titel übrig, bleibt er leer — der Editor öffnet mit Fokus im leeren Titelfeld', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const due = expectedDueAt(1, 12, 0);

  await submitUebersichtCapture(page, 'morgen um 12');

  await page.waitForURL('**/kalender');
  const dialog = eventDialog(page);
  await expect(dialog).toBeVisible();
  const titleField = dialog.getByLabel('Titel');
  await expect(titleField).toHaveValue('');
  await expect(titleField).toBeFocused();
  await openWannChip(dialog);
  await expect(dialog.getByLabel('Von')).toHaveValue(isoToLocalInput(due));
});

test('AK6: Verneinung und fehlender Habit-Treffer legen nichts an — Meldung "Keiner Gewohnheit zugeordnet", Eingabe bleibt stehen', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedHabit(page, { name: 'Sport', schedule: 'daily', color: null, archivedAt: null });

  // "Sport heute nicht gemacht": Erledigungsverb + Habit-Treffer, aber verneint —
  // heute hakt dieser Satz die Gewohnheit fälschlich ab (der teuerste Fehler im Korpus).
  await submitUebersichtCapture(page, 'Sport heute nicht gemacht');

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(captureDialog(page)).toBeVisible();
  await expect(captureTitleField(page)).toHaveValue('Sport heute nicht gemacht');
  await expect(page.getByText('Keiner Gewohnheit zugeordnet')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Sport für heute abhaken' })).not.toBeChecked();
  await expect(page.getByRole('status').filter({ hasText: 'abgehakt' })).toHaveCount(0);

  // "Wäsche erledigt": Erledigungsverb, aber kein Habit-Treffer überhaupt — auch das
  // legt nichts an, dieselbe Meldung, statt still eine Aufgabe "Wäsche erledigt" anzulegen.
  await captureTitleField(page).fill('Wäsche erledigt');
  await page.getByRole('button', { name: 'Anlegen' }).click();

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(captureDialog(page)).toBeVisible();
  await expect(captureTitleField(page)).toHaveValue('Wäsche erledigt');
  await expect(page.getByText('Keiner Gewohnheit zugeordnet')).toBeVisible();

  // Einziger Outbox-Eintrag bleibt das Anlegen der Test-Gewohnheit selbst (seedHabit
  // oben) — weder ein Abhaken (habit_logs) noch eine Aufgabe (tasks) kommt dazu.
  const entries = await page.evaluate(() => window.__starship.pending());
  expect(entries.some((entry) => entry.table === 'habit_logs')).toBe(false);
  expect(entries.some((entry) => entry.table === 'tasks')).toBe(false);
});

test('AK7: Klassifikation bleibt unverändert grün — neuer Korpus-Fall "nicht vergessen" landet als Aufgabe ohne Bindewort-Verlust', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  await submitUebersichtCapture(page, 'nicht vergessen: Pass verlängern');

  // Kein Datum -> legt ohne Bestätigungs-Sheet direkt an (gleiches Muster wie
  // capture-uebersicht.spec.ts AC4). "nicht vergessen" ist reines Klassifikations-
  // Vokabular (task), keine Wort-Blacklist mehr -> bleibt Teil des Titels (R3).
  await page.waitForURL('**/aufgaben');
  await selectView(page, 'Alle');
  await expect(page.getByRole('dialog', { name: 'Aufgabe bestätigen' })).toBeHidden();
  await expect(
    taskItems(page).filter({ hasText: 'nicht vergessen: Pass verlängern' }),
  ).toBeVisible();
});

test('Offline-Pfad: eine Erfassung offline erreicht nach dem Onlinegehen die Datenbank', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  // beforeEach hat die Sync-Endpunkte bereits gekappt — das ist der Tunnel ohne Netz.
  const due = expectedDueAt(1, 9, 0);

  await submitUebersichtCapture(page, 'Rechnung bezahlen morgen');

  await page.waitForURL('**/aufgaben');
  const dialog = page.getByRole('dialog', { name: 'Aufgabe bestätigen' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Titel der Aufgabe' })).toHaveValue(
    'Rechnung bezahlen',
  );
  await dialog.getByRole('button', { name: 'Anlegen' }).click();

  await expect(taskItems(page).filter({ hasText: 'Rechnung bezahlen' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  const row = await withDb((client) =>
    client.query('SELECT due_at FROM tasks WHERE title = $1', ['Rechnung bezahlen']),
  );
  expect(row.rowCount).toBe(1);
  expect(new Date(row.rows[0].due_at).toISOString()).toBe(due.toISOString());
});
