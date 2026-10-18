import { expect, test, type Locator, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, withDb } from './helpers';

const ADD_LABEL = 'Routine anlegen';
const EDIT_LABEL = 'Routine bearbeiten';

async function openAddHabit(page: Page) {
  await page.getByRole('button', { name: ADD_LABEL }).click();
}

function nameField(page: Page) {
  return page.getByRole('textbox', { name: 'Name' });
}

function createDialog(page: Page) {
  return page.getByRole('dialog', { name: ADD_LABEL });
}

function editDialog(page: Page) {
  return page.getByRole('dialog', { name: EDIT_LABEL });
}

/** A chip body's accessible name is either just the field name (leer) or
 * `"${field}, ${value}"` (gesetzt) — anchored so a search for "Rhythmus" never
 * also matches a radio inside its own panel (issue #711 AK6, mirrors
 * `quickAddChip` in tasks.spec.ts). */
function habitChip(dialog: Locator, field: string) {
  return dialog.getByRole('button', { name: new RegExp(`^${field}(,|$)`) });
}

/** Scoped to the active list — the archived section has its own list further down. */
function habitItems(page: Page) {
  return page.getByRole('list', { name: 'Routinen', exact: true }).getByRole('listitem');
}

function archivedHabitItems(page: Page) {
  return page.getByRole('list', { name: 'Archivierte Routinen' }).getByRole('listitem');
}

async function expandArchived(page: Page) {
  await page.getByRole('button', { name: 'Archiviert' }).click();
}

/**
 * Toggles a row's collapsed/expanded state by tapping its header (issue #905
 * AK3/AK4) — replaces the old direct-to-editor tap from before the table
 * rebuild. The regex is anchored so it matches the header button ("Joggen 3")
 * and not the seven grid buttons inside it once expanded, whose accessible
 * names read "Mo: Joggen offen".
 */
async function tapHabitRow(row: Locator, name: string) {
  await row.getByRole('button', { name: new RegExp(`^${name}\\b`) }).click();
}

/** Expands a collapsed row and opens its editor via "Bearbeiten" (issue #905
 * AK4) — the two-step replacement for the old single tap-to-edit. Assumes the
 * row starts collapsed. */
async function editHabit(page: Page, name: string) {
  const row = habitItems(page).filter({ hasText: name });
  await tapHabitRow(row, name);
  await row.getByRole('button', { name: 'Bearbeiten' }).click();
}

async function seedHabit(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'habits', op: 'upsert', payload: p }),
    payload,
  );
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

/* -------------------------------------------------------------------------- */
/* AK: Bearbeiten und Archivieren funktionieren; archivierte verschwinden     */
/* -------------------------------------------------------------------------- */

test('nur die geänderten Felder landen in der Mutation, nicht der ganze Datensatz', async ({
  page,
}) => {
  await page.goto('/routinen');
  await seedHabit(page, { name: 'Lesen', schedule: 'daily', color: null, archivedAt: null });

  await editHabit(page, 'Lesen');
  const dialog = editDialog(page);
  await habitChip(dialog, 'Rhythmus').click();
  await dialog.getByRole('radio', { name: 'Wöchentlich' }).check();
  await dialog.getByRole('button', { name: 'Sichern' }).click();
  await expect(dialog).toBeHidden();

  const entries = await page.evaluate(() => window.__starship.pending());
  const last = entries[entries.length - 1];
  expect(last.op).toBe('upsert');
  expect(last.payload).toEqual({ schedule: 'weekly' });
});

/* -------------------------------------------------------------------------- */
/* issue #1101: Emoji-Raster statt Farbwähler, mindestens 100 Emojis          */
/* -------------------------------------------------------------------------- */

test('ein Emoji offline gesetzt kommt nach dem Onlinegehen serverseitig an (issue #1101 AC11)', async ({
  page,
  context,
}) => {
  await page.goto('/routinen');
  await seedHabit(page, { name: 'Emoji offline setzen', schedule: 'daily', archivedAt: null });
  await context.setOffline(true);

  await editHabit(page, 'Emoji offline setzen');
  const dialog = editDialog(page);
  await habitChip(dialog, 'Emoji').click();
  await dialog.getByRole('radio', { name: 'Wandern' }).check();
  await dialog.getByRole('button', { name: 'Sichern' }).click();
  await expect(dialog).toBeHidden();
  // One entry for the seed, one for the emoji change — both queued offline.
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(2);

  // Order matters here — see the comment at the equivalent point above (#120).
  await page.unroute('**/api/sync/**');
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  const row = await withDb((client) =>
    client.query('SELECT emoji FROM habits WHERE name = $1', ['Emoji offline setzen']),
  );
  expect(row.rows[0].emoji).toBe('🚶');
});

test('Reaktivieren aus dem Archiv macht die Routine ohne Undo-Angebot wieder aktiv', async ({
  page,
}) => {
  await page.goto('/routinen');
  await seedHabit(page, {
    name: 'Alte Routine',
    schedule: 'daily',
    color: null,
    archivedAt: '2026-01-01T00:00:00.000Z',
  });

  await expandArchived(page);
  const archivedItem = archivedHabitItems(page).filter({ hasText: 'Alte Routine' });
  await expect(archivedItem).toBeVisible();

  await tapHabitRow(archivedItem, 'Alte Routine');
  await archivedItem.getByRole('button', { name: 'Reaktivieren' }).click();

  await expect(habitItems(page).filter({ hasText: 'Alte Routine' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* AK: Offline anlegen -> online -> serverseitig angekommen                   */
/* -------------------------------------------------------------------------- */

test('nach dem Onlinegehen erreicht die offline angelegte Routine die echte Datenbank', async ({
  page,
  context,
}) => {
  await page.goto('/routinen');
  await context.setOffline(true);

  await openAddHabit(page);
  await nameField(page).fill('Server-Ziel');
  await createDialog(page).getByRole('button', { name: 'Anlegen' }).click();
  await expect(habitItems(page).filter({ hasText: 'Server-Ziel' })).toBeVisible();

  // beforeEach cuts the sync endpoints so the list can only ever come from
  // IndexedDB — lift that here to let the queued mutation actually reach Postgres.
  // Must happen before setOffline(false): the app's own 'online' listener fires an
  // automatic sync() the instant we go online, and unrouting after that races its
  // in-flight request against the route being torn down — the request never settles (#120).
  await page.unroute('**/api/sync/**');
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT name, schedule FROM habits WHERE name = $1', ['Server-Ziel']),
  );
  expect(row.rowCount).toBe(1);
  expect(row.rows[0].schedule).toBe('daily');
});

test('offline archiviert erreicht online die Datenbank mit gesetztem archived_at', async ({
  page,
  context,
}) => {
  await page.goto('/routinen');
  await seedHabit(page, { name: 'Offline archivieren', schedule: 'daily', color: null, archivedAt: null });
  await context.setOffline(true);

  const item = habitItems(page).filter({ hasText: 'Offline archivieren' });
  await tapHabitRow(item, 'Offline archivieren');
  await item.getByRole('button', { name: 'Archivieren', exact: true }).click();
  await expect(item).toHaveCount(0);
  // One entry for the seed, one for the archive — both still queued offline.
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(2);

  // Order matters here — see the comment at the equivalent point above (#120).
  await page.unroute('**/api/sync/**');
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  const row = await withDb((client) =>
    client.query('SELECT archived_at FROM habits WHERE name = $1', ['Offline archivieren']),
  );
  expect(row.rows[0].archived_at).not.toBeNull();
});

test('offline den Rhythmus einer Routine geändert: sofort sichtbar, in der Outbox, kommt online serverseitig an (issue #509 AC8)', async ({
  page,
  context,
}) => {
  await page.goto('/routinen');
  await seedHabit(page, {
    name: 'Rhythmus wechseln',
    schedule: 'daily',
    target: 1,
    color: null,
    archivedAt: null,
  });
  await context.setOffline(true);

  await editHabit(page, 'Rhythmus wechseln');
  const dialog = editDialog(page);
  await habitChip(dialog, 'Rhythmus').click();
  await dialog.getByRole('radio', { name: 'Wöchentlich' }).check();
  await habitChip(dialog, 'Ziel').click();
  await dialog.getByRole('radiogroup', { name: 'Wie oft pro Woche' }).getByRole('radio', { name: '4' }).click();
  await dialog.getByRole('button', { name: 'Sichern' }).click();
  await expect(dialog).toBeHidden();

  const item = habitItems(page).filter({ hasText: 'Rhythmus wechseln' });
  await expect(item.locator('.habit-table__schedule')).toContainText('4× pro Woche');
  // One entry for the seed, one for the schedule/target change — both queued offline.
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(2);

  // Order matters here — see the comment at the equivalent point above (#120).
  await page.unroute('**/api/sync/**');
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  const row = await withDb((client) =>
    client.query('SELECT schedule, target FROM habits WHERE name = $1', ['Rhythmus wechseln']),
  );
  expect(row.rows[0].schedule).toBe('weekly');
  expect(row.rows[0].target).toBe(4);
});
