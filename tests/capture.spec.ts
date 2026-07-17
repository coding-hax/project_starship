import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetDatabase, withDb } from './helpers';

const QUICK_ADD_LABEL = 'Aufgabe erfassen';
const CONFIRM_LABEL = 'Aufgabe bestätigen';

async function openQuickAdd(page: Page) {
  await page.getByRole('button', { name: QUICK_ADD_LABEL }).click();
}

function quickAddTitleField(page: Page) {
  return page.getByRole('textbox', { name: 'Titel der Aufgabe' });
}

function confirmDialog(page: Page) {
  return page.getByRole('dialog', { name: CONFIRM_LABEL });
}

async function submitQuickAdd(page: Page, text: string) {
  await openQuickAdd(page);
  await quickAddTitleField(page).fill(text);
  await page.getByRole('button', { name: 'Hinzufügen' }).click();
}

/** Mirrors parse-task-input.ts's own default time (09:00) and the summary formatting
 * in capture-confirm.tsx, computed at run time — never hard-coded (helper.ts pattern
 * used elsewhere: the assertion must not depend on which day the suite runs). */
function expectedDueAt(daysFromNow: number, hours: number, minutes: number): Date {
  const date = new Date();
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
  await resetDatabase();
  // The list must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await registerPasskey(page);
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
  await expect(page.getByText('Arzt anrufen')).toBeVisible();
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
  await expect(page.getByText('Zahnarzt')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
});

test('AC2: eine Eingabe ohne Datum legt sofort an, ohne Bestätigungs-Sheet', async ({ page }) => {
  await page.goto('/aufgaben');
  await submitQuickAdd(page, 'Wäsche waschen');

  await expect(confirmDialog(page)).toBeHidden();
  await expect(page.getByText('Wäsche waschen')).toBeVisible();
});

test('AC3+AC4: Direkt-Pfad übergeht das Sheet, zeigt einen Undo-Toast, der die Anlage per Tombstone rückgängig macht', async ({
  page,
}) => {
  await enableDirectCapture(page);
  await page.goto('/aufgaben');
  const due = expectedDueAt(1, 15, 0);

  await submitQuickAdd(page, 'Übergabe morgen 15:00');

  await expect(confirmDialog(page)).toBeHidden();
  await expect(page.getByText('Übergabe')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'angelegt' })).toBeVisible();
  const undoButton = page.getByRole('button', { name: 'Rückgängig' });
  await expect(undoButton).toBeVisible();

  const row = await withDb((client) =>
    client.query('SELECT title FROM tasks WHERE title = $1', ['Übergabe']),
  );
  expect(row.rowCount).toBe(0); // noch nicht synchronisiert, aber lokal schon sichtbar
  const entries = await page.evaluate(() => window.__starship.pending());
  expect(entries[entries.length - 1].payload).toMatchObject({ dueAt: due.toISOString() });

  await undoButton.click();

  await expect(page.getByText('Übergabe')).toHaveCount(0);
  const lastEntry = (await page.evaluate(() => window.__starship.pending())).at(-1);
  expect(lastEntry?.op).toBe('delete');
});

test('AC5: offline im Bestätigungs-Sheet angelegt übersteht den Reload und erreicht online die Datenbank', async ({
  page,
  context,
}) => {
  await page.goto('/aufgaben');
  await context.setOffline(true);

  await submitQuickAdd(page, 'Im Zug notiert morgen um 8');
  await confirmDialog(page).getByRole('button', { name: 'Anlegen' }).click();

  await expect(page.getByText('Im Zug notiert')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  await page.reload();
  await expect(page.getByText('Im Zug notiert')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  await context.setOffline(false);
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
