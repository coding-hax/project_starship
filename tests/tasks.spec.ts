import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  FIXED_NOW,
  freezeClock,
  registerPasskey,
  resetAppData,
  selectView,
  skewClock,
  withDb,
} from './helpers';

/** Mirrors task-item.tsx's own LONG_PRESS_MS — how long a hold picks a row up
 * for drag-to-nest instead of starting a swipe. */
const LONG_PRESS_MS = 400;

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
  await resetAppData();
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
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Milch kaufen' });

  await expect(page.getByText('Milch kaufen')).toBeVisible();
});

test('a soft-deleted task is not shown', async ({ page }) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const id = await seedTask(page, { title: 'Verschwindet' });
  await expect(page.getByText('Verschwindet')).toBeVisible();

  await page.evaluate(
    (rowId) => window.__starship.mutate({ table: 'tasks', rowId, op: 'delete' }),
    id,
  );

  await expect(page.getByText('Verschwindet')).toHaveCount(0);
});

test('Erledigen lässt die Aufgabe an ihrer Position — sie sieht erledigt aus, springt aber nicht ans Ende (issue #88 AC2)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Zuerst angelegt', createdAt: '2026-07-01T00:00:00.000Z' });
  await seedTask(page, { title: 'Danach angelegt', createdAt: '2026-07-02T00:00:00.000Z' });

  await checkboxFor(page, 'Zuerst angelegt').click();

  const items = taskItems(page);
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveText(/Zuerst angelegt/);
  // Visually receded, not moved.
  await expect(items.nth(0)).toHaveClass(/task-list__item--done/);
  await expect(items.nth(1)).toHaveText(/Danach angelegt/);
});

test('Aufgaben werden strikt nach Erstellzeit sortiert — Fälligkeit und Status spielen keine Rolle (issue #88 AC3)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, {
    title: 'Zuerst angelegt',
    dueAt: '2026-07-20T09:00:00.000Z',
    createdAt: '2026-07-10T08:00:00.000Z',
  });
  await seedTask(page, {
    title: 'Danach angelegt, aber früher fällig',
    dueAt: '2026-07-15T09:00:00.000Z',
    createdAt: '2026-07-10T09:00:00.000Z',
    completedAt: '2026-07-11T00:00:00.000Z',
  });
  await seedTask(page, {
    title: 'Zuletzt angelegt, ohne Termin',
    createdAt: '2026-07-10T10:00:00.000Z',
  });

  const items = taskItems(page);
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveText(/Zuerst angelegt/);
  await expect(items.nth(1)).toHaveText(/Danach angelegt, aber früher fällig/);
  await expect(items.nth(2)).toHaveText(/Zuletzt angelegt, ohne Termin/);
});

test('tasks stay visible offline, with a calm notice instead of an error (issue #643 AC4)', async ({
  page,
  context,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Bleibt da' });
  await expect(page.getByText('Bleibt da')).toBeVisible();

  await context.setOffline(true);

  // A calm status note, not a red alert — nothing here uses role="alert".
  await expect(page.getByRole('status')).toContainText('Offline');
  await expect(page.getByText('Bleibt da')).toBeVisible();

  await context.setOffline(false);
});

test('die Offline-Notiz verschwindet nach dem Onlinegehen wieder, ohne Neuladen (issue #643 AC5)', async ({
  page,
  context,
}) => {
  await page.goto('/aufgaben');
  await context.setOffline(true);
  await expect(page.getByRole('status')).toContainText('Offline');

  await context.setOffline(false);

  await expect(page.getByRole('status')).toHaveCount(0);
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
  await selectView(page, 'Alle');
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
  await selectView(page, 'Alle');
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
  await selectView(page, 'Alle');
  await context.setOffline(true);

  await openQuickAdd(page);
  await quickAddTitleField(page).fill('Zug-Notiz für den Server');
  await page.getByRole('button', { name: 'Hinzufügen' }).click();
  await expect(page.getByText('Zug-Notiz für den Server')).toBeVisible();

  // beforeEach cuts the sync endpoints so the list can only ever come from
  // IndexedDB — lift that here to let the queued mutation actually reach Postgres.
  await page.unroute('**/api/sync/**');
  await context.setOffline(false);
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

test('Fokus kehrt nach dem Schließen per Aktion zum FAB zurück (issue #429)', async ({ page }) => {
  await page.goto('/aufgaben');
  await openQuickAdd(page);
  // No date in the title — a parsed due date would pop the capture-confirm sheet
  // instead of returning focus straight to the FAB.
  await quickAddTitleField(page).fill('Ohne Datum');
  await page.getByRole('button', { name: 'Hinzufügen' }).click();

  await expect(page.getByRole('dialog', { name: QUICK_ADD_LABEL })).toBeHidden();
  await expect(page.getByRole('button', { name: QUICK_ADD_LABEL })).toBeFocused();
});

test('Fokus kehrt nach ESC zum FAB zurück (issue #429)', async ({ page }) => {
  await page.goto('/aufgaben');
  await openQuickAdd(page);
  await page.keyboard.press('Escape');

  await expect(page.getByRole('dialog', { name: QUICK_ADD_LABEL })).toBeHidden();
  await expect(page.getByRole('button', { name: QUICK_ADD_LABEL })).toBeFocused();
});

test('Fokus kehrt nach einem Klick auf den Backdrop zum FAB zurück (issue #429)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await openQuickAdd(page);

  const dialog = page.getByRole('dialog', { name: QUICK_ADD_LABEL });
  // The content sits bottom-centered — a click near the top-left corner lands on
  // the dialog itself, i.e. the backdrop, not on .sheet__content.
  await dialog.click({ position: { x: 5, y: 5 } });

  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: QUICK_ADD_LABEL })).toBeFocused();
});

test('bei reduzierter Bewegung schließt das Sheet nur mit einem Opacity-Übergang (issue #429)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/aufgaben');
  await openQuickAdd(page);

  const dialog = page.getByRole('dialog', { name: QUICK_ADD_LABEL });
  // Resolve the handle while the dialog is still open — once Escape closes it,
  // the element loses its `dialog` role and the role locator would hang until
  // the 30s timeout (issue #450).
  const handle = await dialog.elementHandle();
  await page.keyboard.press('Escape');

  const transitionProperty = await handle!.evaluate(
    (el) => getComputedStyle((el as Element).firstElementChild as Element).transitionProperty,
  );
  expect(transitionProperty).toBe('opacity');
});

test('kein Layout-Shift beim Schließen des Sheets (issue #429)', async ({ page }) => {
  await page.goto('/aufgaben');
  // Not the FAB itself: opening moves the pointer onto it, and once the dialog
  // stops covering it, its own `:hover` affordance (fab.css) scales it up — a
  // real but unrelated effect that would masquerade as a layout shift here.
  const heading = page.getByRole('heading', { level: 1 });
  const boxBefore = await heading.boundingBox();
  const scrollWidthBefore = await page.evaluate(() => document.documentElement.scrollWidth);

  await openQuickAdd(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: QUICK_ADD_LABEL })).toBeHidden();

  const boxAfter = await heading.boundingBox();
  const scrollWidthAfter = await page.evaluate(() => document.documentElement.scrollWidth);

  expect(boxAfter).toEqual(boxBefore);
  expect(scrollWidthAfter).toBe(scrollWidthBefore);
});

test('Wisch nach rechts erledigt die Aufgabe und zeigt einen Undo-Toast', async ({ page }) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
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
  await selectView(page, 'Alle');
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
  await selectView(page, 'Alle');
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
  await selectView(page, 'Alle');
  const title = 'Offline erledigen';
  await seedTask(page, { title });
  await context.setOffline(true);

  const item = taskItems(page).filter({ hasText: title });
  await swipeRight(item, 120);

  await expect(item).toHaveClass(/task-list__item--done/);
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
  await selectView(page, 'Alle');
  const title = 'Toggle-Testfall';
  await seedTask(page, { title, completedAt: new Date(FIXED_NOW).toISOString() });
  const item = taskItems(page).filter({ hasText: title });
  await expect(item).toHaveClass(/task-list__item--done/);

  await swipeRight(item, 120);

  await expect(item).not.toHaveClass(/task-list__item--done/);
  // Toggling back open is the corrective action itself — no undo offer for it.
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeHidden();
});

test('ein Klick auf die Checkbox erledigt die Aufgabe genauso wie der Swipe', async ({ page }) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const title = 'Checkbox-Testfall';
  await seedTask(page, { title });

  await checkboxFor(page, title).click();

  await expect(taskItems(page).filter({ hasText: title })).toHaveClass(/task-list__item--done/);
});

test('auf Desktop lässt sich eine Aufgabe per Tastatur erledigen', async ({ page }) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const title = 'Tastatur-Testfall';
  await seedTask(page, { title });

  const checkbox = checkboxFor(page, title);
  await checkbox.focus();
  await page.keyboard.press('Space');

  await expect(checkbox).toBeChecked();
});

test('das Checkbox-Touch-Ziel ist mindestens 44 × 44 px groß', async ({ page }) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const title = 'Zielgröße';
  await seedTask(page, { title });

  // The visible checkbox is smaller — the touch target is its wrapping element.
  const wrap = checkboxFor(page, title).locator('xpath=..');
  const box = await wrap.boundingBox();

  // Rounded, not compared exactly: Chromium's grid layout can report a
  // sub-pixel-short boundingBox (e.g. 43.999969...) for a 44px min-height box
  // (same float-serialization class as habits-week-grid.spec.ts:556-561) —
  // the CSS token is an exact 44px, this only guards against that.
  expect(Math.round(box?.width ?? 0)).toBeGreaterThanOrEqual(44);
  expect(Math.round(box?.height ?? 0)).toBeGreaterThanOrEqual(44);
});

test('bei reduzierter Bewegung hat der Swipe-Rückstoß keine Sprung-Animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
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

test('Tippen auf die Priorität lässt Fokus im Titelfeld, Weitertippen hängt an statt zu ersetzen (#138)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Bericht', priority: 0 });
  await tapTask(page, 'Bericht');

  const dialog = editorDialog(page);
  const titleField = dialog.getByRole('textbox', { name: 'Titel' });
  await expect(titleField).toBeFocused();
  await titleField.press('End');

  await dialog.getByRole('radio', { name: 'Hoch' }).click();

  await expect(titleField).toBeFocused();
  await expect(dialog.getByRole('radio', { name: 'Hoch' })).toBeChecked();

  await page.keyboard.type(' schreiben');
  await expect(titleField).toHaveValue('Bericht schreiben');

  await dialog.getByRole('button', { name: 'Speichern' }).click();
  await expect(dialog).toBeHidden();

  const entries = await page.evaluate(() => window.__starship.pending());
  const last = entries[entries.length - 1];
  expect(last.payload).toEqual({ title: 'Bericht schreiben', priority: 1 });
});

test('eine gesetzte Fälligkeit zeigt die Uhrzeit im 24h-Format, ändert aber nicht die Position (issue #88 AC3)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Ohne Termin', createdAt: '2026-07-01T00:00:00.000Z' });
  await seedTask(page, { title: 'Früh dran', createdAt: '2026-07-02T00:00:00.000Z' });

  await tapTask(page, 'Früh dran');
  const dialog = editorDialog(page);
  await dialog.getByLabel('Fälligkeit').fill('2026-07-16T14:30');
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  await expect(dialog).toBeHidden();

  const items = taskItems(page);
  await expect(items).toHaveCount(2);
  // Creation order, unchanged by the new due date.
  await expect(items.nth(0)).toContainText('Ohne Termin');
  await expect(items.nth(1)).toContainText('Früh dran');
  // A 12-hour clock would read "02:30 PM" — this proves it is not that.
  await expect(items.nth(1)).toContainText('14:30');
});

test('ein zu kurzer Linksswipe löscht nicht und öffnet nicht den Editor', async ({ page }) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const title = 'Nur angetippt links';
  await seedTask(page, { title });
  const item = taskItems(page).filter({ hasText: title });

  await swipeLeft(item, 20); // below the 80px threshold

  await expect(item).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeHidden();
  await expect(editorDialog(page)).toBeHidden();
});

test('Wisch nach links löscht sofort und zeigt einen Undo-Toast', async ({ page }) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const title = 'Wird gelöscht';
  const id = await seedTask(page, { title });
  const item = taskItems(page).filter({ hasText: title });

  await swipeLeft(item, 120);

  // Scoped to the list, not `page.getByText` — the undo toast's own message
  // ("„<title>" gelöscht") embeds the title too, so a page-wide text query would
  // still match after the row is gone.
  await expect(taskItems(page).filter({ hasText: title })).toHaveCount(0);
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
  await selectView(page, 'Alle');
  const title = 'Löschen rückgängig';
  await seedTask(page, { title });
  const item = taskItems(page).filter({ hasText: title });

  await swipeLeft(item, 120);
  // Scoped to the list — the undo toast's own message embeds the title too.
  await expect(taskItems(page).filter({ hasText: title })).toHaveCount(0);

  await page.getByRole('button', { name: 'Rückgängig' }).click();

  await expect(taskItems(page).filter({ hasText: title })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeHidden();

  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT deleted_at FROM tasks WHERE title = $1', [title]),
  );
  expect(row.rows[0].deleted_at).toBeNull();
});

function taskRowFor(page: Page, title: string) {
  return taskItems(page).filter({ hasText: title });
}

function dueLabelFor(page: Page, title: string) {
  return taskItems(page).filter({ hasText: title }).locator('.task-list__due');
}

/** Resolves a token the same way the browser would for any element on the page —
 * used so colour assertions never hardcode an OKLCH literal that could drift. */
async function resolveColorToken(page: Page, token: string): Promise<string> {
  return page.evaluate((cssVar) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${cssVar})`;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

/** Same idea as `resolveColorToken`, for a `background` expression instead of a
 * single colour var — used to prove the toggle's active state resolves to the
 * exact same `color-mix(...)` surface the app already uses elsewhere. */
async function resolveBackground(page: Page, css: string): Promise<string> {
  return page.evaluate((value) => {
    const probe = document.createElement('span');
    probe.style.background = value;
    document.body.appendChild(probe);
    const background = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return background;
  }, css);
}

/** Same idea as `resolveColorToken`, for a `font-size` token instead of a colour —
 * used so the done-state shrink assertion never hardcodes the 14px literal. */
async function resolveFontSizeToken(page: Page, token: string): Promise<string> {
  return page.evaluate((cssVar) => {
    const probe = document.createElement('span');
    probe.style.fontSize = `var(${cssVar})`;
    document.body.appendChild(probe);
    const fontSize = getComputedStyle(probe).fontSize;
    probe.remove();
    return fontSize;
  }, token);
}

test('Farbkante: überfällig schlägt Priorität, Priorität schlägt nichts, Normal bleibt transparent; Priorität bleibt über title zugänglich (issue #704 AK5, migriert von #86 AC1)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Normale Aufgabe', priority: 0 });
  await seedTask(page, { title: 'Hohe Priorität', priority: 1 });
  await seedTask(page, { title: 'Dringende Aufgabe', priority: 2 });
  await seedTask(page, {
    title: 'Überfällig und dringend',
    priority: 2,
    dueAt: '2020-01-01T09:00:00.000Z',
  });

  const normalRow = taskRowFor(page, 'Normale Aufgabe');
  await expect(normalRow).not.toHaveAttribute('data-edge');
  const normalEdgeColor = await normalRow.evaluate(
    (el) => getComputedStyle(el).borderInlineStartColor,
  );
  expect(normalEdgeColor).toBe('rgba(0, 0, 0, 0)');
  await expect(normalRow.locator('.task-list__title')).not.toHaveAttribute('title');

  const hochRow = taskRowFor(page, 'Hohe Priorität');
  await expect(hochRow).toHaveAttribute('data-edge', 'priority');
  const hochColor = await hochRow.evaluate((el) => getComputedStyle(el).borderInlineStartColor);
  expect(hochColor).toBe(await resolveColorToken(page, '--warning'));
  await expect(hochRow.locator('.task-list__title')).toHaveAttribute('title', 'Priorität: Hoch');

  // Dringend without an overdue due date still reads as --warning, not --danger —
  // the edge signals priority, not urgency; only an overdue row earns danger
  // (the one intentional colour-semantics change AK5 makes over the old dot).
  const dringendRow = taskRowFor(page, 'Dringende Aufgabe');
  await expect(dringendRow).toHaveAttribute('data-edge', 'priority');
  const dringendColor = await dringendRow.evaluate(
    (el) => getComputedStyle(el).borderInlineStartColor,
  );
  expect(dringendColor).toBe(await resolveColorToken(page, '--warning'));
  await expect(dringendRow.locator('.task-list__title')).toHaveAttribute(
    'title',
    'Priorität: Dringend',
  );

  const overdueUrgentRow = taskRowFor(page, 'Überfällig und dringend');
  await expect(overdueUrgentRow).toHaveAttribute('data-edge', 'overdue');
  const overdueUrgentColor = await overdueUrgentRow.evaluate(
    (el) => getComputedStyle(el).borderInlineStartColor,
  );
  expect(overdueUrgentColor).toBe(await resolveColorToken(page, '--danger'));
});

test('eine offene, vergangene Fälligkeit wird hervorgehoben; eine künftige oder erledigte nicht (issue #86 AC2)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Überfällig', dueAt: '2020-01-01T09:00:00.000Z' });
  await seedTask(page, { title: 'Noch Zeit', dueAt: '2099-01-01T09:00:00.000Z' });
  await seedTask(page, {
    title: 'Erledigt trotz alter Fälligkeit',
    dueAt: '2020-01-01T09:00:00.000Z',
    completedAt: new Date(FIXED_NOW).toISOString(),
  });

  await expect(dueLabelFor(page, 'Überfällig')).toHaveClass(/task-list__due--overdue/);
  await expect(dueLabelFor(page, 'Noch Zeit')).not.toHaveClass(/task-list__due--overdue/);
  await expect(dueLabelFor(page, 'Erledigt trotz alter Fälligkeit')).not.toHaveClass(
    /task-list__due--overdue/,
  );

  const overdueColor = await dueLabelFor(page, 'Überfällig').evaluate(
    (el) => getComputedStyle(el).color,
  );
  expect(overdueColor).toBe(await resolveColorToken(page, '--danger'));
  const numericFormat = await dueLabelFor(page, 'Überfällig').evaluate(
    (el) => getComputedStyle(el).fontVariantNumeric,
  );
  expect(numericFormat).toContain('tabular-nums');
});

test('Farbkante und Überfällig-Hervorhebung bleiben im Dark Mode korrekt und fügen keine Bewegung hinzu (issue #704 AK5, migriert von #86 AC3)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await seedTask(page, {
    title: 'Dringend im Dunkeln',
    priority: 2,
    dueAt: '2020-01-01T09:00:00.000Z',
  });

  const row = taskRowFor(page, 'Dringend im Dunkeln');
  const due = dueLabelFor(page, 'Dringend im Dunkeln');

  // The row's own transition stays scoped to `transform` (the swipe gesture) —
  // border-inline-start-color is never part of it, so the edge itself never
  // animates, in light or dark mode.
  await expect
    .poll(() => row.evaluate((el) => getComputedStyle(el).transitionProperty))
    .toBe('transform');
  await expect
    .poll(() => due.evaluate((el) => getComputedStyle(el).transitionProperty))
    .toBe('none');

  const lightEdgeColor = await row.evaluate((el) => getComputedStyle(el).borderInlineStartColor);
  const lightDueColor = await due.evaluate((el) => getComputedStyle(el).color);

  await page.emulateMedia({ colorScheme: 'dark' });

  const darkEdgeColor = await row.evaluate((el) => getComputedStyle(el).borderInlineStartColor);
  const darkDueColor = await due.evaluate((el) => getComputedStyle(el).color);

  // Still resolve to the semantic token, just its dark-mode value — proving the
  // override in tokens.css actually reaches these elements, not a hardcoded colour.
  // The seeded row is overdue *and* priority 2 — precedence picks --danger, same
  // as light mode.
  expect(darkEdgeColor).toBe(await resolveColorToken(page, '--danger'));
  expect(darkDueColor).toBe(await resolveColorToken(page, '--danger'));
  expect(darkEdgeColor).not.toBe(lightEdgeColor);
  expect(darkDueColor).not.toBe(lightDueColor);
});

test('keine Kartenfläche mehr — Zeile auf --bg, Trennung nur über 1px Haarlinie (issue #704 AK4)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Erste Zeile' });
  await seedTask(page, { title: 'Zweite Zeile' });

  const firstRow = taskRowFor(page, 'Erste Zeile');
  const style = await firstRow.evaluate((el) => {
    const computed = getComputedStyle(el);
    return {
      boxShadow: computed.boxShadow,
      borderRadius: computed.borderRadius,
      backgroundColor: computed.backgroundColor,
      borderBlockEndWidth: computed.borderBlockEndWidth,
    };
  });
  expect(style.boxShadow).toBe('none');
  expect(style.borderRadius).toBe('0px');
  expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)');
  expect(style.borderBlockEndWidth).toBe('1px');

  const borderBlockEndColor = await firstRow.evaluate(
    (el) => getComputedStyle(el).borderBlockEndColor,
  );
  expect(borderBlockEndColor).toBe(await resolveColorToken(page, '--border-faint'));
});

test('Erledigtes schrumpft an Ort und Stelle statt zu springen (issue #704 AK7)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const title = 'Wird geschrumpft';
  await seedTask(page, { title });

  const row = taskRowFor(page, title);
  await expect
    .poll(() => row.evaluate((el) => el.getAnimations().some((a) => a.playState === 'running')))
    .toBe(false);
  const heightBefore = (await row.boundingBox())?.height;

  await checkboxFor(page, title).click();

  await expect(row).toHaveClass(/task-list__item--done/);
  const titleSpan = row.locator('.task-list__title');
  const doneFontSize = await titleSpan.evaluate((el) => getComputedStyle(el).fontSize);
  expect(doneFontSize).toBe(await resolveFontSizeToken(page, '--text-secondary'));
  const doneTextDecoration = await titleSpan.evaluate(
    (el) => getComputedStyle(el).textDecorationLine,
  );
  expect(doneTextDecoration).toContain('line-through');
  const doneOpacity = await row.evaluate((el) => getComputedStyle(el).opacity);
  expect(doneOpacity).toBe('0.6');

  // The row's own height never moves — only the title's font size shrinks
  // (issue #228, #435: a checked-off row must not shift its neighbours).
  const heightAfter = (await row.boundingBox())?.height;
  expect(heightAfter).toBe(heightBefore);
});

test('unter reduzierter Bewegung fügen Kante, Haarlinie und Schrumpfen nichts Animiertes hinzu (issue #704 AK10)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/aufgaben');
  // The explicit in-app toggle (use-appearance.ts) alongside the OS media
  // query — AK10 asks for both paths to hold, not just whichever the
  // browser happens to emulate.
  await page.evaluate(() => {
    document.documentElement.dataset.reduceMotion = 'true';
  });
  const title = 'Reduzierte Bewegung';
  await seedTask(page, { title, priority: 2, dueAt: '2020-01-01T09:00:00.000Z' });

  const row = taskRowFor(page, title);
  const rowTransitionDuration = await row.evaluate((el) => getComputedStyle(el).transitionDuration);
  // Chromium serializes very small numbers in exponential notation (e.g. "1e-05s"),
  // so compare the parsed value rather than the exact string.
  expect(parseFloat(rowTransitionDuration)).toBeLessThan(0.001);
  expect(await transitionDurationFor(row, 'border-inline-start-color')).toBe(0);
  const edgeColor = await row.evaluate((el) => getComputedStyle(el).borderInlineStartColor);
  expect(edgeColor).toBe(await resolveColorToken(page, '--danger'));

  await checkboxFor(page, title).click();
  await expect(row).toHaveClass(/task-list__item--done/);

  const titleSpan = row.locator('.task-list__title');
  expect(await transitionDurationFor(titleSpan, 'font-size')).toBe(0);
  const doneFontSize = await titleSpan.evaluate((el) => getComputedStyle(el).fontSize);
  expect(doneFontSize).toBe(await resolveFontSizeToken(page, '--text-secondary'));
});

test('offline gelöscht erreicht nach dem Onlinegehen den Server als Tombstone, die Zeile bleibt bestehen', async ({
  page,
  context,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const title = 'Offline löschen';
  await seedTask(page, { title });
  await context.setOffline(true);

  const item = taskItems(page).filter({ hasText: title });
  await swipeLeft(item, 120);

  // Scoped to the list — the undo toast's own message embeds the title too.
  await expect(taskItems(page).filter({ hasText: title })).toHaveCount(0);
  // One entry for the seed, one for the delete — both still queued offline.
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(2);

  await page.unroute('**/api/sync/**');
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT deleted_at FROM tasks WHERE title = $1', [title]),
  );
  expect(row.rowCount).toBe(1); // tombstoned, not hard-deleted — the row still exists
  expect(row.rows[0].deleted_at).not.toBeNull();
});

test('ein per Schnellerfassung angelegtes Todo erscheint unten in der Liste (issue #88 AC1)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Schon da', createdAt: '2026-07-01T00:00:00.000Z' });

  await openQuickAdd(page);
  await quickAddTitleField(page).fill('Frisch angelegt');
  await page.getByRole('button', { name: 'Hinzufügen' }).click();

  const items = taskItems(page);
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('Schon da');
  await expect(items.nth(1)).toContainText('Frisch angelegt');
});

test('die Position unten bleibt nach einem Reload erhalten (issue #88 AC1)', async ({ page }) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Älter', createdAt: '2026-07-01T00:00:00.000Z' });
  await seedTask(page, { title: 'Neuer', createdAt: '2026-07-05T00:00:00.000Z' });

  await page.reload();

  const items = taskItems(page);
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('Älter');
  await expect(items.nth(1)).toContainText('Neuer');
});

test('offline angelegt landet unten, bleibt dort nach dem Sync (issue #88 AC1)', async ({
  page,
  context,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Bestand', createdAt: '2026-07-01T00:00:00.000Z' });
  await context.setOffline(true);

  await openQuickAdd(page);
  await quickAddTitleField(page).fill('Offline neu');
  await page.getByRole('button', { name: 'Hinzufügen' }).click();

  const items = taskItems(page);
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('Bestand');
  await expect(items.nth(1)).toContainText('Offline neu');

  await page.unroute('**/api/sync/**');
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT created_at FROM tasks WHERE title = $1', ['Offline neu']),
  );
  expect(row.rowCount).toBe(1);

  await page.reload();
  const itemsAfterSync = taskItems(page);
  await expect(itemsAfterSync).toHaveCount(2);
  await expect(itemsAfterSync.nth(0)).toContainText('Bestand');
  await expect(itemsAfterSync.nth(1)).toContainText('Offline neu');
});

test('Scroll-Anker: bei wenig Inhalt bleibt die Liste am natürlichen Seitenanfang (issue #88 AC Scroll-Anker)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, {
    title: 'Erledigt',
    createdAt: '2026-07-01T00:00:00.000Z',
    completedAt: '2026-07-01T01:00:00.000Z',
  });
  await seedTask(page, { title: 'Offen', createdAt: '2026-07-02T00:00:00.000Z' });

  await page.reload();
  await expect(taskItems(page)).toHaveCount(2);

  // Too little content to overflow the viewport — nothing to scroll to, so the
  // page stays exactly where it loaded.
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test('Scroll-Anker: bei viel erledigter Historie steht das älteste offene Todo oben (issue #88 AC Scroll-Anker)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');

  // Enough completed history to overflow both viewports in the test matrix
  // (375×812 and 1280×800).
  for (let i = 0; i < 20; i++) {
    await seedTask(page, {
      title: `Erledigt ${i}`,
      createdAt: new Date(Date.UTC(2026, 6, 1, 0, i)).toISOString(),
      completedAt: new Date(Date.UTC(2026, 6, 1, 1, i)).toISOString(),
    });
  }
  await seedTask(page, {
    title: 'Ältestes offenes Todo',
    createdAt: new Date(Date.UTC(2026, 6, 1, 2, 0)).toISOString(),
  });
  await seedTask(page, {
    title: 'Neuestes Todo',
    createdAt: new Date(Date.UTC(2026, 6, 1, 2, 1)).toISOString(),
  });

  // The scroll anchor runs once on mount — a fresh navigation, not the live
  // updates from seeding above.
  await page.reload();
  await expect(taskItems(page)).toHaveCount(22);

  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  const anchor = taskItems(page).filter({ hasText: 'Ältestes offenes Todo' });
  await expect(anchor).toBeInViewport();
  // Scrolled well past the old history — proves this is a real jump, not a
  // one-pixel nudge that happens to satisfy toBeInViewport.
  await expect(taskItems(page).filter({ hasText: 'Erledigt 0' })).not.toBeInViewport();
});

/* -------------------------------------------------------------------------- */
/* Subtasks / nesting (issue #89)                                             */
/* -------------------------------------------------------------------------- */

function disclosureFor(page: Page, title: string) {
  return taskItems(page)
    .filter({ hasText: title })
    .getByRole('button', { name: /Unteraufgaben/ });
}

function progressFor(page: Page, title: string) {
  return taskItems(page).filter({ hasText: title }).locator('.task-list__progress');
}

function nestSelect(page: Page) {
  return page.getByRole('combobox', { name: 'Unteraufgabe von' });
}

test('Im Editor „Unteraufgabe von" wählen macht die Aufgabe zum Kind, die Eltern-Zeile zeigt den Fortschritt (issue #89 AK1)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Elternaufgabe' });
  await seedTask(page, { title: 'Unteraufgabe' });

  await tapTask(page, 'Unteraufgabe');
  await nestSelect(page).selectOption({ label: 'Elternaufgabe' });
  await page.getByRole('button', { name: 'Speichern' }).click();

  await expect(taskItems(page)).toHaveCount(2);
  await expect(progressFor(page, 'Elternaufgabe')).toHaveText('0/1');

  const pending = await page.evaluate(() => window.__starship.pending());
  const last = pending[pending.length - 1];
  expect(last.payload.parentId).toBeTruthy();
});

test('eine Eltern-Zeile hat im Editor keinen Nest-Zweig — ein Elternteil kann nicht selbst verschachtelt werden (issue #89 AK2)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, { title: 'Elternaufgabe' });
  await seedTask(page, { title: 'Kind', parentId });

  await tapTask(page, 'Elternaufgabe');
  await expect(nestSelect(page)).toHaveCount(0);
});

test('das Nest-Ziel-Dropdown bietet nur Top-Level-Aufgaben an, nie ein bestehendes Kind (issue #89 AK2)', async ({
  page,
}) => {
  // Ein Drop *per Drag* auf ein Kind hängt sich an dessen Eltern (resolveNestTarget,
  // per Vitest deterministisch geprüft, plus der echte Drag-Test). Der
  // Editor-Fallback wählt den einfacheren Weg: ein Kind taucht im Dropdown gar
  // nicht erst als Ziel auf, sodass diese Falle über den Editor-Pfad gar nicht
  // erst entstehen kann.
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, { title: 'Elternaufgabe' });
  await seedTask(page, { title: 'Kind', parentId });
  await seedTask(page, { title: 'Neue Unteraufgabe' });

  await tapTask(page, 'Neue Unteraufgabe');
  const options = await nestSelect(page).locator('option').allTextContents();
  expect(options).toContain('Elternaufgabe');
  expect(options).not.toContain('Kind');
});

test('Eltern-Zeile lässt sich auf-/zuklappen (issue #89 AK3)', async ({ page }) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, { title: 'Elternaufgabe' });
  await seedTask(page, { title: 'Kind', parentId });

  const disclosure = disclosureFor(page, 'Elternaufgabe');
  const childItem = taskItems(page).filter({ hasText: 'Kind' });
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(childItem).toHaveJSProperty('inert', false);

  await disclosure.click();

  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(childItem).toHaveJSProperty('inert', true);
});

test('bei reduzierter Bewegung ist der Klapp-Übergang der Kind-Zeile augenblicklich (issue #89 AK3)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, { title: 'Elternaufgabe' });
  await seedTask(page, { title: 'Kind', parentId });

  const childItem = taskItems(page).filter({ hasText: 'Kind' });
  const transitionDuration = await childItem.evaluate(
    (el) => getComputedStyle(el).transitionDuration,
  );
  expect(parseFloat(transitionDuration)).toBeLessThan(0.001);
});

test('Kind abhaken aktualisiert den Fortschritt live, ohne den Elternteil zu erledigen (issue #89 AK4)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, { title: 'Elternaufgabe' });
  await seedTask(page, { title: 'Kind A', parentId });
  await seedTask(page, { title: 'Kind B', parentId });

  await expect(progressFor(page, 'Elternaufgabe')).toHaveText('0/2');

  await checkboxFor(page, 'Kind A').click();

  await expect(progressFor(page, 'Elternaufgabe')).toHaveText('1/2');
  await expect(checkboxFor(page, 'Elternaufgabe')).not.toBeChecked();
});

test('„Keine (Top-Level)" im Editor löst ein Kind wieder aus der Gruppe (issue #89 AK5)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, { title: 'Elternaufgabe' });
  await seedTask(page, { title: 'Kind', parentId });

  await tapTask(page, 'Kind');
  await nestSelect(page).selectOption({ label: 'Keine (Top-Level)' });
  await page.getByRole('button', { name: 'Speichern' }).click();

  // Kein Kind mehr — die Eltern-Zeile zeigt keinen Fortschritt mehr an.
  await expect(progressFor(page, 'Elternaufgabe')).toHaveCount(0);

  const pending = await page.evaluate(() => window.__starship.pending());
  const last = pending[pending.length - 1];
  expect(last.payload.parentId).toBeNull();
});

test('Elternaufgabe löschen tombstoned die Kinder mit, Undo stellt Eltern und Kinder wieder her (issue #89 AK6)', async ({
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
  await expect(
    page.getByRole('status').filter({ hasText: '2 Unteraufgaben gelöscht' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Rückgängig' }).click();

  await expect(taskItems(page)).toHaveCount(3);
});

test('Kinder werden chronologisch nach Erstellzeit sortiert, unabhängig von der Reihenfolge des Anlegens (issue #89 AK7)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, { title: 'Elternaufgabe' });
  await seedTask(page, {
    title: 'Kind B (später erstellt)',
    parentId,
    createdAt: '2026-07-05T00:00:00.000Z',
  });
  await seedTask(page, {
    title: 'Kind A (früher erstellt)',
    parentId,
    createdAt: '2026-07-01T00:00:00.000Z',
  });

  const items = taskItems(page);
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveText(/Elternaufgabe/);
  await expect(items.nth(1)).toHaveText(/Kind A \(früher erstellt\)/);
  await expect(items.nth(2)).toHaveText(/Kind B \(später erstellt\)/);
});

test('Drag & Drop: eine Aufgabe per Long-Press auf eine andere ziehen macht sie zur Unteraufgabe — der primäre Weg neben dem Editor (issue #89 AK1)', async ({
  page,
}) => {
  // A fake clock makes the long-press threshold deterministic — no real 400ms
  // wall-clock pause, which CLAUDE.md forbids as a test crutch.
  await page.clock.install();
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Elternaufgabe' });
  await seedTask(page, { title: 'Unteraufgabe' });

  const dragged = taskItems(page).filter({ hasText: 'Unteraufgabe' });
  const target = taskItems(page).filter({ hasText: 'Elternaufgabe' });
  const dragBox = await dragged.boundingBox();
  const targetBox = await target.boundingBox();
  if (!dragBox || !targetBox) throw new Error('drag test: missing bounding box');

  const startX = dragBox.x + dragBox.width / 2;
  const startY = dragBox.y + dragBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + targetBox.height / 2;

  await dragged.dispatchEvent('pointerdown', {
    pointerId: 1,
    clientX: startX,
    clientY: startY,
    button: 0,
    bubbles: true,
  });
  // Jump past LONG_PRESS_MS so the row picks up for nesting rather than swiping.
  await freezeClock(page);
  await page.clock.fastForward(LONG_PRESS_MS + 100);

  await dragged.dispatchEvent('pointermove', {
    pointerId: 1,
    clientX: endX,
    clientY: endY,
    bubbles: true,
  });
  await dragged.dispatchEvent('pointerup', {
    pointerId: 1,
    clientX: endX,
    clientY: endY,
    bubbles: true,
  });

  await expect(taskItems(page)).toHaveCount(2);
  await expect(progressFor(page, 'Elternaufgabe')).toHaveText('0/1');
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
/* Drag-to-nest: no text selection, live drop preview (issue #451)             */
/* -------------------------------------------------------------------------- */

function dropHint(page: Page) {
  return page.getByTestId('task-drop-hint');
}

async function centerOf(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('centerOf: target has no bounding box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Free space under the last card — where releasing means "no parent". */
async function pointBelowList(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.getByRole('list', { name: 'Aufgaben' }).boundingBox();
  if (!box) throw new Error('pointBelowList: list has no bounding box');
  return { x: box.x + 24, y: box.y + box.height + 40 };
}

/**
 * Picks a row up the way a long press does and *keeps holding* — every assertion
 * about the preview has to happen while the pointer is still down, which is
 * exactly the state the old code had no way to show anything in.
 */
async function liftRow(page: Page, row: Locator) {
  const start = await centerOf(row);
  await row.dispatchEvent('pointerdown', {
    pointerId: 1,
    clientX: start.x,
    clientY: start.y,
    button: 0,
    bubbles: true,
  });
  await freezeClock(page);
  await page.clock.fastForward(LONG_PRESS_MS + 100);
}

async function holdOver(row: Locator, point: { x: number; y: number }) {
  await row.dispatchEvent('pointermove', {
    pointerId: 1,
    clientX: point.x,
    clientY: point.y,
    bubbles: true,
  });
}

async function releaseAt(row: Locator, point: { x: number; y: number }) {
  await row.dispatchEvent('pointerup', {
    pointerId: 1,
    clientX: point.x,
    clientY: point.y,
    bubbles: true,
  });
}

/** Returns whether the page's own scroll was cancelled for this touch move. */
async function touchMoveWasBlocked(row: Locator): Promise<boolean> {
  return row.evaluate((el) => {
    const touch = new Touch({ identifier: 1, target: el, clientX: 10, clientY: 10 });
    const event = new TouchEvent('touchmove', {
      bubbles: true,
      cancelable: true,
      touches: [touch],
      targetTouches: [touch],
      changedTouches: [touch],
    });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

/** `transition-duration` is a list positionally matched to `transition-property` —
 * reads the entry for `property`, or `0` if it is not in the list at all (e.g.
 * `transition: none`), since an untransitioned property changes instantaneously
 * either way. */
async function transitionDurationFor(row: Locator, property: string): Promise<number> {
  return row.evaluate((el, prop) => {
    const style = getComputedStyle(el);
    const properties = style.transitionProperty.split(',').map((s) => s.trim());
    const durations = style.transitionDuration.split(',').map((s) => s.trim());
    const idx = properties.indexOf(prop);
    return idx === -1 ? 0 : parseFloat(durations[idx]);
  }, property);
}

test('eine Aufgabe über die Liste zu ziehen markiert keinen Text (issue #451 AK1)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Zuerst erfasst' });
  await seedTask(page, { title: 'Danach erfasst' });

  const from = await centerOf(taskItems(page).filter({ hasText: 'Zuerst erfasst' }));
  const to = await centerOf(taskItems(page).filter({ hasText: 'Danach erfasst' }));

  // A real mouse drag, not a synthetic pointer event — native text selection is a
  // browser default action, so only the real thing can prove it stays suppressed.
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  const selectedWhileDragging = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  await page.mouse.up();

  expect(selectedWhileDragging).toBe('');
});

test('eine angehobene Aufgabe über einer anderen zu halten markiert diese als Ziel und benennt die Wirkung (issue #451 AK2)', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Sammelaufgabe' });
  await seedTask(page, { title: 'Wanderer' });

  const dragged = taskItems(page).filter({ hasText: 'Wanderer' });
  const target = taskItems(page).filter({ hasText: 'Sammelaufgabe' });

  await liftRow(page, dragged);
  await holdOver(dragged, await centerOf(target));

  await expect(target).toHaveClass(/task-list__item--nest-target/);
  await expect(dropHint(page)).toHaveText('„Wanderer" wird Unteraufgabe von „Sammelaufgabe"');
  // Still held: a preview promises, it does not write.
  await expect(progressFor(page, 'Sammelaufgabe')).toHaveCount(0);
});

test('über einer Unteraufgabe gehalten wird deren Elternteil als Ziel markiert, nicht die Unteraufgabe (issue #451 AK3)', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, { title: 'Sammelaufgabe' });
  await seedTask(page, { title: 'Bestehendes Kind', parentId });
  await seedTask(page, { title: 'Wanderer' });

  const dragged = taskItems(page).filter({ hasText: 'Wanderer' });
  const child = taskItems(page).filter({ hasText: 'Bestehendes Kind' });
  const parent = taskItems(page).filter({ hasText: 'Sammelaufgabe' });

  await liftRow(page, dragged);
  await holdOver(dragged, await centerOf(child));

  await expect(parent).toHaveClass(/task-list__item--nest-target/);
  await expect(child).not.toHaveClass(/task-list__item--nest-target/);
  await expect(dropHint(page)).toHaveText('„Wanderer" wird Unteraufgabe von „Sammelaufgabe"');

  // And releasing does what the preview said — one level, attached to the parent.
  await releaseAt(dragged, await centerOf(child));
  await expect(progressFor(page, 'Sammelaufgabe')).toHaveText('0/2');
});

test('eine Unteraufgabe über den freien Bereich gehalten zeigt das Herauslösen an (issue #451 AK4)', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, { title: 'Sammelaufgabe' });
  await seedTask(page, { title: 'Bestehendes Kind', parentId });

  const dragged = taskItems(page).filter({ hasText: 'Bestehendes Kind' });
  const parent = taskItems(page).filter({ hasText: 'Sammelaufgabe' });

  await liftRow(page, dragged);
  await holdOver(dragged, await pointBelowList(page));

  await expect(dropHint(page)).toHaveText('„Bestehendes Kind" wird keiner Aufgabe zugeordnet');
  await expect(dragged).toHaveClass(/task-list__item--unnest-preview/);
  await expect(parent).not.toHaveClass(/task-list__item--nest-target/);
});

test('eine Aufgabe, die schon auf Wurzelebene liegt, zeigt über dem freien Bereich keine Anzeige (issue #451 AK5)', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Sammelaufgabe' });
  await seedTask(page, { title: 'Wanderer' });

  const dragged = taskItems(page).filter({ hasText: 'Wanderer' });

  await liftRow(page, dragged);
  await holdOver(dragged, await pointBelowList(page));

  await expect(dropHint(page)).toHaveCount(0);
  await expect(page.locator('.task-list__item--nest-target')).toHaveCount(0);
});

test('die Markierung verschwindet, sobald der Zeiger das Ziel verlässt, und beim Abbruch der Geste (issue #451 AK6)', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Sammelaufgabe' });
  await seedTask(page, { title: 'Wanderer' });

  const dragged = taskItems(page).filter({ hasText: 'Wanderer' });
  const target = taskItems(page).filter({ hasText: 'Sammelaufgabe' });

  await liftRow(page, dragged);
  await holdOver(dragged, await centerOf(target));
  await expect(target).toHaveClass(/task-list__item--nest-target/);

  await holdOver(dragged, await pointBelowList(page));
  await expect(target).not.toHaveClass(/task-list__item--nest-target/);
  await expect(dropHint(page)).toHaveCount(0);

  await holdOver(dragged, await centerOf(target));
  await expect(dropHint(page)).toHaveCount(1);
  await dragged.dispatchEvent('pointercancel', { pointerId: 1, bubbles: true });

  await expect(dropHint(page)).toHaveCount(0);
  await expect(target).not.toHaveClass(/task-list__item--nest-target/);
  // A cancelled gesture never nests — the abort is not a quiet drop.
  await expect(progressFor(page, 'Sammelaufgabe')).toHaveCount(0);
});

test('das vertikale Ziehen einer angehobenen Karte scrollt die Seite nicht und bricht die Geste nicht ab (issue #451 AK7)', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Sammelaufgabe' });
  await seedTask(page, { title: 'Wanderer' });

  const dragged = taskItems(page).filter({ hasText: 'Wanderer' });
  const target = taskItems(page).filter({ hasText: 'Sammelaufgabe' });

  await liftRow(page, dragged);
  expect(await touchMoveWasBlocked(dragged)).toBe(true);

  // The gesture survives it and still lands where the preview said.
  await holdOver(dragged, await centerOf(target));
  await releaseAt(dragged, await centerOf(target));
  await expect(progressFor(page, 'Sammelaufgabe')).toHaveText('0/1');

  // And once nothing is lifted, the list scrolls with a finger again.
  expect(await touchMoveWasBlocked(taskItems(page).first())).toBe(false);
});

test('eine angehobene Unteraufgabe folgt dem Zeiger ohne Verzögerung, die Klapp-Animation behält ihre Dauer (issue #457 AK1/AK2)', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, { title: 'Elternaufgabe' });
  await seedTask(page, { title: 'Kind', parentId });

  const child = taskItems(page).filter({ hasText: 'Kind' });

  // Ruhezustand: die Klapp-Animation behält ihre Dauer — die Änderung betrifft
  // nur den Ziehzustand.
  expect(await transitionDurationFor(child, 'max-height')).toBeGreaterThan(0);

  await liftRow(page, child);

  // Angehoben (`--dragging` + `--child`): die transform-Komponente läuft ohne
  // Verzögerung, unabhängig davon, dass die Karte weiterhin `--child` trägt.
  expect(await transitionDurationFor(child, 'transform')).toBe(0);
});

/* -------------------------------------------------------------------------- */
/* Anlege-Sheet: „Mehr"-Bereich (issue #650)                                   */
/* -------------------------------------------------------------------------- */

function quickAddDialog(page: Page) {
  return page.getByRole('dialog', { name: QUICK_ADD_LABEL });
}

function moreToggle(page: Page) {
  return quickAddDialog(page).getByRole('button', { name: 'Mehr' });
}

function quickAddNotes(page: Page) {
  return quickAddDialog(page).getByRole('textbox', { name: 'Notiz der Aufgabe' });
}

async function submitQuickAdd(page: Page) {
  await quickAddDialog(page).getByRole('button', { name: 'Hinzufügen' }).click();
}

test('das Titelfeld ist schlicht mit „Todo Titel" beschriftet (issue #650 AK1)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await openQuickAdd(page);

  await expect(quickAddTitleField(page)).toHaveAttribute('placeholder', 'Todo Titel');
});

test('der „Mehr"-Bereich startet zugeklappt — Titel und Enter genügen (issue #650 AK3)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await openQuickAdd(page);

  await expect(moreToggle(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(quickAddNotes(page)).toHaveCount(0);

  await quickAddTitleField(page).fill('Ohne Umweg');
  await quickAddTitleField(page).press('Enter');

  await expect(page.getByText('Ohne Umweg')).toBeVisible();
  await expect(quickAddDialog(page)).toBeHidden();
});

test('aufgeklappt bietet der Bereich Notiz, Fälligkeit, Unteraufgabe und Priorität (issue #650 AK4)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await openQuickAdd(page);
  await moreToggle(page).click();

  const dialog = quickAddDialog(page);
  await expect(moreToggle(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(quickAddNotes(page)).toBeVisible();
  await expect(dialog.getByLabel('Fälligkeit')).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Unteraufgabe von' })).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'Dringend' })).toBeVisible();
});

test('im „Mehr"-Bereich gesetzte Felder hängen an der neu angelegten Aufgabe (issue #650 AK4)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await openQuickAdd(page);

  const dialog = quickAddDialog(page);
  await quickAddTitleField(page).fill('Mit allem');
  await moreToggle(page).click();
  await quickAddNotes(page).fill('Eine Notiz');
  await dialog.getByLabel('Fälligkeit').fill('2026-07-20T09:00');
  await dialog.getByRole('radio', { name: 'Dringend' }).check();
  await submitQuickAdd(page);
  await expect(dialog).toBeHidden();

  // Gegengeprüft im Bearbeiten-Sheet: was hier steht, ist das, was tatsächlich
  // am Datensatz hängt — nicht bloß das, was das Anlege-Sheet angezeigt hat.
  await tapTask(page, 'Mit allem');
  const editor = editorDialog(page);
  await expect(editor.getByRole('textbox', { name: 'Titel' })).toHaveValue('Mit allem');
  await expect(editor.getByRole('textbox', { name: 'Notiz' })).toHaveValue('Eine Notiz');
  await expect(editor.getByLabel('Fälligkeit')).toHaveValue('2026-07-20T09:00');
  await expect(editor.getByRole('radio', { name: 'Dringend' })).toBeChecked();
});

test('„Unteraufgabe von" beim Anlegen macht die neue Aufgabe sofort zum Kind (issue #650 AK4)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Elternaufgabe' });

  await openQuickAdd(page);
  await quickAddTitleField(page).fill('Gleich verschachtelt');
  await moreToggle(page).click();
  await quickAddDialog(page)
    .getByRole('combobox', { name: 'Unteraufgabe von' })
    .selectOption({ label: 'Elternaufgabe' });
  await submitQuickAdd(page);

  await expect(progressFor(page, 'Elternaufgabe')).toHaveText('0/1');
});

test('eine gesetzte Fälligkeit schlägt das aus dem Titel geratene Datum (issue #650 AK5)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await openQuickAdd(page);

  const dialog = quickAddDialog(page);
  await quickAddTitleField(page).fill('Arzt anrufen morgen um 12');
  await moreToggle(page).click();
  await dialog.getByLabel('Fälligkeit').fill('2026-07-25T08:30');
  await submitQuickAdd(page);

  // Kein Bestätigungs-Sheet und kein Undo-Toast: beide sichern ein ungeprüft
  // geratenes Datum ab — hier hat der Mensch selbst eines eingetragen.
  await expect(page.getByRole('dialog', { name: 'Aufgabe bestätigen' })).toBeHidden();

  await tapTask(page, 'Arzt anrufen');
  await expect(editorDialog(page).getByLabel('Fälligkeit')).toHaveValue('2026-07-25T08:30');
});

test('ein erneut geöffnetes Sheet startet wieder leer und zugeklappt (issue #650 AK6)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await openQuickAdd(page);

  // Kein Titel, in dem ein Füllwort aus parse-task-input.ts steckt („Aufgabe",
  // „Termin", …) — der Parser streicht die heraus, und der Test suchte dann eine
  // Aufgabe, die so nie angelegt wurde.
  await quickAddTitleField(page).fill('Zuerst gespeichert');
  await moreToggle(page).click();
  await quickAddNotes(page).fill('Bleibt nicht stehen');
  await quickAddDialog(page).getByRole('radio', { name: 'Hoch' }).check();
  await submitQuickAdd(page);
  await expect(page.getByText('Zuerst gespeichert')).toBeVisible();

  await openQuickAdd(page);
  await expect(quickAddTitleField(page)).toHaveValue('');
  await expect(moreToggle(page)).toHaveAttribute('aria-expanded', 'false');

  await moreToggle(page).click();
  await expect(quickAddNotes(page)).toHaveValue('');
  await expect(quickAddDialog(page).getByRole('radio', { name: 'Normal' })).toBeChecked();
});

test('offline mit gesetzten Feldern angelegt: die Werte erreichen die echte Datenbank (issue #650 AK7)', async ({
  page,
  context,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await context.setOffline(true);

  await openQuickAdd(page);
  await quickAddTitleField(page).fill('Offline mit Priorität');
  await moreToggle(page).click();
  await quickAddNotes(page).fill('Im Zug notiert');
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
/* Erledigte ausblenden (issue #654)                                          */
/* -------------------------------------------------------------------------- */

const HIDE_COMPLETED_LABEL = 'Erledigte Aufgaben ausblenden';
const HIDE_COMPLETED_BACKGROUND = 'color-mix(in oklch, var(--accent) 8%, var(--surface))';

function hideCompletedToggle(page: Page) {
  return page.getByRole('button', { name: HIDE_COMPLETED_LABEL });
}

test('AC1: der Knopf steht bereit — 44×44 Tippfläche, 24×24 Icon, aria-pressed=false, alles sichtbar', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Offen' });
  await seedTask(page, { title: 'Erledigt', completedAt: new Date(FIXED_NOW).toISOString() });

  const toggle = hideCompletedToggle(page);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');

  const box = await toggle.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);

  const iconBox = await toggle.locator('svg').boundingBox();
  expect(iconBox).not.toBeNull();
  expect(iconBox!.width).toBeCloseTo(24, 0);
  expect(iconBox!.height).toBeCloseTo(24, 0);

  await expect(taskItems(page)).toHaveCount(2);
});

test('AC2: Einschalten setzt aria-pressed, akzentuiert den Knopf und blendet jede erledigte Aufgabe ohne Ersatz aus', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Bleibt offen' });
  await seedTask(page, { title: 'Verschwindet', completedAt: new Date(FIXED_NOW).toISOString() });

  const toggle = hideCompletedToggle(page);
  await toggle.click();

  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(taskItems(page).filter({ hasText: 'Verschwindet' })).toHaveCount(0);
  // No replacement — no counter, no placeholder row, no hint text: exactly the
  // one remaining open task, nothing else.
  await expect(taskItems(page)).toHaveCount(1);
  await expect(taskItems(page).filter({ hasText: 'Bleibt offen' })).toBeVisible();

  const bg = await toggle.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe(await resolveBackground(page, HIDE_COMPLETED_BACKGROUND));
  const iconColor = await toggle.locator('svg').evaluate((el) => getComputedStyle(el).color);
  expect(iconColor).toBe(await resolveColorToken(page, '--accent'));
});

test('AC3: Ausschalten zeigt die erledigten Aufgaben wieder an genau derselben Stelle', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Zuerst', createdAt: '2026-07-01T00:00:00.000Z' });
  await seedTask(page, {
    title: 'Erledigt in der Mitte',
    createdAt: '2026-07-02T00:00:00.000Z',
    completedAt: new Date(FIXED_NOW).toISOString(),
  });
  await seedTask(page, { title: 'Zuletzt', createdAt: '2026-07-03T00:00:00.000Z' });

  const toggle = hideCompletedToggle(page);
  await toggle.click();
  await expect(taskItems(page)).toHaveCount(2);

  await toggle.click();

  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  const items = taskItems(page);
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText('Zuerst');
  await expect(items.nth(1)).toContainText('Erledigt in der Mitte');
  await expect(items.nth(2)).toContainText('Zuletzt');
});

test('AC4: die Präferenz überlebt das Neuladen, geräte-lokal ohne Sync-Spur', async ({ page }) => {
  await page.goto('/aufgaben');

  const before = await page.evaluate(() => window.__starship.size());
  await hideCompletedToggle(page).click();
  const after = await page.evaluate(() => window.__starship.size());
  // Reines Anzeige-Flag — keine Outbox-Mutation, kein Sync (CLAUDE.md Regel 8).
  expect(after).toBe(before);

  const stored = await page.evaluate(() => localStorage.getItem('starship:tasks-hide-completed'));
  expect(stored).toBe('true');

  await page.reload();
  await expect(hideCompletedToggle(page)).toHaveAttribute('aria-pressed', 'true');
});

test('AC5: erledigte Unteraufgaben verschwinden einzeln, ein erledigter Elternteil mit offenem Kind bleibt, der Fortschritt zählt weiter alle Kinder', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const openParentId = await seedTask(page, { title: 'Offene Elternaufgabe' });
  await seedTask(page, {
    title: 'Erledigtes Kind unter offenem Elternteil',
    parentId: openParentId,
    completedAt: new Date(FIXED_NOW).toISOString(),
  });

  const doneParentId = await seedTask(page, {
    title: 'Erledigte Elternaufgabe',
    completedAt: new Date(FIXED_NOW).toISOString(),
  });
  await seedTask(page, {
    title: 'Offenes Kind unter erledigtem Elternteil',
    parentId: doneParentId,
  });
  await seedTask(page, {
    title: 'Erledigtes Kind unter erledigtem Elternteil',
    parentId: doneParentId,
    completedAt: new Date(FIXED_NOW).toISOString(),
  });

  const fullyDoneParentId = await seedTask(page, {
    title: 'Ganz erledigte Gruppe',
    completedAt: new Date(FIXED_NOW).toISOString(),
  });
  await seedTask(page, {
    title: 'Erledigtes Kind der ganz erledigten Gruppe',
    parentId: fullyDoneParentId,
    completedAt: new Date(FIXED_NOW).toISOString(),
  });

  await hideCompletedToggle(page).click();

  await expect(taskItems(page).filter({ hasText: 'Offene Elternaufgabe' })).toBeVisible();
  await expect(
    taskItems(page).filter({ hasText: 'Erledigtes Kind unter offenem Elternteil' }),
  ).toHaveCount(0);

  await expect(taskItems(page).filter({ hasText: 'Erledigte Elternaufgabe' })).toBeVisible();
  await expect(
    taskItems(page).filter({ hasText: 'Offenes Kind unter erledigtem Elternteil' }),
  ).toBeVisible();
  await expect(
    taskItems(page).filter({ hasText: 'Erledigtes Kind unter erledigtem Elternteil' }),
  ).toHaveCount(0);
  // Fortschritt zählt unverändert beide Kinder, nicht nur das sichtbare.
  await expect(progressFor(page, 'Erledigte Elternaufgabe')).toHaveText('1/2');

  // Ganz erledigte Gruppe (Elternteil + alle Kinder erledigt) verschwindet
  // vollständig — wie jede andere erledigte Aufgabe auch (AC2).
  await expect(taskItems(page).filter({ hasText: 'Ganz erledigte Gruppe' })).toHaveCount(0);
  await expect(
    taskItems(page).filter({ hasText: 'Erledigtes Kind der ganz erledigten Gruppe' }),
  ).toHaveCount(0);
});

test('AC6: sind alle Aufgaben erledigt und der Schalter an, zeigt sich der normale Leerzustand', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Erledigt A', completedAt: new Date(FIXED_NOW).toISOString() });
  await seedTask(page, { title: 'Erledigt B', completedAt: new Date(FIXED_NOW).toISOString() });

  await hideCompletedToggle(page).click();

  await expect(page.getByText('Keine Aufgaben. Genieß die Ruhe.')).toBeVisible();
  await expect(taskItems(page)).toHaveCount(0);
});

test('AC7: die Übersicht hat weder den Knopf noch eine Wirkung des Schalters', async ({ page }) => {
  await page.goto('/aufgaben');
  // "heute" fixieren, damit belongsOnUebersicht (use-tasks.ts) die Aufgabe unten
  // wirklich als "heute erledigt" zählt statt an der echten Systemzeit zu messen.
  await skewClock(page, FIXED_NOW);
  await seedTask(page, {
    title: 'Heute erledigt',
    dueAt: new Date(FIXED_NOW).toISOString(),
    completedAt: new Date(FIXED_NOW).toISOString(),
  });
  await hideCompletedToggle(page).click();
  await expect(taskItems(page).filter({ hasText: 'Heute erledigt' })).toHaveCount(0);

  await page.goto('/uebersicht');
  await expect(page.getByRole('button', { name: HIDE_COMPLETED_LABEL })).toHaveCount(0);
  // Dieselbe Aufgabe zeigt sich hier weiter — die Übersicht kennt den
  // Schalter gar nicht, unabhängig davon, dass er auf /aufgaben an ist.
  await expect(taskItems(page).filter({ hasText: 'Heute erledigt' })).toBeVisible();
});

test('AC8: der Knopf bleibt in Hell und Dunkel über Tokens lesbar, nie über Rohwerte', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  const toggle = hideCompletedToggle(page);
  await toggle.click();

  const lightBg = await toggle.evaluate((el) => getComputedStyle(el).backgroundColor);
  const lightIconColor = await toggle.locator('svg').evaluate((el) => getComputedStyle(el).color);

  await page.emulateMedia({ colorScheme: 'dark' });

  const darkBg = await toggle.evaluate((el) => getComputedStyle(el).backgroundColor);
  const darkIconColor = await toggle.locator('svg').evaluate((el) => getComputedStyle(el).color);

  // Beide Werte lösen weiterhin auf denselben semantischen Ausdruck auf —
  // beweist, dass tokens.css' Dark-Mode-Override tatsächlich hier ankommt,
  // nicht ein hartkodierter Wert.
  expect(darkBg).toBe(await resolveBackground(page, HIDE_COMPLETED_BACKGROUND));
  expect(darkIconColor).toBe(await resolveColorToken(page, '--accent'));
  expect(darkBg).not.toBe(lightBg);
  expect(darkIconColor).not.toBe(lightIconColor);
});

test('AC8: eine ausgeblendete Zeile nutzt dieselbe Exit-Animation wie Löschen', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Blendet aus', completedAt: new Date(FIXED_NOW).toISOString() });
  const row = taskItems(page).filter({ hasText: 'Blendet aus' });

  await hideCompletedToggle(page).click();

  // Dieselbe `data-leaving`/`list-exit`-Maschine wie beim Löschen (list-motion.spec.ts) —
  // deren eigener AC3-Test beweist bereits, dass genau dieser Selektor bei
  // reduzierter Bewegung auf die reine Opacity-Variante umschaltet.
  await expect(row).toHaveAttribute('data-leaving', 'true');
  expect(await row.evaluate((el) => getComputedStyle(el).animationName)).toBe('list-exit');
  await expect(row).toHaveCount(0);
});

test('AC8: bei reduzierter Bewegung schaltet der Filter genauso zuverlässig um', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Bleibt sichtbar' });
  await seedTask(page, {
    title: 'Verschwindet ruhig',
    completedAt: new Date(FIXED_NOW).toISOString(),
  });

  await hideCompletedToggle(page).click();

  await expect(taskItems(page).filter({ hasText: 'Verschwindet ruhig' })).toHaveCount(0);
  await expect(taskItems(page).filter({ hasText: 'Bleibt sichtbar' })).toBeVisible();
});
