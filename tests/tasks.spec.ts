import { expect, test, type Locator, type Page } from '@playwright/test';
import { formatDueLabel } from '@/features/tasks/datetime-local';
import {
  FIXED_NOW,
  freezeClock,
  installClockAt,
  registerPasskey,
  resetAppData,
  selectView,
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

/** Same synthetic-Pointer-Events technique as `swipeRight`/`swipeLeft`, straight
 * down instead — drags `locator` (e.g. a sheet's grip) by `distancePx` and
 * releases (issue #757). */
async function pullDown(locator: Locator, distancePx: number) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('pullDown: target has no bounding box');
  const clientX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await locator.dispatchEvent('pointerdown', {
    pointerId: 1,
    clientX,
    clientY: startY,
    button: 0,
    bubbles: true,
  });
  await locator.dispatchEvent('pointermove', {
    pointerId: 1,
    clientX,
    clientY: startY + distancePx,
    bubbles: true,
  });
  await locator.dispatchEvent('pointerup', {
    pointerId: 1,
    clientX,
    clientY: startY + distancePx,
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

test('Erledigen lässt die Aufgabe aus „Alle" gleiten statt an ihrer Position zu bleiben (issue #814, vormals #88 AC2)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Zuerst angelegt', createdAt: '2026-07-01T00:00:00.000Z' });
  await seedTask(page, { title: 'Danach angelegt', createdAt: '2026-07-02T00:00:00.000Z' });
  const row = taskItems(page).filter({ hasText: 'Zuerst angelegt' });

  await checkboxFor(page, 'Zuerst angelegt').click();

  // Dieselbe Austritts-Mechanik wie beim Löschen (list-motion.spec.ts).
  await expect(row).toHaveAttribute('data-leaving', 'true');
  expect(await row.evaluate((el) => getComputedStyle(el).animationName)).toBe('list-exit');
  await expect(row).toHaveCount(0);
  await expect(taskItems(page)).toHaveCount(1);
  await expect(taskItems(page)).toHaveText(/Danach angelegt/);

  // … und taucht dort wieder auf, wo Erledigtes jetzt lebt.
  await selectView(page, 'Erledigt');
  await expect(taskItems(page).filter({ hasText: 'Zuerst angelegt' })).toBeVisible();
});

test('Offene Aufgaben werden strikt nach Erstellzeit sortiert — Fälligkeit spielt keine Rolle (issue #88 AC3)', async ({
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

test('Offline-Pfad: eine offline erledigte Aufgabe gleitet sofort aus „Alle", erreicht online als completed_at die Datenbank (issue #814)', async ({
  page,
  context,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const title = 'Offline erledigt';
  await seedTask(page, { title });
  await context.setOffline(true);

  await checkboxFor(page, title).click();
  await expect(taskItems(page).filter({ hasText: title })).toHaveCount(0);

  await page.unroute('**/api/sync/**');
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT completed_at FROM tasks WHERE title = $1', [title]),
  );
  expect(row.rows[0].completed_at).not.toBeNull();
});

test('„Alle" lässt eine erledigte Elternaufgabe mit offenem Kind stehen, blendet nur das erledigte Kind aus (issue #814, vormals #654 AC5)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, {
    title: 'Erledigte Elternaufgabe',
    completedAt: new Date(FIXED_NOW).toISOString(),
  });
  await seedTask(page, { title: 'Offenes Kind', parentId });
  await seedTask(page, {
    title: 'Erledigtes Kind',
    parentId,
    completedAt: new Date(FIXED_NOW).toISOString(),
  });

  await expandParent(page, 'Erledigte Elternaufgabe');

  await expect(taskItems(page).filter({ hasText: 'Erledigte Elternaufgabe' })).toBeVisible();
  await expect(taskItems(page).filter({ hasText: 'Offenes Kind' })).toBeVisible();
  await expect(taskItems(page).filter({ hasText: 'Erledigtes Kind' })).toHaveCount(0);
});

test('„Alle" zählt im Fortschritt einer sichtbaren erledigten Elternaufgabe weiterhin beide Kinder (issue #814, vormals #654 AC5)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, {
    title: 'Erledigte Elternaufgabe',
    completedAt: new Date(FIXED_NOW).toISOString(),
  });
  await seedTask(page, { title: 'Offenes Kind', parentId });
  await seedTask(page, {
    title: 'Erledigtes Kind',
    parentId,
    completedAt: new Date(FIXED_NOW).toISOString(),
  });

  await expect(progressFor(page, 'Erledigte Elternaufgabe')).toHaveText('1/2');
});

test('„Alle" blendet eine ganz erledigte Elterngruppe komplett aus, Kind inklusive (issue #814)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, {
    title: 'Ganz erledigte Gruppe',
    completedAt: new Date(FIXED_NOW).toISOString(),
  });
  await seedTask(page, {
    title: 'Erledigtes Kind der ganz erledigten Gruppe',
    parentId,
    completedAt: new Date(FIXED_NOW).toISOString(),
  });

  await expect(taskItems(page).filter({ hasText: 'Ganz erledigte Gruppe' })).toHaveCount(0);
  await expect(
    taskItems(page).filter({ hasText: 'Erledigtes Kind der ganz erledigten Gruppe' }),
  ).toHaveCount(0);
});

test('„Alle" lässt eine offene Elternaufgabe mit erledigtem Kind stehen, nur das Kind fällt weg (issue #814)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, { title: 'Offene Elternaufgabe' });
  await seedTask(page, {
    title: 'Erledigtes Kind unter offenem Elternteil',
    parentId,
    completedAt: new Date(FIXED_NOW).toISOString(),
  });

  await expect(taskItems(page).filter({ hasText: 'Offene Elternaufgabe' })).toBeVisible();
  await expect(
    taskItems(page).filter({ hasText: 'Erledigtes Kind unter offenem Elternteil' }),
  ).toHaveCount(0);
});

test('sind in „Alle" nur noch erledigte Aufgaben übrig, zeigt sich der normale Leerzustand (issue #814, vormals #654 AC6)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Erledigt A', completedAt: new Date(FIXED_NOW).toISOString() });
  await seedTask(page, { title: 'Erledigt B', completedAt: new Date(FIXED_NOW).toISOString() });

  await expect(page.getByText('Keine Aufgaben. Genieß die Ruhe.')).toBeVisible();
  await expect(taskItems(page)).toHaveCount(0);
});

test('Erledigt man das letzte offene Kind einer bereits sichtbaren erledigten Elternaufgabe, gleitet die ganze Gruppe aus „Alle" (issue #814)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, {
    title: 'Erledigte Elternaufgabe',
    completedAt: new Date(FIXED_NOW).toISOString(),
  });
  await seedTask(page, { title: 'Letztes offenes Kind', parentId });
  await expandParent(page, 'Erledigte Elternaufgabe');

  await checkboxFor(page, 'Letztes offenes Kind').click();

  await expect(taskItems(page).filter({ hasText: 'Erledigte Elternaufgabe' })).toHaveCount(0);
  await expect(taskItems(page).filter({ hasText: 'Letztes offenes Kind' })).toHaveCount(0);
});

test('Öffnet man das einzige erledigte Kind einer aus „Alle" verschwundenen Gruppe wieder, taucht die Gruppe erneut auf (issue #814)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  const parentId = await seedTask(page, {
    title: 'Ganz erledigte Gruppe',
    completedAt: new Date(FIXED_NOW).toISOString(),
  });
  await seedTask(page, {
    title: 'Einziges Kind',
    parentId,
    completedAt: new Date(FIXED_NOW).toISOString(),
  });

  await selectView(page, 'Alle');
  await expect(taskItems(page).filter({ hasText: 'Ganz erledigte Gruppe' })).toHaveCount(0);

  await selectView(page, 'Erledigt');
  await checkboxFor(page, 'Einziges Kind').click();

  await selectView(page, 'Alle');
  await expect(taskItems(page).filter({ hasText: 'Ganz erledigte Gruppe' })).toBeVisible();
  await expect(taskItems(page).filter({ hasText: 'Einziges Kind' })).toBeVisible();
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
  await page.getByRole('button', { name: 'Anlegen' }).click();

  await expect(page.getByText('Wäsche aufhängen')).toBeVisible();
  await expect(page.getByRole('dialog', { name: QUICK_ADD_LABEL })).toBeHidden();
});

test('ein leerer Titel wird nicht gespeichert, der Fokus bleibt im Feld', async ({ page }) => {
  await page.goto('/aufgaben');
  await openQuickAdd(page);
  await page.getByRole('button', { name: 'Anlegen' }).click();

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
  await page.getByRole('button', { name: 'Anlegen' }).click();

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
  await page.getByRole('button', { name: 'Anlegen' }).click();
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
  await page.getByRole('button', { name: 'Anlegen' }).click();

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

test('Fokus kehrt nach Abbrechen zum FAB zurück — derselbe Pfad wie ESC/Backdrop (issue #710 AK4)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await openQuickAdd(page);

  const dialog = page.getByRole('dialog', { name: QUICK_ADD_LABEL });
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: QUICK_ADD_LABEL })).toBeFocused();
});

test('Runterziehen über die Schwelle schließt das Sheet — derselbe Pfad wie ESC/Backdrop/Abbrechen (issue #757)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await openQuickAdd(page);

  const dialog = page.getByRole('dialog', { name: QUICK_ADD_LABEL });
  await pullDown(dialog.locator('.sheet__grip'), 160);

  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: QUICK_ADD_LABEL })).toBeFocused();
});

test('ein zu kurzes Runterziehen schließt nicht — das Sheet bleibt bedienbar (issue #757)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await openQuickAdd(page);

  const dialog = page.getByRole('dialog', { name: QUICK_ADD_LABEL });
  await pullDown(dialog.locator('.sheet__grip'), 40); // below the 120px threshold
  await expect(dialog).toBeVisible();

  // The snap-back must leave the sheet fully interactive, not just visible —
  // a leftover pointer capture on `.sheet__content` would otherwise swallow
  // the click/focus this input needs.
  const input = dialog.getByLabel('Titel der Aufgabe');
  await input.fill('Nach kurzem Zug noch bedienbar');
  await expect(input).toHaveValue('Nach kurzem Zug noch bedienbar');
});

test('Kopfzeile: Griff, Abbrechen links, Titel mittig, Aktion rechts — alle Trefferflächen mindestens 44×44px (issue #710 AK1)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await openQuickAdd(page);

  const dialog = page.getByRole('dialog', { name: QUICK_ADD_LABEL });
  await expect(dialog.locator('.sheet__grip')).toBeVisible();

  const cancel = dialog.getByRole('button', { name: 'Abbrechen' });
  const title = dialog.locator('.sheet__title');
  const action = dialog.getByRole('button', { name: 'Anlegen' });
  await expect(title).toHaveText(QUICK_ADD_LABEL);

  const [cancelBox, titleBox, actionBox] = await Promise.all(
    [cancel, title, action].map((locator) => locator.boundingBox()),
  );
  // Left→right order: Abbrechen, Titel, Aktion.
  expect(cancelBox!.x).toBeLessThan(titleBox!.x);
  expect(titleBox!.x).toBeLessThan(actionBox!.x);

  for (const box of [cancelBox, actionBox]) {
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
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

test('Wisch nach rechts erledigt die Aufgabe sofort, ohne Rückgängig-Popup', async ({ page }) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const title = 'Wird gewischt';
  await seedTask(page, { title });
  const item = taskItems(page).filter({ hasText: title });

  await swipeRight(item, 120);

  // Dieselbe Austritts-Mechanik wie beim Löschen — die Zeile verlässt "Alle"
  // sofort (issue #814), keine Rückgängig-Zwischenstation.
  await expect(item).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeHidden();

  await selectView(page, 'Erledigt');
  await expect(taskItems(page).filter({ hasText: title })).toHaveClass(/task-list__item--done/);
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

test('die Erledigung bleibt ohne Rückgängig bestehen, der Server landet am erledigten Zustand', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const title = 'Undo-Testfall';
  await seedTask(page, { title });
  const item = taskItems(page).filter({ hasText: title });

  await swipeRight(item, 120);
  await expect(item).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeHidden();

  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT completed_at FROM tasks WHERE title = $1', [title]),
  );
  expect(row.rows[0].completed_at).not.toBeNull();
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

test('ein Klick auf die Checkbox erledigt die Aufgabe genauso wie der Swipe', async ({ page }) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const title = 'Checkbox-Testfall';
  await seedTask(page, { title });

  await checkboxFor(page, title).click();

  await expect(taskItems(page).filter({ hasText: title })).toHaveCount(0);
  await selectView(page, 'Erledigt');
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

  await expect(taskItems(page).filter({ hasText: title })).toHaveCount(0);
  await selectView(page, 'Erledigt');
  await expect(checkboxFor(page, title)).toBeChecked();
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

test('Tippen in die Ecke des Checkbox-Touch-Ziels hakt ab, statt den Editor zu öffnen (issue #818)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const title = 'Eck-Tipp';
  await seedTask(page, { title });

  // Click a corner of the 44 × 44 touch target, clearly outside the visibly
  // smaller 22px input it wraps — before issue #818 that fell through to the
  // row's own tap-to-edit gesture instead of toggling the checkbox.
  const wrap = checkboxFor(page, title).locator('xpath=..');
  const box = await wrap.boundingBox();
  if (!box) throw new Error('wrap has no bounding box');
  await page.mouse.click(box.x + 4, box.y + 4);

  await expect(editorDialog(page)).toHaveCount(0);
  await expect(taskItems(page).filter({ hasText: title })).toHaveCount(0);
  await selectView(page, 'Erledigt');
  await expect(checkboxFor(page, title)).toBeChecked();
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

test('Wisch nach links löscht sofort, ohne Rückgängig-Popup', async ({ page }) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const title = 'Wird gelöscht';
  const id = await seedTask(page, { title });
  const item = taskItems(page).filter({ hasText: title });

  await swipeLeft(item, 120);

  await expect(taskItems(page).filter({ hasText: title })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeHidden();

  // A tombstone, never a hard DELETE (CLAUDE.md rule 8 / ADR-0001 §3) — proven by
  // the op the outbox actually queued for this row.
  const entries = await page.evaluate(() => window.__starship.pending());
  const last = entries[entries.length - 1];
  expect(last.op).toBe('delete');
  expect(last.rowId).toBe(id);
});

test('das Löschen bleibt ohne Rückgängig bestehen, der Server landet mit Tombstone', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const title = 'Löschen rückgängig';
  await seedTask(page, { title });
  const item = taskItems(page).filter({ hasText: title });

  await swipeLeft(item, 120);
  await expect(taskItems(page).filter({ hasText: title })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeHidden();

  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT deleted_at FROM tasks WHERE title = $1', [title]),
  );
  expect(row.rows[0].deleted_at).not.toBeNull();
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

/** Same probe technique as `resolveColorToken`, but the probe is a child of
 *  `selector` — resolves the custom property from that element's own cascade
 *  context (mirrors grundfarbe-vollfarbe.spec.ts's `resolveColorTokenIn`, issue #831). */
async function resolveColorTokenIn(page: Page, selector: string, token: string): Promise<string> {
  return page.evaluate(
    ({ selector, token }) => {
      const container = document.querySelector(selector)!;
      const probe = document.createElement('span');
      probe.style.color = `var(${token})`;
      container.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    },
    { selector, token },
  );
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

test('eine offene, vergangene Fälligkeit wird hervorgehoben; eine künftige nicht (issue #86 AC2)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Überfällig', dueAt: '2020-01-01T09:00:00.000Z' });
  await seedTask(page, { title: 'Noch Zeit', dueAt: '2099-01-01T09:00:00.000Z' });

  await expect(dueLabelFor(page, 'Überfällig')).toHaveClass(/task-list__due--overdue/);
  await expect(dueLabelFor(page, 'Noch Zeit')).not.toHaveClass(/task-list__due--overdue/);

  const overdueColor = await dueLabelFor(page, 'Überfällig').evaluate(
    (el) => getComputedStyle(el).color,
  );
  expect(overdueColor).toBe(await resolveColorToken(page, '--danger'));
  const numericFormat = await dueLabelFor(page, 'Überfällig').evaluate(
    (el) => getComputedStyle(el).fontVariantNumeric,
  );
  expect(numericFormat).toContain('tabular-nums');
});

test('eine erledigte Aufgabe wird trotz alter Fälligkeit nie hervorgehoben (issue #86 AC2)', async ({
  page,
}) => {
  // Erledigtes lebt seit #814 nicht mehr in "Alle" — die Aussage "erledigt wird
  // nie hervorgehoben" prüft sich jetzt in "Erledigt", wo die Zeile noch steht.
  await page.goto('/aufgaben');
  await seedTask(page, {
    title: 'Erledigt trotz alter Fälligkeit',
    dueAt: '2020-01-01T09:00:00.000Z',
    completedAt: new Date(FIXED_NOW).toISOString(),
  });

  await selectView(page, 'Erledigt');
  await expect(dueLabelFor(page, 'Erledigt trotz alter Fälligkeit')).not.toHaveClass(
    /task-list__due--overdue/,
  );
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

test('keine eigene Kartenfläche mehr — Zeile flächenlos in ihrer Gruppen-Karte, Trennung nur über 1px Haarlinie (issue #704 AK4, Kartenkontext seit #866)', async ({
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
  // Since #866 the row sits inside `.task-list__group-card`, which resets
  // `--border-faint` to its context-free `-base` value (same Ink-Reset every
  // other floating surface uses) — resolving the token against the page ground
  // (as before #866) would pick up globals.css's ground-relative override
  // instead, so the probe must live inside the card, not on document.body.
  expect(borderBlockEndColor).toBe(
    await resolveColorTokenIn(page, '.task-list__group-card', '--border-faint'),
  );
});

test('Erledigtes schrumpft an Ort und Stelle statt zu springen (issue #704 AK7)', async ({
  page,
}) => {
  // "Woche" (Standardansicht) statt "Alle": eine heute fällige, heute erledigte
  // Aufgabe bleibt dort stehen (issue #705 AK7) — in "Alle" gleitet sie seit
  // #814 sofort aus der Liste, bevor sich die Schrumpf-Optik prüfen ließe.
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');
  const title = 'Wird geschrumpft';
  await seedTask(page, { title, dueAt: new Date(FIXED_NOW).toISOString() });

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

// --- Issue #706 (T3 of #699): grip feedback on the flat rows T1 introduced -----

/** Presses and drags the row `dx` px horizontally without releasing, leaving the
 * gesture mid-swipe so a grip assertion can land while the row is still
 * displaced. Returns the point the pointer now sits at, for a later `releaseAt`. */
async function beginSwipe(row: Locator, dx: number): Promise<{ x: number; y: number }> {
  const box = await row.boundingBox();
  if (!box) throw new Error('beginSwipe: target has no bounding box');
  const clientY = box.y + box.height / 2;
  const startX = box.x + 20;
  await row.dispatchEvent('pointerdown', {
    pointerId: 1,
    clientX: startX,
    clientY,
    button: 0,
    bubbles: true,
  });
  await row.dispatchEvent('pointermove', {
    pointerId: 1,
    clientX: startX + dx,
    clientY,
    bubbles: true,
  });
  return { x: startX + dx, y: clientY };
}

/** Same idea as `resolveColorToken`, for `border-radius` — so the grip-surface
 * assertion never hardcodes the px literal of `--radius-card`. */
async function resolveRadiusToken(page: Page, token: string): Promise<string> {
  return page.evaluate((cssVar) => {
    const probe = document.createElement('span');
    probe.style.borderRadius = `var(${cssVar})`;
    document.body.appendChild(probe);
    const radius = getComputedStyle(probe).borderRadius;
    probe.remove();
    return radius;
  }, token);
}

/** Same idea, for `box-shadow` — proves the grip surface uses the semantic
 * `--shadow-raised` token rather than a hardcoded shadow. */
async function resolveBoxShadow(page: Page, token: string): Promise<string> {
  return page.evaluate((cssVar) => {
    const probe = document.createElement('span');
    probe.style.boxShadow = `var(${cssVar})`;
    document.body.appendChild(probe);
    const shadow = getComputedStyle(probe).boxShadow;
    probe.remove();
    return shadow;
  }, token);
}

test('während des Wischs trägt die Zeile eine Griff-Fläche und federt danach flach zurück (issue #706 AK8)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const title = 'Wird gegriffen';
  await seedTask(page, { title });
  const row = taskRowFor(page, title);

  // Rest state after T1 (#704): flat — no grip class, no card shadow.
  await expect(row).not.toHaveClass(/task-list__item--gripped/);
  await expect(row).toHaveCSS('box-shadow', 'none');

  // Drive the gesture inline (not `swipeRight`) so the assertion lands *mid-swipe*:
  // +40px is past TAP_TOLERANCE_PX (8) but short of SWIPE_THRESHOLD_PX (80), so the
  // row is displaced — gripped — without completing the swipe.
  const releasePoint = await beginSwipe(row, 40);

  // Mid-gesture reads via auto-retrying matchers, never a one-shot
  // getComputedStyle — React 19 flushes discrete events in a microtask, so an
  // immediate read would still see the pre-move DOM.
  await expect(row).toHaveClass(/task-list__item--gripped/);
  await expect(row).toHaveCSS('background-color', await resolveBackground(page, 'var(--surface)'));
  await expect(row).toHaveCSS('border-radius', await resolveRadiusToken(page, '--radius-card'));
  await expect(row).toHaveCSS('box-shadow', await resolveBoxShadow(page, '--shadow-raised'));

  // Release short of the threshold: rebound only — no complete, no delete, no editor.
  await releaseAt(row, releasePoint);

  await expect(row).not.toHaveClass(/task-list__item--gripped/);
  await expect(row).toHaveCSS('box-shadow', 'none');
  await expect(row).toHaveCount(1);
  await expect(row).not.toHaveClass(/task-list__item--done/);
  await expect(editorDialog(page)).toHaveCount(0);
});

test('eine angehobene Aufgabe trägt die Griff-Fläche (issue #706 AK8)', async ({ page }) => {
  await page.clock.install();
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Sammelstelle' });
  await seedTask(page, { title: 'Angehoben' });

  const dragged = taskItems(page).filter({ hasText: 'Angehoben' });
  await liftRow(page, dragged);

  await expect(dragged).toHaveClass(/task-list__item--gripped/);
  await expect(dragged).toHaveCSS(
    'background-color',
    await resolveBackground(page, 'var(--surface)'),
  );

  // Drop it back onto itself (target resolves to null) — cleanup, no nesting.
  await releaseAt(dragged, await centerOf(dragged));
});

test('die randlose Zeile behält die volle Trefferfläche (issue #706 AK8)', async ({ page }) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Volle Breite' });

  const row = taskRowFor(page, 'Volle Breite');
  const rowBox = await row.boundingBox();
  // Full-width grab surface within its own card (issue #866 moved the card
  // surface up to `.task-list__group-card` — the row itself still has no
  // inset of its own, so it fills exactly its immediate parent's width, not
  // the outer `<ul>`'s, which is now wider by the card's own padding).
  const parentWidth = await row.evaluate((el) => el.parentElement!.getBoundingClientRect().width);
  if (!rowBox) throw new Error('missing bounding box');

  expect(Math.abs(rowBox.width - parentWidth)).toBeLessThan(1);
  // …and stays at least one touch target tall, read from the token at runtime.
  const touchTarget = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--touch-target')),
  );
  expect(rowBox.height).toBeGreaterThanOrEqual(touchTarget);
});

test('unter reduzierter Bewegung erscheint die Griff-Fläche als Zustand ohne Animation (issue #706 AK8, DoD)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/aufgaben');
  // The in-app toggle (use-appearance.ts) alongside the OS media query — the DoD
  // asks for both paths, not just whichever the browser emulates.
  await page.evaluate(() => {
    document.documentElement.dataset.reduceMotion = 'true';
  });
  await selectView(page, 'Alle');
  const title = 'Ohne Animation';
  await seedTask(page, { title });
  const row = taskRowFor(page, title);

  const releasePoint = await beginSwipe(row, 40);
  await expect(row).toHaveClass(/task-list__item--gripped/);

  // The grip face is a pure state change: none of these properties is in the row's
  // transition list (only `transform` is), so it snaps in rather than animating.
  expect(await transitionDurationFor(row, 'background-color')).toBe(0);
  expect(await transitionDurationFor(row, 'box-shadow')).toBe(0);
  expect(await transitionDurationFor(row, 'border-radius')).toBe(0);

  await releaseAt(row, releasePoint);
});

test('die Griff-Fläche nutzt im Dark Mode das dunkle --surface (issue #706 AK8, DoD)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const title = 'Griff im Dunkeln';
  await seedTask(page, { title });
  const row = taskRowFor(page, title);

  const lightSurface = await resolveBackground(page, 'var(--surface)');
  await page.emulateMedia({ colorScheme: 'dark' });
  const darkSurface = await resolveBackground(page, 'var(--surface)');
  // The token really changes between themes — otherwise the assertion below would
  // pass trivially whichever mode were active.
  expect(darkSurface).not.toBe(lightSurface);

  const releasePoint = await beginSwipe(row, 40);
  await expect(row).toHaveClass(/task-list__item--gripped/);
  await expect(row).toHaveCSS('background-color', darkSurface);

  await releaseAt(row, releasePoint);
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
  await page.getByRole('button', { name: 'Anlegen' }).click();

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
  // The reload above resets the (unpersisted, issue #705) view back to its
  // "Woche" default — these undated tasks only show in "Alle".
  await selectView(page, 'Alle');

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
  await page.getByRole('button', { name: 'Anlegen' }).click();

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
  // The reload above resets the (unpersisted, issue #705) view back to its
  // "Woche" default — these undated tasks only show in "Alle".
  await selectView(page, 'Alle');
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
  await seedTask(page, { title: 'Zuerst', createdAt: '2026-07-01T00:00:00.000Z' });
  await seedTask(page, { title: 'Offen', createdAt: '2026-07-02T00:00:00.000Z' });

  await page.reload();
  // The reload above resets the (unpersisted, issue #705) view back to its
  // "Woche" default — the #88 scroll anchor under test here only runs in "Alle".
  await selectView(page, 'Alle');
  await expect(taskItems(page)).toHaveCount(2);

  // Too little content to overflow the viewport — nothing to scroll to, so the
  // page stays exactly where it loaded.
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test('Scroll-Anker: erledigte Historie bleibt unsichtbar und löst deshalb keinen Sprung mehr aus (issue #814, vormals #88 AC Scroll-Anker)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');

  // So viel erledigte Historie, dass sie vor #814 beide Viewports der Testmatrix
  // (375×812 und 1280×800) übers Scrollen anfahren musste — seit #814 rendert sie
  // in "Alle" gar nicht mehr, der Anker landet also ohne Sprung direkt oben.
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
  // updates from seeding above. The reload also resets the (unpersisted,
  // issue #705) view back to "Woche" — re-select "Alle" so the anchor runs.
  await page.reload();
  await selectView(page, 'Alle');
  await expect(taskItems(page)).toHaveCount(2);

  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(taskItems(page).filter({ hasText: 'Ältestes offenes Todo' })).toBeInViewport();
});

/* -------------------------------------------------------------------------- */
/* Subtasks / nesting (issue #89)                                             */
/* -------------------------------------------------------------------------- */

function disclosureFor(page: Page, title: string) {
  return taskItems(page)
    .filter({ hasText: title })
    .getByRole('button', { name: /Unteraufgaben/ });
}

/** Opens a parent's collapse branch — subtasks start collapsed (issue #781),
 *  so a test that clicks, drags, or checks off an already-seeded child needs
 *  this before the child row is reachable at all. */
async function expandParent(page: Page, title: string) {
  const disclosure = disclosureFor(page, title);
  await disclosure.click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
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
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(childItem).toHaveJSProperty('inert', true);

  await disclosure.click();

  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(childItem).toHaveJSProperty('inert', false);
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

test('„Woche" startet eingeklappt, die Eltern-Zeile zeigt trotzdem ihren Fortschritt (issue #781 AK1)', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');
  const parentId = await seedTask(page, { title: 'Elternaufgabe', dueAt: isoAt(1) });
  await seedTask(page, { title: 'Kind A', parentId });
  await seedTask(page, { title: 'Kind B', parentId });

  const disclosure = disclosureFor(page, 'Elternaufgabe');
  const childA = taskItems(page).filter({ hasText: 'Kind A' });
  const childB = taskItems(page).filter({ hasText: 'Kind B' });

  // "Woche" ist der Standard — die Fälligkeit morgen liegt im Fenster.
  await expect(viewOption(page, 'Woche')).toHaveAttribute('aria-checked', 'true');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(childA).toHaveJSProperty('inert', true);
  await expect(childB).toHaveJSProperty('inert', true);
  expect((await childA.boundingBox())?.height).toBe(0);
  expect((await childB.boundingBox())?.height).toBe(0);
  await expect(progressFor(page, 'Elternaufgabe')).toHaveText('0/2');
});

test('„Alle" startet ebenfalls eingeklappt, auch für eine Aufgabe ohne Fälligkeit (issue #781 AK2)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  const parentId = await seedTask(page, { title: 'Elternaufgabe ohne Fälligkeit' });
  await seedTask(page, { title: 'Kind', parentId });

  await selectView(page, 'Alle');
  const disclosure = disclosureFor(page, 'Elternaufgabe ohne Fälligkeit');
  const childItem = taskItems(page).filter({ hasText: 'Kind' });
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(childItem).toHaveJSProperty('inert', true);
  expect((await childItem.boundingBox())?.height).toBe(0);
});

test('Aufklappen macht die Liste um die Höhe der Kind-Zeilen länger, Zuklappen nimmt genau diese Höhe wieder heraus (issue #781 AK3)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, { title: 'Elternaufgabe' });
  await seedTask(page, { title: 'Kind A', parentId });
  await seedTask(page, { title: 'Kind B', parentId });

  const list = page.getByRole('list', { name: 'Aufgaben' });
  const disclosure = disclosureFor(page, 'Elternaufgabe');
  const parentRow = taskItems(page).filter({ hasText: 'Elternaufgabe' });
  const childA = taskItems(page).filter({ hasText: 'Kind A' });

  const parentHeight = (await parentRow.boundingBox())!.height;
  const collapsedHeight = (await list.boundingBox())!.height;

  await disclosure.click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  // Polled — die Enthüllung läuft über die `max-height`-Transition (task-list.css).
  await expect
    .poll(async () => (await childA.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(parentHeight - 1);

  const expandedHeight = (await list.boundingBox())!.height;
  // Zwei Kind-Zeilen Höhe, nicht die winzige Lücke, die der min-height-Bug
  // (issue #779) hinterlassen hätte.
  expect(expandedHeight - collapsedHeight).toBeGreaterThan(parentHeight * 1.5);

  await disclosure.click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  // Polled — der Kollaps läuft ebenfalls über die `max-height`-Transition.
  await expect.poll(async () => (await childA.boundingBox())?.height ?? -1).toBe(0);
  await expect.poll(async () => (await list.boundingBox())!.height).toBeLessThan(
    collapsedHeight + 1,
  );
});

test('Der Ansichtswechsel klappt eine aufgeklappte Aufgabe nicht wieder zu (issue #781 AK4)', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');
  const parentId = await seedTask(page, { title: 'Elternaufgabe', dueAt: isoAt(1) });
  await seedTask(page, { title: 'Kind', parentId });

  const disclosure = disclosureFor(page, 'Elternaufgabe');
  await disclosure.click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');

  await viewOption(page, 'Alle').click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');

  await viewOption(page, 'Woche').click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
});

test('Drag-to-Nest auf einen eingeklappten Elternteil klappt ihn auf, das frisch zugeordnete Kind bleibt sichtbar (issue #781 AK5)', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, { title: 'Sammelaufgabe' });
  await seedTask(page, { title: 'Bestehendes Kind', parentId });
  await seedTask(page, { title: 'Wanderer' });

  const disclosure = disclosureFor(page, 'Sammelaufgabe');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');

  const dragged = taskItems(page).filter({ hasText: 'Wanderer' });
  const target = taskItems(page).filter({ hasText: 'Sammelaufgabe' });
  const start = await centerOf(dragged);
  const to = await centerOf(target);

  await dragged.dispatchEvent('pointerdown', {
    pointerId: 1,
    clientX: start.x,
    clientY: start.y,
    button: 0,
    bubbles: true,
  });
  await freezeClock(page);
  await page.clock.fastForward(LONG_PRESS_MS + 100);
  await dragged.dispatchEvent('pointermove', {
    pointerId: 1,
    clientX: to.x,
    clientY: to.y,
    bubbles: true,
  });
  await dragged.dispatchEvent('pointerup', {
    pointerId: 1,
    clientX: to.x,
    clientY: to.y,
    bubbles: true,
  });

  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(taskItems(page).filter({ hasText: 'Wanderer' })).toHaveJSProperty('inert', false);
  await expect(progressFor(page, 'Sammelaufgabe')).toHaveText('0/2');
});

test('„Unteraufgabe von" im Editor klappt einen eingeklappten Elternteil ebenfalls auf (issue #781 AK5)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, { title: 'Elternaufgabe' });
  await seedTask(page, { title: 'Bestehendes Kind', parentId });
  await seedTask(page, { title: 'Neue Unteraufgabe' });

  const disclosure = disclosureFor(page, 'Elternaufgabe');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');

  await tapTask(page, 'Neue Unteraufgabe');
  await nestSelect(page).selectOption({ label: 'Elternaufgabe' });
  await page.getByRole('button', { name: 'Speichern' }).click();

  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(taskItems(page).filter({ hasText: 'Neue Unteraufgabe' })).toHaveJSProperty(
    'inert',
    false,
  );
});

test('Abgehakte Unteraufgabe verschwindet vollständig beim Zuklappen der Elternaufgabe — auch die Opazität, nicht nur die Höhe (issue #782 AK1/AK2)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  // "Woche" (Standardansicht) statt "Alle": eine abgehakte Unteraufgabe bleibt
  // dort im Baum, bis sie eingeklappt wird — in "Alle" verlässt sie seit #814
  // den Baum schon beim Abhaken selbst (erledigte Kinder raus).
  const parentId = await seedTask(page, {
    title: 'Elternaufgabe',
    dueAt: '2020-01-01T09:00:00.000Z',
  });
  await seedTask(page, { title: 'Kind erledigt', parentId });
  await seedTask(page, { title: 'Kind offen', parentId });

  // Default ist eingeklappt (issue #781) — die Kinder erst sichtbar machen,
  // bevor ihre Checkbox überhaupt klickbar ist.
  await expandParent(page, 'Elternaufgabe');
  await checkboxFor(page, 'Kind erledigt').click();
  await expect(checkboxFor(page, 'Kind erledigt')).toBeChecked();

  const doneChild = taskItems(page).filter({ hasText: 'Kind erledigt' });
  const openChild = taskItems(page).filter({ hasText: 'Kind offen' });

  await disclosureFor(page, 'Elternaufgabe').click();

  await expect(doneChild).toBeHidden();
  await expect(openChild).toBeHidden();
  // AK2: die zugeklappte, abgehakte Zeile deklariert sich auch selbst als
  // unsichtbar (opacity 0) — nicht nur durch die Geometrie aus #779 verdeckt.
  // Polled wie in checkoff-motion.spec.ts: die Opazität läuft über dieselbe
  // Transition wie max-height, ein Sofort-Read kann sie mitten im Flug fangen.
  await expect.poll(() => doneChild.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
});

test('Aufklappen bringt die abgehakte Unteraufgabe unverändert zurück (issue #782 AK3)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  // "Woche" statt "Alle" (issue #814) — siehe AK1/AK2 oben.
  const parentId = await seedTask(page, {
    title: 'Elternaufgabe',
    dueAt: '2020-01-01T09:00:00.000Z',
  });
  await seedTask(page, { title: 'Kind erledigt', parentId });

  // Default ist eingeklappt (issue #781) — die Kinder erst sichtbar machen,
  // bevor ihre Checkbox überhaupt klickbar ist.
  await expandParent(page, 'Elternaufgabe');
  await checkboxFor(page, 'Kind erledigt').click();
  const doneChild = taskItems(page).filter({ hasText: 'Kind erledigt' });
  const disclosure = disclosureFor(page, 'Elternaufgabe');

  await disclosure.click();
  await expect(doneChild).toBeHidden();

  await disclosure.click();

  await expect(doneChild).toBeVisible();
  await expect(doneChild).toHaveClass(/task-list__item--done/);
  await expect.poll(() => doneChild.evaluate((el) => getComputedStyle(el).opacity)).toBe('0.6');
  const textDecoration = await doneChild
    .locator('.task-list__title')
    .evaluate((el) => getComputedStyle(el).textDecorationLine);
  expect(textDecoration).toContain('line-through');
});

test('nicht abgehakte Unteraufgabe bleibt unverändert: zugeklappt unsichtbar, aufgeklappt bei opacity 1 (issue #782 AK4)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, { title: 'Elternaufgabe' });
  await seedTask(page, { title: 'Kind offen', parentId });

  const openChild = taskItems(page).filter({ hasText: 'Kind offen' });
  const disclosure = disclosureFor(page, 'Elternaufgabe');

  // Default ist eingeklappt (issue #781) — erst aufklappen, dann zählt die
  // Opazität-Behauptung für den sichtbaren Zustand.
  await expandParent(page, 'Elternaufgabe');
  await expect.poll(() => openChild.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

  await disclosure.click();
  await expect(openChild).toBeHidden();

  await disclosure.click();
  await expect(openChild).toBeVisible();
  await expect.poll(() => openChild.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
});

test('bei reduzierter Bewegung bleibt das Zuklappen einer abgehakten Unteraufgabe augenblicklich, ohne sichtbaren Zwischenzustand (issue #782 AK6)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/aufgaben');
  // "Woche" statt "Alle" (issue #814) — siehe AK1/AK2 oben.
  const parentId = await seedTask(page, {
    title: 'Elternaufgabe',
    dueAt: '2020-01-01T09:00:00.000Z',
  });
  await seedTask(page, { title: 'Kind erledigt', parentId });

  // Default ist eingeklappt (issue #781) — die Kinder erst sichtbar machen,
  // bevor ihre Checkbox überhaupt klickbar ist.
  await expandParent(page, 'Elternaufgabe');
  await checkboxFor(page, 'Kind erledigt').click();
  const doneChild = taskItems(page).filter({ hasText: 'Kind erledigt' });
  const transitionDuration = await doneChild.evaluate(
    (el) => getComputedStyle(el).transitionDuration,
  );
  expect(parseFloat(transitionDuration)).toBeLessThan(0.001);

  await disclosureFor(page, 'Elternaufgabe').click();
  await expect(doneChild).toBeHidden();
  await expect.poll(() => doneChild.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
});

test('Kind abhaken aktualisiert den Fortschritt live, ohne den Elternteil zu erledigen (issue #89 AK4)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, { title: 'Elternaufgabe' });
  await seedTask(page, { title: 'Kind A', parentId });
  await seedTask(page, { title: 'Kind B', parentId });
  await expandParent(page, 'Elternaufgabe');

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
  await expandParent(page, 'Elternaufgabe');

  await tapTask(page, 'Kind');
  await nestSelect(page).selectOption({ label: 'Keine (Top-Level)' });
  await page.getByRole('button', { name: 'Speichern' }).click();

  // Kein Kind mehr — die Eltern-Zeile zeigt keinen Fortschritt mehr an.
  await expect(progressFor(page, 'Elternaufgabe')).toHaveCount(0);

  const pending = await page.evaluate(() => window.__starship.pending());
  const last = pending[pending.length - 1];
  expect(last.payload.parentId).toBeNull();
});

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

test('Desktop: eine Aufgabe ohne Pause direkt auf eine andere zu ziehen macht sie sofort zur Unteraufgabe, ohne den Long-Press abzuwarten (issue #763)', async ({
  page,
}) => {
  // Fake clock installed but never advanced — proves the pick-up fires from the drag
  // leaving the row, not from the long-press timer quietly elapsing on its own.
  await page.clock.install();
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Elternaufgabe' });
  await seedTask(page, { title: 'Unteraufgabe' });

  const dragged = taskItems(page).filter({ hasText: 'Unteraufgabe' });
  const target = taskItems(page).filter({ hasText: 'Elternaufgabe' });
  const from = await centerOf(dragged);
  const to = await centerOf(target);

  await dragged.dispatchEvent('pointerdown', {
    pointerId: 1,
    pointerType: 'mouse',
    clientX: from.x,
    clientY: from.y,
    button: 0,
    bubbles: true,
  });
  // Straight to the row above in one move, no pause — the natural way a mouse drag
  // starts, and exactly what the long-press alone used to swallow as a tap.
  await dragged.dispatchEvent('pointermove', {
    pointerId: 1,
    pointerType: 'mouse',
    clientX: to.x,
    clientY: to.y,
    bubbles: true,
  });
  await dragged.dispatchEvent('pointerup', {
    pointerId: 1,
    pointerType: 'mouse',
    clientX: to.x,
    clientY: to.y,
    bubbles: true,
  });

  await expect(taskItems(page)).toHaveCount(2);
  await expect(progressFor(page, 'Elternaufgabe')).toHaveText('0/1');
});

test('Desktop: eine Unteraufgabe ohne Pause in den freien Bereich zu ziehen löst sie sofort wieder aus der Elternaufgabe, selbst wenn der Zug auch seitlich geht (issue #763)', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, { title: 'Sammelaufgabe' });
  await seedTask(page, { title: 'Bestehendes Kind', parentId });
  await expandParent(page, 'Sammelaufgabe');

  const dragged = taskItems(page).filter({ hasText: 'Bestehendes Kind' });
  const start = await centerOf(dragged);
  // Down into the free space *and* toward the left edge — a net-horizontal vector the
  // old "mostly vertical" rule mistook for a swipe (and would have deleted the row).
  const end = await pointBelowList(page);

  await dragged.dispatchEvent('pointerdown', {
    pointerId: 1,
    pointerType: 'mouse',
    clientX: start.x,
    clientY: start.y,
    button: 0,
    bubbles: true,
  });
  await dragged.dispatchEvent('pointermove', {
    pointerId: 1,
    pointerType: 'mouse',
    clientX: end.x,
    clientY: end.y,
    bubbles: true,
  });
  await dragged.dispatchEvent('pointerup', {
    pointerId: 1,
    pointerType: 'mouse',
    clientX: end.x,
    clientY: end.y,
    bubbles: true,
  });

  // Local-first assertions (these specs cut the sync endpoints, so nothing reaches
  // Postgres to query with `withDb` — the offline→server round-trip for the same
  // outbox `upsert` is already covered by the „issue #89 AK Offline" test below).
  await expect(progressFor(page, 'Sammelaufgabe')).toHaveCount(0);
  // Un-nested, not deleted: the row is still here, now standing on its own at the top
  // level rather than indented under a parent.
  const child = taskItems(page).filter({ hasText: 'Bestehendes Kind' });
  await expect(child).toHaveCount(1);
  await expect(child).not.toHaveClass(/task-list__item--child/);
});

test('Handy (Touch): erst der Long-Press hebt die Zeile an und macht sie per Ziehen zur Unteraufgabe (issue #763)', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Elternaufgabe' });
  await seedTask(page, { title: 'Unteraufgabe' });

  const dragged = taskItems(page).filter({ hasText: 'Unteraufgabe' });
  const target = taskItems(page).filter({ hasText: 'Elternaufgabe' });
  const from = await centerOf(dragged);
  const to = await centerOf(target);

  await dragged.dispatchEvent('pointerdown', {
    pointerId: 1,
    pointerType: 'touch',
    clientX: from.x,
    clientY: from.y,
    button: 0,
    bubbles: true,
  });
  // A finger's own vertical drag must stay free to scroll the list, so on touch the
  // pick-up is the long-press alone — wait it out before moving.
  await freezeClock(page);
  await page.clock.fastForward(LONG_PRESS_MS + 100);

  await dragged.dispatchEvent('pointermove', {
    pointerId: 1,
    pointerType: 'touch',
    clientX: to.x,
    clientY: to.y,
    bubbles: true,
  });
  await dragged.dispatchEvent('pointerup', {
    pointerId: 1,
    pointerType: 'touch',
    clientX: to.x,
    clientY: to.y,
    bubbles: true,
  });

  await expect(progressFor(page, 'Elternaufgabe')).toHaveText('0/1');
});

test('Handy (Touch): ein schnelles vertikales Ziehen ohne Long-Press hebt die Zeile nicht an, damit die Liste scrollbar bleibt (issue #763)', async ({
  page,
}) => {
  // Clock installed but never advanced — the long-press is deliberately not reached,
  // so any pick-up here would be the (wrong) immediate one the mouse path uses.
  await page.clock.install();
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Elternaufgabe' });
  await seedTask(page, { title: 'Unteraufgabe' });

  const dragged = taskItems(page).filter({ hasText: 'Unteraufgabe' });
  const target = taskItems(page).filter({ hasText: 'Elternaufgabe' });
  const from = await centerOf(dragged);
  const to = await centerOf(target);

  await dragged.dispatchEvent('pointerdown', {
    pointerId: 1,
    pointerType: 'touch',
    clientX: from.x,
    clientY: from.y,
    button: 0,
    bubbles: true,
  });
  await dragged.dispatchEvent('pointermove', {
    pointerId: 1,
    pointerType: 'touch',
    clientX: to.x,
    clientY: to.y,
    bubbles: true,
  });
  await dragged.dispatchEvent('pointerup', {
    pointerId: 1,
    pointerType: 'touch',
    clientX: to.x,
    clientY: to.y,
    bubbles: true,
  });

  // No pick-up, so no nesting — the finger's move stayed a would-be scroll.
  await expect(progressFor(page, 'Elternaufgabe')).toHaveCount(0);
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
  await expandParent(page, 'Sammelaufgabe');

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
  await expandParent(page, 'Sammelaufgabe');

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
  await expandParent(page, 'Elternaufgabe');

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

function quickAddChipDiscard(page: Page, field: string) {
  return quickAddDialog(page).getByRole('button', { name: `${field} verwerfen` });
}

function quickAddNotes(page: Page) {
  return quickAddDialog(page).getByRole('textbox', { name: 'Notiz der Aufgabe' });
}

/** The Wann panel's own picker (issue #722) — replaces the native
 * `datetime-local` input `quickAddDueInput` used to scope to. */
function quickAddDuePicker(page: Page) {
  return quickAddDialog(page).locator('.due-picker');
}

function dueQuickSelect(page: Page, label: 'Heute' | 'Morgen' | 'Nächste Woche') {
  return quickAddDuePicker(page).getByRole('button', { name: label, exact: true });
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

test('das Titelfeld ist schlicht mit „Todo Titel" beschriftet (issue #650 AK1)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await openQuickAdd(page);

  await expect(quickAddTitleField(page)).toHaveAttribute('placeholder', 'Todo Titel');
});

test('die Chip-Zeile startet ohne offenes Panel — Titel und Enter genügen (issue #650 AK3)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await openQuickAdd(page);

  await expect(quickAddChip(page, 'Notiz')).toHaveAttribute('aria-expanded', 'false');
  await expect(quickAddNotes(page)).toHaveCount(0);

  await quickAddTitleField(page).fill('Ohne Umweg');
  await quickAddTitleField(page).press('Enter');

  await expect(page.getByText('Ohne Umweg')).toBeVisible();
  await expect(quickAddDialog(page)).toBeHidden();
});

test('vier Chips ersetzen den „Mehr"-Aufklapper, jeder öffnet sein eigenes Control (issue #650 AK4, #711 AK4)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Elternaufgabe' });
  await openQuickAdd(page);
  const dialog = quickAddDialog(page);

  await expect(dialog.getByRole('button', { name: 'Mehr' })).toHaveCount(0);

  await quickAddChip(page, 'Notiz').click();
  await expect(quickAddChip(page, 'Notiz')).toHaveAttribute('aria-expanded', 'true');
  await expect(quickAddNotes(page)).toBeVisible();

  await quickAddChip(page, 'Fälligkeit').click();
  await expect(quickAddDuePicker(page)).toBeVisible();
  await expect(quickAddNotes(page)).toHaveCount(0);

  await quickAddChip(page, 'Teil von').click();
  await expect(dialog.getByRole('combobox', { name: 'Unteraufgabe von' })).toBeVisible();

  await quickAddChip(page, 'Priorität').click();
  await expect(dialog.getByRole('radio', { name: 'Dringend' })).toBeVisible();
});

test('über die Chips gesetzte Felder hängen an der neu angelegten Aufgabe (issue #650 AK4)', async ({
  page,
}) => {
  await installClockAt(page);
  await page.goto('/aufgaben');
  await openQuickAdd(page);

  const dialog = quickAddDialog(page);
  await quickAddTitleField(page).fill('Mit allem');

  await quickAddChip(page, 'Notiz').click();
  await quickAddNotes(page).fill('Eine Notiz');

  await quickAddChip(page, 'Fälligkeit').click();
  // FIXED_NOW ist Samstag, 18.07.2026 — Montag, 20. liegt im selben
  // Kalendermonat, ein Tag-Tipp ohne Uhrzeit landet auf DEFAULT_TIME 09:00.
  await setDueViaCalendar(page, 'Montag, 20.');

  await quickAddChip(page, 'Priorität').click();
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

test('„Teil von" beim Anlegen macht die neue Aufgabe sofort zum Kind (issue #650 AK4)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Elternaufgabe' });

  await openQuickAdd(page);
  await quickAddTitleField(page).fill('Gleich verschachtelt');
  await quickAddChip(page, 'Teil von').click();
  await quickAddDialog(page)
    .getByRole('combobox', { name: 'Unteraufgabe von' })
    .selectOption({ label: 'Elternaufgabe' });
  await submitQuickAdd(page);

  await expect(progressFor(page, 'Elternaufgabe')).toHaveText('0/1');
});

test('eine über den Wann-Chip gesetzte Fälligkeit schlägt das aus dem Titel geratene Datum (issue #650 AK5)', async ({
  page,
}) => {
  await installClockAt(page);
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await openQuickAdd(page);

  await quickAddTitleField(page).fill('Arzt anrufen morgen um 12');
  await quickAddChip(page, 'Fälligkeit').click();
  // FIXED_NOW ist Samstag, 18.07.2026 — Samstag, 25. liegt im selben
  // Kalendermonat, eine Woche später.
  await setDueViaCalendar(page, 'Samstag, 25.', '08:30');
  await submitQuickAdd(page);

  // Kein Bestätigungs-Sheet und kein Undo-Toast: beide sichern ein ungeprüft
  // geratenes Datum ab — hier hat der Mensch selbst eines eingetragen.
  await expect(page.getByRole('dialog', { name: 'Aufgabe bestätigen' })).toBeHidden();

  await tapTask(page, 'Arzt anrufen');
  await expect(editorDialog(page).getByLabel('Fälligkeit')).toHaveValue('2026-07-25T08:30');
});

test('ein erneut geöffnetes Sheet startet wieder leer, ohne offenes Panel (issue #650 AK6)', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await openQuickAdd(page);

  // Kein Titel, in dem ein Füllwort aus parse-task-input.ts steckt („Aufgabe",
  // „Termin", …) — der Parser streicht die heraus, und der Test suchte dann eine
  // Aufgabe, die so nie angelegt wurde.
  await quickAddTitleField(page).fill('Zuerst gespeichert');
  await quickAddChip(page, 'Notiz').click();
  await quickAddNotes(page).fill('Bleibt nicht stehen');
  await quickAddChip(page, 'Priorität').click();
  await quickAddDialog(page).getByRole('radio', { name: 'Hoch' }).check();
  await submitQuickAdd(page);
  await expect(page.getByText('Zuerst gespeichert')).toBeVisible();

  await openQuickAdd(page);
  await expect(quickAddTitleField(page)).toHaveValue('');
  await expect(quickAddChip(page, 'Notiz')).toHaveAttribute('aria-expanded', 'false');
  await expect(quickAddChip(page, 'Priorität')).toHaveText('Priorität?');

  await quickAddChip(page, 'Notiz').click();
  await expect(quickAddNotes(page)).toHaveValue('');
  await quickAddChip(page, 'Priorität').click();
  await expect(quickAddDialog(page).getByRole('radio', { name: 'Normal' })).toBeChecked();
});

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
/* Chip-Bauteil (issue #711)                                                  */
/* -------------------------------------------------------------------------- */

test('AK1: der Chip kennt fünf Zustände — leer, gesetzt, geraten, offen, deaktiviert', async ({
  page,
}) => {
  await installClockAt(page);
  await page.goto('/aufgaben');
  await openQuickAdd(page);

  // leer: kein Wert, keine Verwerfen-Fläche.
  await expect(quickAddChip(page, 'Fälligkeit')).toHaveText('Wann?');
  await expect(quickAddChipDiscard(page, 'Fälligkeit')).toHaveCount(0);

  // deaktiviert: keine Aufgabe in der Datenbank, also kein Nest-Kandidat.
  await expect(quickAddChip(page, 'Teil von')).toBeDisabled();

  // offen: Antippen öffnet das Panel, aria-expanded spiegelt es.
  await quickAddChip(page, 'Notiz').click();
  await expect(quickAddChip(page, 'Notiz')).toHaveAttribute('aria-expanded', 'true');
  await expect(quickAddNotes(page)).toBeVisible();

  // gesetzt: ein eingetragener Wert tönt den Chip und trägt ihn im a11y-Namen.
  await quickAddNotes(page).fill('Einkaufen');
  await expect(quickAddChip(page, 'Notiz')).toHaveAccessibleName('Notiz, Einkaufen');
  await quickAddChip(page, 'Notiz').click();

  // geraten: aus dem Titel erkanntes Datum ohne Titel — die Verwerfen-Fläche
  // erscheint, obwohl niemand den Chip angetippt hat (AK2: angenommen, nicht offen).
  await quickAddTitleField(page).fill('morgen um 12');
  await quickAddTitleField(page).press('Enter');
  await expect(quickAddChipDiscard(page, 'Fälligkeit')).toBeVisible();
  await expect(quickAddChip(page, 'Fälligkeit')).toHaveAttribute('aria-expanded', 'false');
});

test('AK2: ein geratener Chip bleibt ohne Antippen erhalten, das „x" verwirft ihn', async ({
  page,
}) => {
  await installClockAt(page);
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');

  // Nichts tun heißt behalten: kein Antippen des „x", das Datum landet am Datensatz.
  await openQuickAdd(page);
  await quickAddTitleField(page).fill('morgen um 12');
  await quickAddTitleField(page).press('Enter');
  await quickAddTitleField(page).fill('Angenommen');
  await submitQuickAdd(page);
  await expect(page.getByText('Angenommen')).toBeVisible();
  await tapTask(page, 'Angenommen');
  await expect(editorDialog(page).getByLabel('Fälligkeit')).not.toHaveValue('');
  await page.keyboard.press('Escape');

  // Antippen des „x" verwirft: das Datum erreicht den Datensatz nicht.
  await openQuickAdd(page);
  await quickAddTitleField(page).fill('morgen um 12');
  await quickAddTitleField(page).press('Enter');
  await quickAddChipDiscard(page, 'Fälligkeit').click();
  await expect(quickAddChip(page, 'Fälligkeit')).toHaveText('Wann?');
  await quickAddTitleField(page).fill('Verworfen');
  await submitQuickAdd(page);
  await expect(page.getByText('Verworfen')).toBeVisible();
  await tapTask(page, 'Verworfen');
  await expect(editorDialog(page).getByLabel('Fälligkeit')).toHaveValue('');
});

test('AK3: ein zweiter geöffneter Chip schließt den ersten', async ({ page }) => {
  await page.goto('/aufgaben');
  await openQuickAdd(page);

  await quickAddChip(page, 'Notiz').click();
  await expect(quickAddNotes(page)).toBeVisible();

  await quickAddChip(page, 'Priorität').click();
  await expect(quickAddNotes(page)).toHaveCount(0);
  await expect(quickAddDialog(page).getByRole('radio', { name: 'Dringend' })).toBeVisible();
  await expect(quickAddChip(page, 'Notiz')).toHaveAttribute('aria-expanded', 'false');
});

test('AK5: kein Layout-Shift beim Öffnen eines Chip-Panels — Kopfzeile und Titel bleiben stehen', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await openQuickAdd(page);
  const dialog = quickAddDialog(page);
  const header = dialog.locator('.sheet__header-row');
  const title = quickAddTitleField(page);

  // The sheet's own open transition (sheet.css, ~200ms) must have settled first
  // — otherwise "before" is measured mid-slide-up and any coordinate compared
  // against "after" reads as a shift that has nothing to do with the panel.
  await expect
    .poll(() =>
      dialog
        .locator('.sheet__content')
        .evaluate((el) => el.getAnimations().some((a) => a.playState === 'running')),
    )
    .toBe(false);

  const headerBefore = await header.boundingBox();
  const titleBefore = await title.boundingBox();

  await quickAddChip(page, 'Notiz').click();
  await expect(quickAddNotes(page)).toBeVisible();

  const headerAfter = await header.boundingBox();
  const titleAfter = await title.boundingBox();

  // A hair of tolerance, not exact equality, for pure sub-pixel layout rounding
  // — same call as list-motion.spec.ts's AC4. A real shift (the reserved panel
  // slot failing to hold its height) would move these by several pixels, an
  // order of magnitude past this threshold.
  const LAYOUT_SHIFT_TOLERANCE_PX = 1;
  for (const [before, after] of [
    [headerBefore, headerAfter],
    [titleBefore, titleAfter],
  ] as const) {
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(Math.abs(after!.x - before!.x)).toBeLessThan(LAYOUT_SHIFT_TOLERANCE_PX);
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(LAYOUT_SHIFT_TOLERANCE_PX);
    expect(Math.abs(after!.width - before!.width)).toBeLessThan(LAYOUT_SHIFT_TOLERANCE_PX);
    expect(Math.abs(after!.height - before!.height)).toBeLessThan(LAYOUT_SHIFT_TOLERANCE_PX);
  }
});

test('AK6: der a11y-Name eines Chips trägt Feldname und Wert', async ({ page }) => {
  await installClockAt(page);
  await page.goto('/aufgaben');
  await openQuickAdd(page);

  await quickAddChip(page, 'Fälligkeit').click();
  // FIXED_NOW ist Samstag, 18.07.2026 — Donnerstag, 23. liegt im selben Kalendermonat.
  await setDueViaCalendar(page, 'Donnerstag, 23.', '14:00');
  await quickAddChip(page, 'Fälligkeit').click();

  const expected = `Fälligkeit, ${formatDueLabel('2026-07-23T14:00')}`;
  await expect(quickAddChip(page, 'Fälligkeit')).toHaveAccessibleName(expected);
});

/* -------------------------------------------------------------------------- */
/* Wann-Picker: Schnellwahl + Kalender statt datetime-local (issue #722)      */
/* -------------------------------------------------------------------------- */

test('AK1: der Wann-Chip öffnet den eigenen Picker statt des nativen datetime-local', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await openQuickAdd(page);

  await quickAddChip(page, 'Fälligkeit').click();

  await expect(quickAddDuePicker(page)).toBeVisible();
  await expect(dueQuickSelect(page, 'Heute')).toBeVisible();
  await expect(dueQuickSelect(page, 'Morgen')).toBeVisible();
  await expect(dueQuickSelect(page, 'Nächste Woche')).toBeVisible();
  await expect(dueTimeInput(page)).toBeVisible();
  await expect(quickAddDialog(page).locator('input[type="datetime-local"]')).toHaveCount(0);
});

test('AK2: Schnellwahl-Zeilen setzen die Fälligkeit mit einem Tipp', async ({ page }) => {
  // FIXED_NOW ist Samstag, 18.07.2026.
  await installClockAt(page);
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');

  // Titel bewusst ohne "heute"/"morgen"/Wochentag: parse-task-input.ts erkennt
  // diese Wörter als Datumsangabe und entfernt sie aus dem Titel (Grammatik-Regel
  // R3) — ein Titel, der sie enthält, käme nie unverändert in der Liste an.
  await openQuickAdd(page);
  await quickAddTitleField(page).fill('Schnellwahl Fall 1');
  await quickAddChip(page, 'Fälligkeit').click();
  await dueQuickSelect(page, 'Heute').click();
  await submitQuickAdd(page);
  await tapTask(page, 'Schnellwahl Fall 1');
  await expect(editorDialog(page).getByLabel('Fälligkeit')).toHaveValue('2026-07-18T09:00');
  await page.keyboard.press('Escape');

  await openQuickAdd(page);
  await quickAddTitleField(page).fill('Schnellwahl Fall 2');
  await quickAddChip(page, 'Fälligkeit').click();
  await dueQuickSelect(page, 'Morgen').click();
  await submitQuickAdd(page);
  await tapTask(page, 'Schnellwahl Fall 2');
  await expect(editorDialog(page).getByLabel('Fälligkeit')).toHaveValue('2026-07-19T09:00');
  await page.keyboard.press('Escape');

  // Nächste Woche = nächster Montag, unabhängig vom heutigen Wochentag.
  await openQuickAdd(page);
  await quickAddTitleField(page).fill('Schnellwahl Fall 3');
  await quickAddChip(page, 'Fälligkeit').click();
  await dueQuickSelect(page, 'Nächste Woche').click();
  await submitQuickAdd(page);
  await tapTask(page, 'Schnellwahl Fall 3');
  await expect(editorDialog(page).getByLabel('Fälligkeit')).toHaveValue('2026-07-20T09:00');
});

test('AK3: ein gewählter Kalendertag setzt das Datum, die Uhrzeit ist getrennt wählbar', async ({
  page,
}) => {
  // FIXED_NOW ist Samstag, 18.07.2026 — Mittwoch, 22. liegt im selben Kalendermonat.
  await installClockAt(page);
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');

  // Fall a: Tag antippen und eine eigene Uhrzeit setzen.
  await openQuickAdd(page);
  await quickAddTitleField(page).fill('Tag mit eigener Uhrzeit');
  await quickAddChip(page, 'Fälligkeit').click();
  await setDueViaCalendar(page, 'Mittwoch, 22.', '16:15');
  await submitQuickAdd(page);
  await tapTask(page, 'Tag mit eigener Uhrzeit');
  await expect(editorDialog(page).getByLabel('Fälligkeit')).toHaveValue('2026-07-22T16:15');
  await page.keyboard.press('Escape');

  // Fall b: nur der Tag, die Uhrzeit bleibt unangetastet — Entscheidung A (09:00 Default).
  await openQuickAdd(page);
  await quickAddTitleField(page).fill('Tag ohne eigene Uhrzeit');
  await quickAddChip(page, 'Fälligkeit').click();
  await dueCalendarDay(page, 'Mittwoch, 22.').click();
  await submitQuickAdd(page);
  await tapTask(page, 'Tag ohne eigene Uhrzeit');
  await expect(editorDialog(page).getByLabel('Fälligkeit')).toHaveValue('2026-07-22T09:00');
});

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

test('AK5: Dark Mode löst den Auswahl-Token auf, reduzierte Bewegung floort die Übergänge im Kalender', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installClockAt(page);
  await page.goto('/aufgaben');
  await openQuickAdd(page);
  await quickAddChip(page, 'Fälligkeit').click();

  const today = dueCalendarDay(page, 'Samstag, 18.');
  const durationString = await today.evaluate((el) => getComputedStyle(el).transitionDuration);
  // Same call as the reduced-motion assertion around line 999 — Chromium
  // serializes the floored duration in exponential notation.
  expect(parseFloat(durationString)).toBeLessThan(0.001);

  await page.emulateMedia({ colorScheme: 'dark' });
  await today.click();
  await expect(today).toHaveAttribute('aria-pressed', 'true');
  // Same pattern as the dark-mode dot check in kalender.spec.ts ("der
  // Kategorie-Punkt kommt aus dem semantischen Token, mit eigenem Wert im
  // Dark Mode"): a plain synchronous getComputedStyle read right after the
  // color-scheme switch + click can catch Chromium mid style-recalc and
  // still report the pre-change value — expect.poll re-evaluates until the
  // browser has actually settled, same target value either way.
  await expect
    .poll(() => today.evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(await resolveColorToken(page, '--accent'));
});

/* -------------------------------------------------------------------------- */
/* Wochenausschnitt, Woche/Alle/Erledigt-Umschalter (issue #705)              */
/* -------------------------------------------------------------------------- */

/** A group card's title (issue #866) — "Überfällig"/"Heute"/"Diese Woche" in
 *  "Woche", one per completed day in "Erledigt". */
function groupTitles(page: Page) {
  return page.locator('.task-list__group-title');
}

/** The count next to a group card's title (issue #866 AK1). */
function groupCounts(page: Page) {
  return page.locator('.task-list__group-count');
}

function viewOption(page: Page, name: 'Woche' | 'Alle' | 'Erledigt') {
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

  await expect(viewOption(page, 'Woche')).toHaveAttribute('aria-checked', 'true');

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

test('AK2: der Umschalter Woche/Alle/Erledigt ist nicht persistiert — nach einer Navigation steht wieder „Woche"', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Diese Woche fällig', dueAt: isoAt(1) });
  await seedTask(page, { title: 'Ohne Datum' });

  await expect(taskItems(page)).toHaveCount(1);

  await viewOption(page, 'Alle').click();
  await expect(viewOption(page, 'Alle')).toHaveAttribute('aria-checked', 'true');
  await expect(taskItems(page)).toHaveCount(2);

  await page.reload();

  await expect(viewOption(page, 'Woche')).toHaveAttribute('aria-checked', 'true');
  await expect(taskItems(page)).toHaveCount(1);
  await expect(taskItems(page).filter({ hasText: 'Ohne Datum' })).toHaveCount(0);
});

test('AK1 (T2/#866): „Woche" bündelt in drei feste Karten — „Überfällig", „Heute", „Diese Woche" — statt einer Marke je Tag', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');

  // Zwei überfällige Aufgaben an verschiedenen Tagen — teilen sich EINE
  // "Überfällig"-Karte, keine pro Tag.
  await seedTask(page, { title: 'Länger überfällig', dueAt: isoAt(-5) });
  await seedTask(page, { title: 'Kürzer überfällig', dueAt: isoAt(-1) });
  await seedTask(page, { title: 'Heute dran', dueAt: isoAt(0, 15) });
  // Zwei an verschiedenen Wochentagen fällige Aufgaben — fallen unter
  // Variante A in DIESELBE "Diese Woche"-Karte, nicht in eine je Tag.
  await seedTask(page, { title: 'Übermorgen dran', dueAt: isoAt(2) });
  await seedTask(page, { title: 'In 5 Tagen dran', dueAt: isoAt(5) });

  // Genau 3 Karten — eine pro Bucket, keine vierte, keine pro Wochentag.
  const titles = groupTitles(page);
  await expect(titles).toHaveCount(3);
  await expect(titles.nth(0)).toHaveText('Überfällig');
  await expect(titles.nth(1)).toHaveText('Heute');
  await expect(titles.nth(2)).toHaveText('Diese Woche');

  // Anzahl rechts = Top-Level-Zeilen der Karte (AK1).
  const counts = groupCounts(page);
  await expect(counts.nth(0)).toHaveText('2');
  await expect(counts.nth(1)).toHaveText('1');
  await expect(counts.nth(2)).toHaveText('2');

  // Karten-Titel/Anzahl zählen nicht als Aufgaben-Zeile.
  await expect(taskItems(page)).toHaveCount(5);
});

test('AK6: Aufgaben ohne Fälligkeit stehen unter „Woche" nicht in der Liste, sondern eingeklappt in einer ausklappbaren Karte (issue #762, vormals eine reine Textzeile)', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Ohne Datum A' });
  await seedTask(page, { title: 'Ohne Datum B' });
  // Erledigt und ohne Datum zählt nicht mit — nur offene.
  await seedTask(page, {
    title: 'Ohne Datum, aber erledigt',
    completedAt: new Date(FIXED_NOW).toISOString(),
  });
  await seedTask(page, { title: 'Diese Woche fällig', dueAt: isoAt(1) });

  await expect(taskItems(page)).toHaveCount(1);
  for (const title of ['Ohne Datum A', 'Ohne Datum B', 'Ohne Datum, aber erledigt']) {
    await expect(taskItems(page).filter({ hasText: title })).toHaveCount(0);
  }

  const card = page.getByRole('button', { name: '2 Aufgaben ohne Datum' });
  await expect(card).toHaveAttribute('aria-expanded', 'false');
  // `inert` (section-card.tsx) isn't respected by Playwright's role/text engine
  // (checked empirically: getByRole still finds inert rows) — the collapsed
  // *container* is the only element whose own box is genuinely zero-size (CSS
  // grid-template-rows: 0fr), so that is what toBeHidden() must target, found via
  // aria-controls rather than a hardcoded class name (mirrors uebersicht.spec.ts).
  const contentId = await card.getAttribute('aria-controls');
  await expect(page.locator(`[id="${contentId}"]`)).toBeHidden();

  await card.click();
  await expect(card).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Ohne Datum A')).toBeVisible();
  await expect(page.getByText('Ohne Datum B')).toBeVisible();
});

test('AK9: liegt im Rest der Woche nichts mehr, steht darunter „Danach nichts mehr geplant."', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Nur heute', dueAt: isoAt(0, 9) });

  await expect(taskItems(page)).toHaveCount(1);
  await expect(page.getByText('Danach nichts mehr geplant.')).toBeVisible();

  // Sobald etwas nach heute ansteht, verschwindet der Hinweis wieder.
  await seedTask(page, { title: 'Morgen auch', dueAt: isoAt(1) });
  await expect(page.getByText('Danach nichts mehr geplant.')).toHaveCount(0);
});

test('AK7: eine heute erledigte, überfällige Aufgabe bleibt bis zum Tageswechsel in ihrer Tagesgruppe — an einem früheren Tag erledigte fällt raus', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');
  await seedTask(page, {
    title: 'Heute abgehakt',
    dueAt: isoAt(-3),
    completedAt: new Date(FIXED_NOW).toISOString(),
  });
  await seedTask(page, {
    title: 'Gestern abgehakt',
    dueAt: isoAt(-3),
    completedAt: isoAt(-1),
  });

  await expect(taskItems(page).filter({ hasText: 'Heute abgehakt' })).toBeVisible();
  await expect(taskItems(page).filter({ hasText: 'Gestern abgehakt' })).toHaveCount(0);
});

test('Erledigt: sortiert nach Erledigungszeit absteigend, gegliedert nach Heute/Gestern/Datum, offene Aufgaben bleiben draußen', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');
  await seedTask(page, {
    title: 'Heute früh erledigt',
    completedAt: isoAt(0, 8),
  });
  await seedTask(page, {
    title: 'Heute spät erledigt',
    completedAt: isoAt(0, 16),
  });
  await seedTask(page, {
    title: 'Gestern erledigt',
    completedAt: isoAt(-1, 10),
  });
  await seedTask(page, { title: 'Noch offen' });

  await viewOption(page, 'Erledigt').click();
  await expect(viewOption(page, 'Erledigt')).toHaveAttribute('aria-checked', 'true');

  const titles = groupTitles(page);
  await expect(titles).toHaveCount(2);
  await expect(titles.nth(0)).toHaveText('Heute');
  await expect(titles.nth(1)).toHaveText('Gestern');

  const items = taskItems(page);
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText('Heute spät erledigt');
  await expect(items.nth(1)).toContainText('Heute früh erledigt');
  await expect(items.nth(2)).toContainText('Gestern erledigt');
  await expect(items.filter({ hasText: 'Noch offen' })).toHaveCount(0);
});

test('Offline-Pfad: eine offline angelegte Aufgabe folgt sofort der Woche-Ansicht, erreicht online die Datenbank', async ({
  page,
  context,
}) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');
  await context.setOffline(true);

  await seedTask(page, { title: 'Offline diese Woche', dueAt: isoAt(3) });
  await seedTask(page, { title: 'Offline ohne Datum' });

  await expect(taskItems(page)).toHaveCount(1);
  await expect(taskItems(page).filter({ hasText: 'Offline diese Woche' })).toBeVisible();

  await viewOption(page, 'Alle').click();
  await expect(taskItems(page)).toHaveCount(2);
  await expect(taskItems(page).filter({ hasText: 'Offline ohne Datum' })).toBeVisible();

  await page.unroute('**/api/sync/**');
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const rows = await withDb((client) =>
    client.query('SELECT title FROM tasks WHERE title IN ($1, $2) ORDER BY title', [
      'Offline diese Woche',
      'Offline ohne Datum',
    ]),
  );
  expect(rows.rows.map((r) => r.title)).toEqual(['Offline diese Woche', 'Offline ohne Datum']);
});
