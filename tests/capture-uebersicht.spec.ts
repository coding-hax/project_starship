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

function captureButton(page: Page) {
  return page.getByRole('button', { name: CAPTURE_LABEL });
}

function captureTitleField(page: Page) {
  return page.getByRole('textbox', { name: 'Titel der Aufgabe' });
}

function confirmDialog(page: Page) {
  return page.getByRole('dialog', { name: CONFIRM_LABEL });
}

/** Scoped to the task list — the undo toast's own message embeds the title too. */
function taskItems(page: Page) {
  return page.getByRole('list', { name: 'Aufgaben' }).getByRole('listitem');
}

async function submitUebersichtCapture(page: Page, text: string) {
  await captureButton(page).click();
  await captureTitleField(page).fill(text);
  await page.getByRole('button', { name: 'Anlegen' }).click();
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

async function enableDirectCapture(page: Page) {
  await page.goto('/einstellungen');
  await page.getByRole('switch', { name: 'Ohne Bestätigung direkt anlegen' }).click();
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // The list must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await installClockAt(page);
  await registerPasskey(page);
});

test('AC1: der Erfassungsknopf ist auf /uebersicht sichtbar, öffnet das Sheet, der Cursor steht im Feld', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  await expect(captureButton(page)).toBeVisible();
  await captureButton(page).click();

  await expect(captureTitleField(page)).toBeVisible();
  await expect(captureTitleField(page)).toBeFocused();
});

test('AC2: Freitext mit Datum navigiert nach /aufgaben und öffnet CaptureConfirm vorbefüllt', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  // Kein "um 12" mehr: seit #619 macht eine explizite Uhrzeit daraus einen Termin
  // (Router landet dann auf /kalender, siehe capture-router.spec.ts) — reines
  // Datum ohne Uhrzeit bleibt task, genau was dieser Test hier prüfen will.
  const due = expectedDueAt(1, 9, 0);

  await submitUebersichtCapture(page, 'Arzt anrufen morgen');

  await page.waitForURL('**/aufgaben');
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Titel der Aufgabe' })).toHaveValue(
    'Arzt anrufen',
  );
  await expect(dialog.getByLabel('Fälligkeit')).toHaveValue(isoToLocalInput(due));
});

test('AC3: Bestätigen legt die Aufgabe an, sie erscheint in der Liste', async ({ page }) => {
  await page.goto('/uebersicht');
  await submitUebersichtCapture(page, 'Arzt anrufen morgen');
  await page.waitForURL('**/aufgaben');

  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Anlegen' }).click();

  await expect(dialog).toBeHidden();
  await expect(taskItems(page).filter({ hasText: 'Arzt anrufen' })).toBeVisible();
});

test('AC4: Freitext ohne Datum legt die Aufgabe ohne Fälligkeit sofort an, kein Sheet', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await submitUebersichtCapture(page, 'Wäsche waschen');

  await page.waitForURL('**/aufgaben');
  await selectView(page, 'Alle');
  await expect(confirmDialog(page)).toBeHidden();
  await expect(taskItems(page).filter({ hasText: 'Wäsche waschen' })).toBeVisible();
});

test('AC5: "ohne Bestätigung direkt anlegen" greift auch von der Übersicht her — kein Sheet, Undo-Toast', async ({
  page,
}) => {
  await enableDirectCapture(page);
  await page.goto('/uebersicht');

  // Keine explizite Uhrzeit (siehe AC2-Kommentar oben) — bleibt task.
  await submitUebersichtCapture(page, 'Übergabe morgen');

  await page.waitForURL('**/aufgaben');
  await expect(confirmDialog(page)).toBeHidden();
  await expect(taskItems(page).filter({ hasText: 'Übergabe' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'angelegt' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeVisible();
});

test('AC6: offline auf der Übersicht erfasst, bestätigt, erreicht online die Datenbank', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  // beforeEach already cut the sync endpoints — that's what a train tunnel looks
  // like to the outbox. Keine explizite Uhrzeit (siehe AC2-Kommentar oben) — bleibt task.
  await submitUebersichtCapture(page, 'Im Zug notiert morgen');
  await page.waitForURL('**/aufgaben');
  await confirmDialog(page).getByRole('button', { name: 'Anlegen' }).click();

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

test('AC9: bei 375px und erhöhter --font-scale bleibt die Titelzeile ohne horizontalen Überlauf, der Knopf überlappt nicht', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await page.evaluate(() => localStorage.setItem('starship:text-scale', '1.25'));
  await page.reload();

  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--font-scale'),
      ),
    )
    .toBe('1.25');

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);

  const titleRow = page.locator('.uebersicht__title-row');
  const button = captureButton(page);
  const [rowBox, buttonBox] = await Promise.all([titleRow.boundingBox(), button.boundingBox()]);
  expect(rowBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  if (rowBox && buttonBox) {
    expect(buttonBox.x).toBeGreaterThanOrEqual(rowBox.x - 0.5);
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 0.5);
  }
});

test('AC7+AC8 Durchstich: iOS-Satzzeichen und ausgeschriebene Uhrzeit ergeben einen sauberen Titel und das richtige absolute Datum — seit #619 als Termin (explizite Uhrzeit routet nach /kalender)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const due = expectedDueAt(1, 12, 0);

  await submitUebersichtCapture(page, 'Zahnarzt morgen um zwölf.');

  await page.waitForURL('**/kalender');
  const dialog = page.getByRole('dialog', { name: 'Termin erfassen' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Titel')).toHaveValue('Zahnarzt');
  // Von sitzt seit #712 hinter dem Wann-Chip.
  await dialog.getByRole('button', { name: /^Wann/ }).click();
  await expect(dialog.getByLabel('Von')).toHaveValue(isoToLocalInput(due));
});

test('das Titelfeld ist schlicht mit „Todo Titel" beschriftet (issue #650 AK2)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await captureButton(page).click();

  await expect(captureTitleField(page)).toHaveAttribute('placeholder', 'Todo Titel');
});
