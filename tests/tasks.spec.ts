import { expect, test, type Locator, type Page } from '@playwright/test';
import { registerPasskey, resetDatabase, withDb } from './helpers';

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

/** Mirrors task-editor.tsx's own conversion, so the assertion does not depend on
 * which timezone happens to run the test. */
function isoToLocalInput(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
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

function checkboxFor(page: Page, title: string) {
  return page.getByRole('checkbox', { name: `${title} als erledigt markieren` });
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
  await resetDatabase();
  // The list must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8) —
  // with the sync endpoints cut, that is the only way any of these tests can pass.
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await registerPasskey(page);
});

test('a designed empty state, not a blank screen', async ({ page }) => {
  await page.goto('/aufgaben');
  await expect(page.getByText('Keine Aufgaben. Genieß die Ruhe.')).toBeVisible();
});

test('a task created locally appears without any network request', async ({ page }) => {
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Milch kaufen' });

  await expect(page.getByText('Milch kaufen')).toBeVisible();
});

test('a soft-deleted task is not shown', async ({ page }) => {
  await page.goto('/aufgaben');
  const id = await seedTask(page, { title: 'Verschwindet' });
  await expect(page.getByText('Verschwindet')).toBeVisible();

  await page.evaluate(
    (rowId) => window.__starship.mutate({ table: 'tasks', rowId, op: 'delete' }),
    id,
  );

  await expect(page.getByText('Verschwindet')).toHaveCount(0);
});

test('completed tasks sit below open ones and look visually done', async ({ page }) => {
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Offen' });
  await seedTask(page, { title: 'Erledigt', completedAt: new Date().toISOString() });

  const items = taskItems(page);
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveText(/Offen/);
  await expect(items.nth(1)).toHaveText(/Erledigt/);
  // Visually receded, not just reordered.
  await expect(items.nth(1)).toHaveClass(/task-list__item--done/);
});

test('tasks are sorted by due date, undated ones last', async ({ page }) => {
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Ohne Termin' });
  await seedTask(page, { title: 'Übermorgen', dueAt: '2026-07-16T09:00:00.000Z' });
  await seedTask(page, { title: 'Morgen', dueAt: '2026-07-15T09:00:00.000Z' });

  const items = taskItems(page);
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveText(/Morgen/);
  await expect(items.nth(1)).toHaveText(/Übermorgen/);
  await expect(items.nth(2)).toHaveText(/Ohne Termin/);
});

test('tasks stay visible offline, with a calm notice instead of an error', async ({
  page,
  context,
}) => {
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Bleibt da' });
  await expect(page.getByText('Bleibt da')).toBeVisible();

  await context.setOffline(true);

  // A calm status note, not a red alert — nothing here uses role="alert".
  await expect(page.getByRole('status')).toContainText('Offline');
  await expect(page.getByText('Bleibt da')).toBeVisible();

  await context.setOffline(false);
});

test('der FAB öffnet ein Sheet mit fokussiertem Titelfeld', async ({ page }) => {
  await page.goto('/aufgaben');
  await openQuickAdd(page);

  await expect(page.getByRole('dialog', { name: QUICK_ADD_LABEL })).toBeVisible();
  await expect(quickAddTitleField(page)).toBeFocused();
});

test('n öffnet auf Desktop dasselbe Sheet wie der FAB', async ({ page }) => {
  await page.goto('/aufgaben');
  await page.keyboard.press('n');

  await expect(page.getByRole('dialog', { name: QUICK_ADD_LABEL })).toBeVisible();
  await expect(quickAddTitleField(page)).toBeFocused();
});

test('eine gespeicherte Aufgabe erscheint sofort in der Liste, ohne Spinner', async ({ page }) => {
  await page.goto('/aufgaben');
  await openQuickAdd(page);
  await quickAddTitleField(page).fill('Wäsche aufhängen');
  await page.getByRole('button', { name: 'Hinzufügen' }).click();

  await expect(page.getByText('Wäsche aufhängen')).toBeVisible();
  await expect(page.getByRole('dialog', { name: QUICK_ADD_LABEL })).toBeHidden();
});

test('ein leerer Titel wird nicht gespeichert, der Fokus bleibt im Feld', async ({ page }) => {
  await page.goto('/aufgaben');
  await openQuickAdd(page);
  await page.getByRole('button', { name: 'Hinzufügen' }).click();

  await expect(page.getByRole('dialog', { name: QUICK_ADD_LABEL })).toBeVisible();
  await expect(quickAddTitleField(page)).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
});

test('offline gespeichert: sofort sichtbar, genau ein Eintrag in der Outbox', async ({
  page,
  context,
}) => {
  await page.goto('/aufgaben');
  await context.setOffline(true);

  await openQuickAdd(page);
  await quickAddTitleField(page).fill('Im Zug notiert');
  await page.getByRole('button', { name: 'Hinzufügen' }).click();

  await expect(page.getByText('Im Zug notiert')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  await context.setOffline(false);
});

test('nach dem Onlinegehen erreicht die Aufgabe die echte Datenbank', async ({ page, context }) => {
  await page.goto('/aufgaben');
  await context.setOffline(true);

  await openQuickAdd(page);
  await quickAddTitleField(page).fill('Zug-Notiz für den Server');
  await page.getByRole('button', { name: 'Hinzufügen' }).click();
  await expect(page.getByText('Zug-Notiz für den Server')).toBeVisible();

  await context.setOffline(false);
  // beforeEach cuts the sync endpoints so the list can only ever come from
  // IndexedDB — lift that here to let the queued mutation actually reach Postgres.
  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT title FROM tasks WHERE title = $1', ['Zug-Notiz für den Server']),
  );
  expect(row.rowCount).toBe(1);
});

test('bei reduzierter Bewegung öffnet das Sheet nur mit einem Opacity-Übergang', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/aufgaben');
  await openQuickAdd(page);

  const dialog = page.getByRole('dialog', { name: QUICK_ADD_LABEL });
  const transitionProperty = await dialog.evaluate(
    (el) => getComputedStyle(el.firstElementChild as Element).transitionProperty,
  );
  expect(transitionProperty).toBe('opacity');
});

test('Wisch nach rechts erledigt die Aufgabe und zeigt einen Undo-Toast', async ({ page }) => {
  await page.goto('/aufgaben');
  const title = 'Wird gewischt';
  await seedTask(page, { title });
  const item = taskItems(page).filter({ hasText: title });

  await swipeRight(item, 120);

  await expect(item).toHaveClass(/task-list__item--done/);
  await expect(checkboxFor(page, title)).toBeChecked();
  await expect(page.getByRole('status').filter({ hasText: 'erledigt' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeVisible();
});

test('ein zu kurzer Wisch lässt die Aufgabe offen', async ({ page }) => {
  await page.goto('/aufgaben');
  const title = 'Nur angetippt';
  await seedTask(page, { title });
  const item = taskItems(page).filter({ hasText: title });

  await swipeRight(item, 20); // below the 80px threshold

  await expect(item).not.toHaveClass(/task-list__item--done/);
  await expect(checkboxFor(page, title)).not.toBeChecked();
});

test('der Undo-Toast macht die Erledigung rückgängig, der Server landet am offenen Zustand', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  const title = 'Undo-Testfall';
  await seedTask(page, { title });
  const item = taskItems(page).filter({ hasText: title });

  await swipeRight(item, 120);
  await expect(item).toHaveClass(/task-list__item--done/);

  await page.getByRole('button', { name: 'Rückgängig' }).click();

  await expect(item).not.toHaveClass(/task-list__item--done/);
  await expect(checkboxFor(page, title)).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeHidden();

  // The complete-then-undo pair must reach the server as a coherent sequence, not
  // leave the row stuck "completed" from a half-applied undo.
  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT completed_at FROM tasks WHERE title = $1', [title]),
  );
  expect(row.rows[0].completed_at).toBeNull();
});

test('offline erledigt greift sofort in der UI, liegt in der Outbox und erreicht online die Datenbank', async ({
  page,
  context,
}) => {
  await page.goto('/aufgaben');
  const title = 'Offline erledigen';
  await seedTask(page, { title });
  await context.setOffline(true);

  const item = taskItems(page).filter({ hasText: title });
  await swipeRight(item, 120);

  await expect(item).toHaveClass(/task-list__item--done/);
  // One entry for the seed, one for the completion — both still queued offline.
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(2);

  await context.setOffline(false);
  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  const row = await withDb((client) =>
    client.query('SELECT completed_at FROM tasks WHERE title = $1', [title]),
  );
  expect(row.rows[0].completed_at).not.toBeNull();
});

test('erneutes Wischen nach rechts macht eine erledigte Aufgabe wieder offen', async ({ page }) => {
  await page.goto('/aufgaben');
  const title = 'Toggle-Testfall';
  await seedTask(page, { title, completedAt: new Date().toISOString() });
  const item = taskItems(page).filter({ hasText: title });
  await expect(item).toHaveClass(/task-list__item--done/);

  await swipeRight(item, 120);

  await expect(item).not.toHaveClass(/task-list__item--done/);
  // Toggling back open is the corrective action itself — no undo offer for it.
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeHidden();
});

test('ein Klick auf die Checkbox erledigt die Aufgabe genauso wie der Swipe', async ({ page }) => {
  await page.goto('/aufgaben');
  const title = 'Checkbox-Testfall';
  await seedTask(page, { title });

  await checkboxFor(page, title).click();

  await expect(taskItems(page).filter({ hasText: title })).toHaveClass(/task-list__item--done/);
});

test('auf Desktop lässt sich eine Aufgabe per Tastatur erledigen', async ({ page }) => {
  await page.goto('/aufgaben');
  const title = 'Tastatur-Testfall';
  await seedTask(page, { title });

  const checkbox = checkboxFor(page, title);
  await checkbox.focus();
  await page.keyboard.press('Space');

  await expect(checkbox).toBeChecked();
});

test('das Checkbox-Touch-Ziel ist mindestens 44 × 44 px groß', async ({ page }) => {
  await page.goto('/aufgaben');
  const title = 'Zielgröße';
  await seedTask(page, { title });

  // The visible checkbox is smaller — the touch target is its wrapping element.
  const wrap = checkboxFor(page, title).locator('xpath=..');
  const box = await wrap.boundingBox();

  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
});

test('bei reduzierter Bewegung hat der Swipe-Rückstoß keine Sprung-Animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Ruhig bitte' });

  const item = taskItems(page).filter({ hasText: 'Ruhig bitte' });
  const transitionDuration = await item.evaluate((el) => getComputedStyle(el).transitionDuration);
  // Chromium serializes very small numbers in exponential notation (e.g. "1e-05s"),
  // so compare the parsed value rather than the exact string.
  expect(parseFloat(transitionDuration)).toBeLessThan(0.001);
});

test('Tippen auf eine Aufgabe öffnet den Editor mit Titel, Notiz, Fälligkeit und Priorität', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  const dueAt = '2026-07-20T09:00:00.000Z';
  await seedTask(page, { title: 'Bearbeiten', notes: 'Eine Notiz', dueAt, priority: 1 });

  await tapTask(page, 'Bearbeiten');

  const dialog = editorDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Titel' })).toHaveValue('Bearbeiten');
  await expect(dialog.getByRole('textbox', { name: 'Notiz' })).toHaveValue('Eine Notiz');
  await expect(dialog.getByLabel('Fälligkeit')).toHaveValue(isoToLocalInput(dueAt));
  await expect(dialog.getByRole('radio', { name: 'Hoch' })).toBeChecked();
});

test('nur die geänderte Priorität landet in der Mutation, nicht der ganze Datensatz', async ({
  page,
}) => {
  await page.goto('/aufgaben');
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

test('eine gesetzte Fälligkeit sortiert die Liste korrekt und zeigt die Uhrzeit im 24h-Format', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Ohne Termin' });
  await seedTask(page, { title: 'Früh dran' });

  await tapTask(page, 'Früh dran');
  const dialog = editorDialog(page);
  await dialog.getByLabel('Fälligkeit').fill('2026-07-16T14:30');
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  await expect(dialog).toBeHidden();

  const items = taskItems(page);
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('Früh dran');
  // A 12-hour clock would read "02:30 PM" — this proves it is not that.
  await expect(items.nth(0)).toContainText('14:30');
  await expect(items.nth(1)).toContainText('Ohne Termin');
});

test('ein zu kurzer Linksswipe zeigt weder eine Löschbestätigung noch öffnet er den Editor', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  const title = 'Nur angetippt links';
  await seedTask(page, { title });
  const item = taskItems(page).filter({ hasText: title });

  await swipeLeft(item, 20); // below the 80px threshold

  await expect(page.getByRole('button', { name: 'Löschen' })).toHaveCount(0);
  await expect(editorDialog(page)).toBeHidden();
});

test('Wisch nach links, dann „Löschen" setzt einen Tombstone und zeigt einen Undo-Toast', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  const title = 'Wird gelöscht';
  const id = await seedTask(page, { title });
  const item = taskItems(page).filter({ hasText: title });

  await swipeLeft(item, 120);
  const confirmButton = page.getByRole('button', { name: 'Löschen' });
  await expect(confirmButton).toBeVisible();
  await confirmButton.click();

  await expect(page.getByText(title)).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'gelöscht' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeVisible();

  // A tombstone, never a hard DELETE (CLAUDE.md rule 8 / ADR-0001 §3) — proven by
  // the op the outbox actually queued for this row.
  const entries = await page.evaluate(() => window.__starship.pending());
  const last = entries[entries.length - 1];
  expect(last.op).toBe('delete');
  expect(last.rowId).toBe(id);
});

test('der Undo-Toast beim Löschen stellt die Aufgabe wieder her, der Server landet ohne Tombstone', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  const title = 'Löschen rückgängig';
  await seedTask(page, { title });
  const item = taskItems(page).filter({ hasText: title });

  await swipeLeft(item, 120);
  await page.getByRole('button', { name: 'Löschen' }).click();
  await expect(page.getByText(title)).toHaveCount(0);

  await page.getByRole('button', { name: 'Rückgängig' }).click();

  await expect(page.getByText(title)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeHidden();

  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT deleted_at FROM tasks WHERE title = $1', [title]),
  );
  expect(row.rows[0].deleted_at).toBeNull();
});

test('offline gelöscht erreicht nach dem Onlinegehen den Server als Tombstone, die Zeile bleibt bestehen', async ({
  page,
  context,
}) => {
  await page.goto('/aufgaben');
  const title = 'Offline löschen';
  await seedTask(page, { title });
  await context.setOffline(true);

  const item = taskItems(page).filter({ hasText: title });
  await swipeLeft(item, 120);
  await page.getByRole('button', { name: 'Löschen' }).click();

  await expect(page.getByText(title)).toHaveCount(0);
  // One entry for the seed, one for the delete — both still queued offline.
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(2);

  await context.setOffline(false);
  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT deleted_at FROM tasks WHERE title = $1', [title]),
  );
  expect(row.rowCount).toBe(1); // tombstoned, not hard-deleted — the row still exists
  expect(row.rows[0].deleted_at).not.toBeNull();
});
