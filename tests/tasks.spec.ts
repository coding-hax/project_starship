import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  FIXED_NOW,
  installClockAt,
  registerPasskey,
  resetAppData,
  selectView,
  withDb,
} from './helpers';

const QUICK_ADD_LABEL = 'Aufgabe erfassen';
const EDITOR_LABEL = 'Aufgabe bearbeiten';

async function openQuickAdd(page: Page) {
  await page.getByRole('button', { name: QUICK_ADD_LABEL }).click();
}

function quickAddTitleField(page: Page) {
  return page.getByRole('textbox', { name: 'Titel der Aufgabe' });
}

function editorDialog(page: Page) {
  return page.getByRole('dialog', { name: EDITOR_LABEL });
}

async function tapTask(page: Page, title: string) {
  await taskItems(page).filter({ hasText: title }).click();
}

async function seedTask(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: p }),
    payload,
  );
}

/** Scoped to the task list — a page-wide listitem query also matches the nav tabs. */
function taskItems(page: Page) {
  return page.getByRole('list', { name: 'Aufgaben' }).getByRole('listitem');
}

/**
 * Drives the same Pointer Events the component listens to — works identically for a
 * real touch, a real mouse drag, and this synthetic one, so the gesture logic under
 * test is exactly what a device would send.
 */
async function swipeRight(locator: Locator, distancePx: number) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('swipeRight: target has no bounding box');
  const clientY = box.y + box.height / 2;
  const startX = box.x + 20;

  await locator.dispatchEvent('pointerdown', {
    pointerId: 1,
    clientX: startX,
    clientY,
    button: 0,
    bubbles: true,
  });
  await locator.dispatchEvent('pointermove', {
    pointerId: 1,
    clientX: startX + distancePx,
    clientY,
    bubbles: true,
  });
  await locator.dispatchEvent('pointerup', {
    pointerId: 1,
    clientX: startX + distancePx,
    clientY,
    bubbles: true,
  });
}

/** Same as `swipeRight`, other direction — starts near the right edge, drags left. */
async function swipeLeft(locator: Locator, distancePx: number) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('swipeLeft: target has no bounding box');
  const clientY = box.y + box.height / 2;
  const startX = box.x + box.width - 20;

  await locator.dispatchEvent('pointerdown', {
    pointerId: 1,
    clientX: startX,
    clientY,
    button: 0,
    bubbles: true,
  });
  await locator.dispatchEvent('pointermove', {
    pointerId: 1,
    clientX: startX - distancePx,
    clientY,
    bubbles: true,
  });
  await locator.dispatchEvent('pointerup', {
    pointerId: 1,
    clientX: startX - distancePx,
    clientY,
    bubbles: true,
  });
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // The list must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8) —
  // with the sync endpoints cut, that is the only way any of these tests can pass.
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  // No target: every test in this file opens with its own goto, so loading
  // /uebersicht here would only be thrown away (issue #1075).
  await registerPasskey(page, null);
});

test('a task created locally appears without any network request', async ({ page }) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Milch kaufen' });

  await expect(page.getByText('Milch kaufen')).toBeVisible();
});

test('„Alle" zeigt nur offene Aufgaben — Erledigtes bleibt außen vor (issue #814)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Offene Aufgabe' });
  await seedTask(page, {
    title: 'Erledigte Aufgabe',
    completedAt: new Date(FIXED_NOW).toISOString(),
  });

  await expect(taskItems(page)).toHaveCount(1);
  await expect(taskItems(page).filter({ hasText: 'Offene Aufgabe' })).toBeVisible();
  await expect(taskItems(page).filter({ hasText: 'Erledigte Aufgabe' })).toHaveCount(0);
});

test('offline erledigt greift sofort in der UI, liegt in der Outbox und erreicht online die Datenbank', async ({
  page,
  context,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const title = 'Offline erledigen';
  await seedTask(page, { title });
  await context.setOffline(true);

  const item = taskItems(page).filter({ hasText: title });
  await swipeRight(item, 120);

  await expect(item).toHaveCount(0);
  // One entry for the seed, one for the completion — both still queued offline.
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(2);

  await page.unroute('**/api/sync/**');
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  const row = await withDb((client) =>
    client.query('SELECT completed_at FROM tasks WHERE title = $1', [title]),
  );
  expect(row.rows[0].completed_at).not.toBeNull();
});

test('erneutes Wischen nach rechts macht eine erledigte Aufgabe wieder offen', async ({ page }) => {
  await page.goto('/aufgaben');
  // "Erledigt" statt "Alle" (issue #814) — dort ist die erledigte Zeile
  // überhaupt sichtbar, seit "Alle" nur noch Offenes zeigt.
  await selectView(page, 'Erledigt');
  const title = 'Toggle-Testfall';
  await seedTask(page, { title, completedAt: new Date(FIXED_NOW).toISOString() });
  const item = taskItems(page).filter({ hasText: title });
  await expect(item).toHaveClass(/task-list__item--done/);

  await swipeRight(item, 120);

  // Wiedergeöffnet fällt die Zeile aus "Erledigt" heraus — dieselbe
  // Austritts-Mechanik wie beim Erledigen in "Alle" (issue #814).
  await expect(item).toHaveCount(0);
  await selectView(page, 'Alle');
  await expect(taskItems(page).filter({ hasText: title })).not.toHaveClass(
    /task-list__item--done/,
  );
  // Toggling back open is the corrective action itself — no undo offer for it.
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeHidden();
});

test('nur die geänderte Priorität landet in der Mutation, nicht der ganze Datensatz', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Nur Priorität ändern', priority: 0 });

  await tapTask(page, 'Nur Priorität ändern');
  const dialog = editorDialog(page);
  await dialog.getByRole('radio', { name: 'Dringend' }).check();
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  await expect(dialog).toBeHidden();

  const entries = await page.evaluate(() => window.__starship.pending());
  const last = entries[entries.length - 1];
  expect(last.op).toBe('upsert');
  expect(last.payload).toEqual({ priority: 2 });
});

// --- Issue #706 (T3 of #699): grip feedback on the flat rows T1 introduced -----

/* -------------------------------------------------------------------------- */
/* Subtasks / nesting (issue #89)                                             */
/* -------------------------------------------------------------------------- */

function progressFor(page: Page, title: string) {
  return taskItems(page).filter({ hasText: title }).locator('.task-list__progress');
}

function nestSelect(page: Page) {
  return page.getByRole('combobox', { name: 'Unteraufgabe von' });
}

test('Elternaufgabe löschen tombstoned die Kinder mit, ohne Rückgängig-Popup; der Server landet mit allen drei Tombstones (issue #89 AK6)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, { title: 'Elternaufgabe' });
  await seedTask(page, { title: 'Kind A', parentId });
  await seedTask(page, { title: 'Kind B', parentId });
  await expect(taskItems(page)).toHaveCount(3);

  const parentItem = taskItems(page).filter({ hasText: 'Elternaufgabe' });
  await swipeLeft(parentItem, 120);

  await expect(taskItems(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeHidden();

  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const rows = await withDb((client) =>
    client.query('SELECT deleted_at FROM tasks WHERE title IN ($1, $2, $3)', [
      'Elternaufgabe',
      'Kind A',
      'Kind B',
    ]),
  );
  expect(rows.rowCount).toBe(3);
  for (const row of rows.rows) {
    expect(row.deleted_at).not.toBeNull();
  }
});

test('ein Kind wird offline über den Editor zugeordnet und erreicht online die Datenbank mit gesetztem parent_id (issue #89 AK Offline)', async ({
  page,
  context,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, { title: 'Elternaufgabe' });
  await seedTask(page, { title: 'Unteraufgabe' });
  await context.setOffline(true);

  await tapTask(page, 'Unteraufgabe');
  await nestSelect(page).selectOption({ label: 'Elternaufgabe' });
  await page.getByRole('button', { name: 'Speichern' }).click();

  await expect(progressFor(page, 'Elternaufgabe')).toHaveText('0/1');

  await page.unroute('**/api/sync/**');
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT parent_id FROM tasks WHERE title = $1', ['Unteraufgabe']),
  );
  expect(row.rows[0].parent_id).toBe(parentId);
});

/* -------------------------------------------------------------------------- */
/* Anlege-Sheet: Chip-Zeile (issue #650, Chips seit issue #711)                */
/* -------------------------------------------------------------------------- */

function quickAddDialog(page: Page) {
  return page.getByRole('dialog', { name: QUICK_ADD_LABEL });
}

/** A chip body's accessible name is either just the field name (leer) or
 * `"${field}, ${value}"` (gesetzt/geraten) — anchored so it never also matches
 * a guessed chip's `"${field} verwerfen"` discard button (issue #711 AK6). */
function quickAddChip(page: Page, field: string) {
  return quickAddDialog(page).getByRole('button', { name: new RegExp(`^${field}(,|$)`) });
}

function quickAddNotes(page: Page) {
  return quickAddDialog(page).getByRole('textbox', { name: 'Notiz der Aufgabe' });
}

/** The Wann panel's own picker (issue #722) — replaces the native
 * `datetime-local` input `quickAddDueInput` used to scope to. */
function quickAddDuePicker(page: Page) {
  return quickAddDialog(page).locator('.due-picker');
}

/** A calendar day cell by its full a11y label, e.g. `"Montag, 20."`. */
function dueCalendarDay(page: Page, label: string) {
  return quickAddDuePicker(page).getByRole('button', { name: label });
}

function dueTimeInput(page: Page) {
  return quickAddDuePicker(page).getByLabel('Uhrzeit');
}

/** Sets a due date+time through the picker the same way a person would: tap
 * the calendar day, optionally the time field — never the raw `dueAt` value,
 * so these tests exercise the actual control (issue #722). */
async function setDueViaCalendar(page: Page, dayLabel: string, time?: string) {
  await dueCalendarDay(page, dayLabel).click();
  if (time) await dueTimeInput(page).fill(time);
}

async function submitQuickAdd(page: Page) {
  await quickAddDialog(page).getByRole('button', { name: 'Anlegen' }).click();
}

test('offline über die Chips gesetzt: die Werte erreichen die echte Datenbank (issue #650 AK7)', async ({
  page,
  context,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await context.setOffline(true);

  await openQuickAdd(page);
  await quickAddTitleField(page).fill('Offline mit Priorität');
  await quickAddChip(page, 'Notiz').click();
  await quickAddNotes(page).fill('Im Zug notiert');
  await quickAddChip(page, 'Priorität').click();
  await quickAddDialog(page).getByRole('radio', { name: 'Dringend' }).check();
  await submitQuickAdd(page);

  await expect(page.getByText('Offline mit Priorität')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  // beforeEach cuts the sync endpoints so the list can only ever come from
  // IndexedDB — lift that here to let the queued mutation actually reach Postgres.
  await page.unroute('**/api/sync/**');
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT notes, priority FROM tasks WHERE title = $1', ['Offline mit Priorität']),
  );
  expect(row.rowCount).toBe(1);
  expect(row.rows[0]).toMatchObject({ notes: 'Im Zug notiert', priority: 2 });
});

/* -------------------------------------------------------------------------- */
/* Wann-Picker: Schnellwahl + Kalender statt datetime-local (issue #722)      */
/* -------------------------------------------------------------------------- */

test('AK4: der über den Picker gesetzte Wert kommt unverändert in der Datenbank an — auch offline', async ({
  page,
  context,
}) => {
  await installClockAt(page);
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await context.setOffline(true);

  await openQuickAdd(page);
  await quickAddTitleField(page).fill('Offline über den Picker');
  await quickAddChip(page, 'Fälligkeit').click();
  await setDueViaCalendar(page, 'Montag, 20.', '11:30');
  await submitQuickAdd(page);

  await expect(page.getByText('Offline über den Picker')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  // beforeEach cuts the sync endpoints so the list can only ever come from
  // IndexedDB — lift that here to let the queued mutation actually reach Postgres.
  await page.unroute('**/api/sync/**');
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT due_at FROM tasks WHERE title = $1', ['Offline über den Picker']),
  );
  expect(row.rowCount).toBe(1);
  expect(new Date(row.rows[0].due_at).toISOString()).toBe(
    new Date('2026-07-20T11:30').toISOString(),
  );
});

/* -------------------------------------------------------------------------- */
/* Wochenausschnitt, Woche/Alle/Erledigt-Umschalter (issue #705)              */
/* -------------------------------------------------------------------------- */

function viewOption(page: Page, name: '7 Tage' | 'Alle' | 'Erledigt') {
  return page.getByRole('radiogroup', { name: 'Aufgaben-Ansicht' }).getByRole('radio', { name });
}

/** `FIXED_NOW` shifted by whole local-calendar days, at a fixed local clock time —
 *  mirrors the `expectedDueAt` helpers the capture specs already use, local `Date`
 *  methods throughout so this lines up with `weekWindowNodes`'s own local-day math
 *  regardless of which timezone runs the suite. */
function isoAt(daysFromNow: number, hours = 9): string {
  const date = new Date(FIXED_NOW);
  date.setDate(date.getDate() + daysFromNow);
  date.setHours(hours, 0, 0, 0);
  return date.toISOString();
}

test('AK1: der Wochenausschnitt ist beim Öffnen der Standard — überfällig, heute und die 6 folgenden Tage, kein gemerkter Zustand', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');

  await expect(viewOption(page, '7 Tage')).toHaveAttribute('aria-checked', 'true');

  await seedTask(page, { title: 'Überfällig', dueAt: isoAt(-8) });
  await seedTask(page, { title: 'Heute fällig', dueAt: isoAt(0, 18) });
  await seedTask(page, { title: 'In 2 Tagen', dueAt: isoAt(2) });
  await seedTask(page, { title: 'In 8 Tagen — außerhalb', dueAt: isoAt(8) });
  await seedTask(page, { title: 'Ohne Datum' });

  const items = taskItems(page);
  await expect(items).toHaveCount(3);
  await expect(items.filter({ hasText: 'Überfällig' })).toBeVisible();
  await expect(items.filter({ hasText: 'Heute fällig' })).toBeVisible();
  await expect(items.filter({ hasText: 'In 2 Tagen' })).toBeVisible();
  await expect(items.filter({ hasText: 'In 8 Tagen' })).toHaveCount(0);
  await expect(items.filter({ hasText: 'Ohne Datum' })).toHaveCount(0);
});
