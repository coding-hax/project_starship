import { expect, test, type Page } from '@playwright/test';
import { FIXED_NOW, installClockAt, registerPasskey, resetAppData, withDb } from './helpers';

const CAPTURE_LABEL = 'Aufgabe erfassen';

function captureButton(page: Page) {
  return page.getByRole('button', { name: CAPTURE_LABEL });
}

function captureDialog(page: Page) {
  return page.getByRole('dialog', { name: CAPTURE_LABEL });
}

function captureTitleField(page: Page) {
  return page.getByRole('textbox', { name: 'Titel der Aufgabe' });
}

/** Scoped to the full list on `/aufgaben` — the undo toast's own message
 * embeds the title too, and `/uebersicht`'s own Aufgaben-Sektion uses a
 * `aria-labelledby`-Überschrift statt eines wörtlichen `aria-label`. */
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

test('AC2: Freitext mit Datum zeigt die geratene Fälligkeit inline im Kern-Sheet, kein Bestätigen-Dialog mehr (issue #715 AK3)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  // Kein "um 12" mehr: seit #619 macht eine explizite Uhrzeit daraus einen Termin
  // (siehe capture-router.spec.ts) — reines Datum ohne Uhrzeit bleibt task, genau
  // was dieser Test hier prüfen will.
  const due = expectedDueAt(1, 9, 0);

  await captureButton(page).click();
  await captureTitleField(page).fill('Arzt anrufen morgen');

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(page.getByRole('dialog', { name: 'Aufgabe bestätigen' })).toHaveCount(0);
  const dueChip = page.getByRole('button', { name: /^Fälligkeit,/ });
  await expect(dueChip).toBeVisible();
  await dueChip.click();
  // Nicht `getByLabel('Fälligkeit')`: `/uebersicht`s eigene „Fällige Aufgaben"-
  // Sektion (task-list.tsx) und das AK4-„Mehr"-Sheet (task-editor.tsx) tragen je
  // ein eigenes, immer gemountetes Feld gleichen Namens im DOM.
  await expect(page.locator('#uebersicht-capture-panel-wann')).toHaveValue(isoToLocalInput(due));
});

test('AC3: "Anlegen" legt die Aufgabe direkt an, sie erscheint in der Liste', async ({ page }) => {
  await page.goto('/uebersicht');

  await submitUebersichtCapture(page, 'Arzt anrufen morgen');

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(captureDialog(page)).toBeHidden();
  await page.goto('/aufgaben');
  await expect(taskItems(page).filter({ hasText: 'Arzt anrufen' })).toBeVisible();
});

test('AC4: Freitext ohne Datum legt die Aufgabe ohne Fälligkeit sofort an, kein Sheet', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await submitUebersichtCapture(page, 'Wäsche waschen');

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(captureDialog(page)).toBeHidden();
  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.find((entry) => entry.table === 'tasks');
  expect(created?.payload).toMatchObject({ title: 'Wäsche waschen' });
  expect(created?.payload.dueAt).toBeUndefined();
});

test('AC5: "ohne Bestätigung direkt anlegen" hat auf der Übersicht keine Wirkung mehr — es gibt dort ohnehin nie einen Zwischenschritt (issue #715 AK3)', async ({
  page,
}) => {
  await enableDirectCapture(page);
  await page.goto('/uebersicht');

  // Keine explizite Uhrzeit (siehe AC2-Kommentar oben) — bleibt task.
  await submitUebersichtCapture(page, 'Übergabe morgen');

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(captureDialog(page)).toBeHidden();
  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.find((entry) => entry.table === 'tasks');
  expect(created?.payload).toMatchObject({ title: 'Übergabe' });
});

test('AC6: offline auf der Übersicht erfasst, erreicht online die Datenbank', async ({ page }) => {
  await page.goto('/uebersicht');
  // beforeEach already cut the sync endpoints — that's what a train tunnel looks
  // like to the outbox. Keine explizite Uhrzeit (siehe AC2-Kommentar oben) — bleibt task.
  await submitUebersichtCapture(page, 'Im Zug notiert morgen');

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(captureDialog(page)).toBeHidden();
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

test('AC7+AC8 Durchstich: iOS-Satzzeichen und ausgeschriebene Uhrzeit ergeben einen sauberen Titel und das richtige absolute Datum — als Termin in-place angelegt (issue #715 AK3)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const due = expectedDueAt(1, 12, 0);

  await submitUebersichtCapture(page, 'Zahnarzt morgen um zwölf.');

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(captureDialog(page)).toBeHidden();
  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.find((entry) => entry.table === 'events');
  expect(created?.payload).toMatchObject({ title: 'Zahnarzt', startsAt: due.toISOString() });
});

test('das Titelfeld ist schlicht mit „Todo Titel" beschriftet (issue #650 AK2)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await captureButton(page).click();

  await expect(captureTitleField(page)).toHaveAttribute('placeholder', 'Todo Titel');
});
