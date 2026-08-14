import { expect, test, type Page } from '@playwright/test';
import {
  FIXED_NOW,
  installClockAt,
  registerPasskey,
  resetAppData,
  selectView,
  withDb,
} from './helpers';

const CAPTURE_LABEL = 'Aufgabe erfassen';
const CONFIRM_LABEL = 'Aufgabe bestätigen';
const CREATE_LABEL = 'Termin erfassen';

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
  return page.getByRole('dialog', { name: CREATE_LABEL });
}

/** Ganztägig/Von/Bis sitzen seit #712 hinter dem Wann-Chip — vor jedem Zugriff öffnen. */
function openWannChip(dialog: ReturnType<typeof eventDialog>) {
  return dialog.getByRole('button', { name: /^Wann/ }).click();
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

/** `YYYY-MM-DD` of the fixed "now" — same calendar day in Berlin time. */
function todayKey(): string {
  const date = new Date(FIXED_NOW);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // Neither the task- nor the event-side of the router may ever fetch directly
  // (CLAUDE.md rule 8) — everything below must survive with sync cut off.
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await installClockAt(page);
  await registerPasskey(page);
});

test('AC1: "morgen 12 Uhr Zahnarzt" navigiert nach /kalender, EventEditor vorbefüllt, Anlegen legt den Termin an', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const due = expectedDueAt(1, 12, 0);

  await submitUebersichtCapture(page, 'morgen 12 Uhr Zahnarzt');

  await page.waitForURL('**/kalender');
  const dialog = eventDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Titel')).toHaveValue('Zahnarzt');
  await openWannChip(dialog);
  await expect(dialog.getByRole('switch', { name: 'Ganztägig' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await expect(dialog.getByLabel('Von')).toHaveValue(isoToLocalInput(due));

  await dialog.getByRole('button', { name: 'Anlegen' }).click();
  await expect(dialog).toBeHidden();

  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.find((entry) => entry.table === 'events');
  expect(created?.payload).toMatchObject({
    title: 'Zahnarzt',
    allDay: false,
    startsAt: due.toISOString(),
  });
});

test('AC2: Freitext ohne erkanntes Datum ergibt einen ganztägigen Termin auf den heutigen Tag', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  await submitUebersichtCapture(page, 'Meeting mit Chef');

  await page.waitForURL('**/kalender');
  const dialog = eventDialog(page);
  await expect(dialog).toBeVisible();
  // "Meeting" bleibt im Titel stehen (R3, #687 AK3): nur Datum-/Zeit-Spans und
  // angrenzende Bindewörter werden entfernt, keine Vokabular-Blacklist mehr.
  await expect(dialog.getByLabel('Titel')).toHaveValue('Meeting mit Chef');
  await openWannChip(dialog);
  await expect(dialog.getByRole('switch', { name: 'Ganztägig' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(dialog.getByLabel('Von')).toHaveValue(todayKey());
  await expect(dialog.getByLabel('Bis')).toHaveValue(todayKey());
});

test('AC3: "hake Sport ab" hakt die Gewohnheit für heute direkt ab, Undo macht es rückgängig', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedHabit(page, { name: 'Sport', schedule: 'daily', color: null, archivedAt: null });

  await submitUebersichtCapture(page, 'hake Sport ab');

  // Kein Editor, keine Navigation — das Abhaken ist reversibel und trivial (issue #619).
  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(page.getByRole('dialog', { name: CAPTURE_LABEL })).toBeHidden();

  const checkbox = page.getByRole('checkbox', { name: 'Sport für heute abhaken' });
  await expect(checkbox).toBeChecked();

  const undoToast = page.getByRole('status').filter({ hasText: 'abgehakt' });
  await expect(undoToast).toBeVisible();
  await undoToast.getByRole('button', { name: 'Rückgängig' }).click();

  await expect(checkbox).not.toBeChecked();
  await expect(undoToast).toHaveCount(0);
});

test('AC4: Gewohnheitsname ohne eindeutigen Treffer navigiert nach /routinen, hakt nichts ab', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedHabit(page, { name: 'Yoga', schedule: 'daily', color: null, archivedAt: null });
  await seedHabit(page, { name: 'Lauf', schedule: 'daily', color: null, archivedAt: null });

  await submitUebersichtCapture(page, 'hake Yoga Lauf ab');

  await page.waitForURL('**/routinen');

  const entries = await page.evaluate(() => window.__starship.pending());
  expect(entries.some((entry) => entry.table === 'habit_logs')).toBe(false);
});

test('AC5: Kalender-Modul abgeschaltet macht aus "morgen 12 Uhr Zahnarzt" eine Aufgabe, keine Navigation zum Kalender', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await page.evaluate(() =>
    localStorage.setItem('starship:modules-off', JSON.stringify(['kalender'])),
  );
  await page.goto('/uebersicht');
  const due = expectedDueAt(1, 12, 0);

  await submitUebersichtCapture(page, 'morgen 12 Uhr Zahnarzt');

  await page.waitForURL('**/aufgaben');
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Titel der Aufgabe' })).toHaveValue('Zahnarzt');
  await expect(dialog.getByLabel('Fälligkeit')).toHaveValue(isoToLocalInput(due));
});

test('AC6: der Aufgaben-Pfad aus #618 bleibt unverändert — Freitext ohne Termin-Signal landet weiter direkt in /aufgaben', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  await submitUebersichtCapture(page, 'Wäsche waschen');

  await page.waitForURL('**/aufgaben');
  await selectView(page, 'Alle');
  await expect(confirmDialog(page)).toBeHidden();
  await expect(
    page
      .getByRole('list', { name: 'Aufgaben' })
      .getByRole('listitem')
      .filter({ hasText: 'Wäsche waschen' }),
  ).toBeVisible();
});

test('AC7: offline per Freitext erfasster Termin erreicht nach dem Onlinegehen die Datenbank', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  // beforeEach already cut the sync endpoints — that's what a train tunnel looks
  // like to the outbox (gleiches Muster wie capture-uebersicht.spec.ts AC6).
  const due = expectedDueAt(1, 12, 0);

  await submitUebersichtCapture(page, 'morgen 12 Uhr Zahnarzt');

  await page.waitForURL('**/kalender');
  const dialog = eventDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Anlegen' }).click();
  await expect(dialog).toBeHidden();

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  const row = await withDb((client) =>
    client.query('SELECT starts_at FROM events WHERE title = $1', ['Zahnarzt']),
  );
  expect(row.rowCount).toBe(1);
  expect(new Date(row.rows[0].starts_at).toISOString()).toBe(due.toISOString());
});
