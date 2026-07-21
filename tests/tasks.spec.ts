import { expect, test, type Locator, type Page } from '@playwright/test';
import { freezeClock, registerPasskey, resetAppData, withDb } from './helpers';

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

test('Erledigen lässt die Aufgabe an ihrer Position — sie sieht erledigt aus, springt aber nicht ans Ende (issue #88 AC2)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
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
  await seedTask(page, { title: 'Zuletzt angelegt, ohne Termin', createdAt: '2026-07-10T10:00:00.000Z' });

  const items = taskItems(page);
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveText(/Zuerst angelegt/);
  await expect(items.nth(1)).toHaveText(/Danach angelegt, aber früher fällig/);
  await expect(items.nth(2)).toHaveText(/Zuletzt angelegt, ohne Termin/);
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

test('eine gesetzte Fälligkeit zeigt die Uhrzeit im 24h-Format, ändert aber nicht die Position (issue #88 AC3)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
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
  const title = 'Löschen rückgängig';
  await seedTask(page, { title });
  const item = taskItems(page).filter({ hasText: title });

  await swipeLeft(item, 120);
  await page.getByRole('button', { name: 'Löschen' }).click();
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

function priorityDotFor(page: Page, title: string) {
  return taskItems(page).filter({ hasText: title }).locator('.task-list__priority-dot');
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

test('Priorität „Normal" bleibt ohne Punkt, „Hoch" und „Dringend" zeigen einen dezenten Punkt (issue #86 AC1)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Normale Aufgabe', priority: 0 });
  await seedTask(page, { title: 'Hohe Priorität', priority: 1 });
  await seedTask(page, { title: 'Dringende Aufgabe', priority: 2 });

  await expect(priorityDotFor(page, 'Normale Aufgabe')).toHaveCount(0);
  await expect(priorityDotFor(page, 'Hohe Priorität')).toHaveClass(
    /task-list__priority-dot--hoch/,
  );
  await expect(priorityDotFor(page, 'Dringende Aufgabe')).toHaveClass(
    /task-list__priority-dot--dringend/,
  );

  const hochColor = await priorityDotFor(page, 'Hohe Priorität').evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  expect(hochColor).toBe(await resolveColorToken(page, '--warning'));
  const dringendColor = await priorityDotFor(page, 'Dringende Aufgabe').evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  expect(dringendColor).toBe(await resolveColorToken(page, '--danger'));
});

test('eine offene, vergangene Fälligkeit wird hervorgehoben; eine künftige oder erledigte nicht (issue #86 AC2)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Überfällig', dueAt: '2020-01-01T09:00:00.000Z' });
  await seedTask(page, { title: 'Noch Zeit', dueAt: '2099-01-01T09:00:00.000Z' });
  await seedTask(page, {
    title: 'Erledigt trotz alter Fälligkeit',
    dueAt: '2020-01-01T09:00:00.000Z',
    completedAt: new Date().toISOString(),
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

test('Prioritäts-Punkt und Überfällig-Hervorhebung bleiben im Dark Mode korrekt und fügen keine Bewegung hinzu (issue #86 AC3)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Dringend im Dunkeln', priority: 2, dueAt: '2020-01-01T09:00:00.000Z' });

  const dot = priorityDotFor(page, 'Dringend im Dunkeln');
  const due = dueLabelFor(page, 'Dringend im Dunkeln');

  // No transition on either element — static, token-driven colour needs no motion
  // to begin with, so `prefers-reduced-motion` has nothing to override here.
  await expect.poll(() => dot.evaluate((el) => getComputedStyle(el).transitionProperty)).toBe(
    'none',
  );
  await expect.poll(() => due.evaluate((el) => getComputedStyle(el).transitionProperty)).toBe(
    'none',
  );

  const lightDotColor = await dot.evaluate((el) => getComputedStyle(el).backgroundColor);
  const lightDueColor = await due.evaluate((el) => getComputedStyle(el).color);

  await page.emulateMedia({ colorScheme: 'dark' });

  const darkDotColor = await dot.evaluate((el) => getComputedStyle(el).backgroundColor);
  const darkDueColor = await due.evaluate((el) => getComputedStyle(el).color);

  // Still resolve to the semantic token, just its dark-mode value — proving the
  // override in tokens.css actually reaches these elements, not a hardcoded colour.
  expect(darkDotColor).toBe(await resolveColorToken(page, '--danger'));
  expect(darkDueColor).toBe(await resolveColorToken(page, '--danger'));
  expect(darkDotColor).not.toBe(lightDotColor);
  expect(darkDueColor).not.toBe(lightDueColor);
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

  // Scoped to the list — the undo toast's own message embeds the title too.
  await expect(taskItems(page).filter({ hasText: title })).toHaveCount(0);
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

test('ein per Schnellerfassung angelegtes Todo erscheint unten in der Liste (issue #88 AC1)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
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
  await seedTask(page, { title: 'Bestand', createdAt: '2026-07-01T00:00:00.000Z' });
  await context.setOffline(true);

  await openQuickAdd(page);
  await quickAddTitleField(page).fill('Offline neu');
  await page.getByRole('button', { name: 'Hinzufügen' }).click();

  const items = taskItems(page);
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('Bestand');
  await expect(items.nth(1)).toContainText('Offline neu');

  await context.setOffline(false);
  await page.unroute('**/api/sync/**');
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
  return taskItems(page).filter({ hasText: title }).getByRole('button', { name: /Unteraufgaben/ });
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
  const parentId = await seedTask(page, { title: 'Elternaufgabe' });
  await seedTask(page, { title: 'Kind A', parentId });
  await seedTask(page, { title: 'Kind B', parentId });
  await expect(taskItems(page)).toHaveCount(3);

  const parentItem = taskItems(page).filter({ hasText: 'Elternaufgabe' });
  await swipeLeft(parentItem, 120);
  await page.getByRole('button', { name: 'Löschen' }).click();

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
  const parentId = await seedTask(page, { title: 'Elternaufgabe' });
  await seedTask(page, { title: 'Unteraufgabe' });
  await context.setOffline(true);

  await tapTask(page, 'Unteraufgabe');
  await nestSelect(page).selectOption({ label: 'Elternaufgabe' });
  await page.getByRole('button', { name: 'Speichern' }).click();

  await expect(progressFor(page, 'Elternaufgabe')).toHaveText('0/1');

  await context.setOffline(false);
  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT parent_id FROM tasks WHERE title = $1', ['Unteraufgabe']),
  );
  expect(row.rows[0].parent_id).toBe(parentId);
});
