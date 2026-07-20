import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetDatabase, withDb } from './helpers';

const ADD_LABEL = 'Gewohnheit anlegen';
const EDIT_LABEL = 'Gewohnheit bearbeiten';

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

/** Scoped to the active list — the archived section has its own list further down. */
function habitItems(page: Page) {
  return page.getByRole('list', { name: 'Gewohnheiten' }).getByRole('listitem');
}

function archivedHabitItems(page: Page) {
  return page.getByRole('list', { name: 'Archivierte Gewohnheiten' }).getByRole('listitem');
}

async function expandArchived(page: Page) {
  await page.getByRole('button', { name: 'Archiviert' }).click();
}

async function tapHabit(page: Page, name: string) {
  await habitItems(page).filter({ hasText: name }).click();
}

async function seedHabit(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'habits', op: 'upsert', payload: p }),
    payload,
  );
}

test.beforeEach(async ({ page }) => {
  await resetDatabase();
  // The list must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8) —
  // with the sync endpoints cut, that is the only way any of these tests can pass.
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await registerPasskey(page);
});

test('ein designter Leerzustand statt eines leeren Screens', async ({ page }) => {
  await page.goto('/heute/gewohnheiten');
  await expect(page.getByText('Keine Gewohnheiten. Leg deine erste an.')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* AK: Habit mit Name + Schedule anlegen; erscheint in der Liste              */
/* -------------------------------------------------------------------------- */

test('eine per FAB angelegte Gewohnheit erscheint sofort in der Liste', async ({ page }) => {
  await page.goto('/heute/gewohnheiten');
  await openAddHabit(page);

  await expect(createDialog(page)).toBeVisible();
  await expect(nameField(page)).toBeFocused();

  await nameField(page).fill('Wasser trinken');
  await createDialog(page).getByRole('radio', { name: 'Wöchentlich' }).check();
  await createDialog(page).getByRole('button', { name: 'Anlegen' }).click();

  await expect(createDialog(page)).toBeHidden();
  const item = habitItems(page).filter({ hasText: 'Wasser trinken' });
  await expect(item).toBeVisible();
  await expect(item).toContainText('Wöchentlich');
});

test('ein leerer Name wird nicht gespeichert, der Fokus bleibt im Feld', async ({ page }) => {
  await page.goto('/heute/gewohnheiten');
  await openAddHabit(page);

  await createDialog(page).getByRole('button', { name: 'Anlegen' }).click();

  await expect(createDialog(page)).toBeVisible();
  await expect(nameField(page)).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
});

test('Rhythmus „Täglich" ist der Standard, wenn nichts anderes gewählt wird', async ({ page }) => {
  await page.goto('/heute/gewohnheiten');
  await openAddHabit(page);
  await nameField(page).fill('Meditieren');
  await createDialog(page).getByRole('button', { name: 'Anlegen' }).click();

  await expect(habitItems(page).filter({ hasText: 'Meditieren' })).toContainText('Täglich');
});

/* -------------------------------------------------------------------------- */
/* AK: Bearbeiten und Archivieren funktionieren; archivierte verschwinden     */
/* -------------------------------------------------------------------------- */

test('Tippen auf eine Gewohnheit öffnet den Editor mit Name und Rhythmus', async ({ page }) => {
  await page.goto('/heute/gewohnheiten');
  await seedHabit(page, { name: 'Joggen', schedule: 'weekly', color: null, archivedAt: null });

  await tapHabit(page, 'Joggen');

  const dialog = editDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('Joggen');
  await expect(dialog.getByRole('radio', { name: 'Wöchentlich' })).toBeChecked();
});

test('nur die geänderten Felder landen in der Mutation, nicht der ganze Datensatz', async ({
  page,
}) => {
  await page.goto('/heute/gewohnheiten');
  await seedHabit(page, { name: 'Lesen', schedule: 'daily', color: null, archivedAt: null });

  await tapHabit(page, 'Lesen');
  const dialog = editDialog(page);
  await dialog.getByRole('radio', { name: 'Wöchentlich' }).check();
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  await expect(dialog).toBeHidden();

  const entries = await page.evaluate(() => window.__starship.pending());
  const last = entries[entries.length - 1];
  expect(last.op).toBe('upsert');
  expect(last.payload).toEqual({ schedule: 'weekly' });
});

test('eine Farbe wählen und speichern setzt die Eigenfarbe der Gewohnheit', async ({ page }) => {
  await page.goto('/heute/gewohnheiten');
  await seedHabit(page, { name: 'Dehnen', schedule: 'daily', color: null, archivedAt: null });

  await tapHabit(page, 'Dehnen');
  const dialog = editDialog(page);
  await dialog.getByRole('radio', { name: 'Koralle' }).check();
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  await expect(dialog).toBeHidden();

  const entries = await page.evaluate(() => window.__starship.pending());
  const last = entries[entries.length - 1];
  expect(last.payload).toEqual({ color: '--area-tasks' });
});

test('Archivieren entfernt die Gewohnheit aus der aktiven Liste und zeigt einen Undo-Toast', async ({
  page,
}) => {
  await page.goto('/heute/gewohnheiten');
  await seedHabit(page, { name: 'Tagebuch', schedule: 'daily', color: null, archivedAt: null });
  const item = habitItems(page).filter({ hasText: 'Tagebuch' });
  await expect(item).toBeVisible();

  await item.getByRole('button', { name: 'Archivieren' }).click();

  await expect(item).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'archiviert' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeVisible();

  await expandArchived(page);
  await expect(archivedHabitItems(page).filter({ hasText: 'Tagebuch' })).toBeVisible();
});

test('der Undo-Toast beim Archivieren macht es rückgängig, die Gewohnheit ist wieder aktiv', async ({
  page,
}) => {
  await page.goto('/heute/gewohnheiten');
  await seedHabit(page, { name: 'Stretching', schedule: 'daily', color: null, archivedAt: null });
  const item = habitItems(page).filter({ hasText: 'Stretching' });

  await item.getByRole('button', { name: 'Archivieren' }).click();
  await expect(item).toHaveCount(0);

  await page.getByRole('button', { name: 'Rückgängig' }).click();

  await expect(habitItems(page).filter({ hasText: 'Stretching' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeHidden();

  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT archived_at FROM habits WHERE name = $1', ['Stretching']),
  );
  expect(row.rows[0].archived_at).toBeNull();
});

test('Reaktivieren aus dem Archiv macht die Gewohnheit ohne Undo-Angebot wieder aktiv', async ({
  page,
}) => {
  await page.goto('/heute/gewohnheiten');
  await seedHabit(page, {
    name: 'Alte Gewohnheit',
    schedule: 'daily',
    color: null,
    archivedAt: '2026-01-01T00:00:00.000Z',
  });

  await expandArchived(page);
  const archivedItem = archivedHabitItems(page).filter({ hasText: 'Alte Gewohnheit' });
  await expect(archivedItem).toBeVisible();

  await archivedItem.getByRole('button', { name: 'Reaktivieren' }).click();

  await expect(habitItems(page).filter({ hasText: 'Alte Gewohnheit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* AK: Offline anlegen -> online -> serverseitig angekommen                   */
/* -------------------------------------------------------------------------- */

test('offline angelegt: sofort sichtbar, genau ein Eintrag in der Outbox', async ({
  page,
  context,
}) => {
  await page.goto('/heute/gewohnheiten');
  await context.setOffline(true);

  await openAddHabit(page);
  await nameField(page).fill('Im Zug gestreckt');
  await createDialog(page).getByRole('button', { name: 'Anlegen' }).click();

  await expect(habitItems(page).filter({ hasText: 'Im Zug gestreckt' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  await context.setOffline(false);
});

test('nach dem Onlinegehen erreicht die offline angelegte Gewohnheit die echte Datenbank', async ({
  page,
  context,
}) => {
  await page.goto('/heute/gewohnheiten');
  await context.setOffline(true);

  await openAddHabit(page);
  await nameField(page).fill('Server-Ziel');
  await createDialog(page).getByRole('button', { name: 'Anlegen' }).click();
  await expect(habitItems(page).filter({ hasText: 'Server-Ziel' })).toBeVisible();

  await context.setOffline(false);
  // beforeEach cuts the sync endpoints so the list can only ever come from
  // IndexedDB — lift that here to let the queued mutation actually reach Postgres.
  await page.unroute('**/api/sync/**');
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
  await page.goto('/heute/gewohnheiten');
  await seedHabit(page, { name: 'Offline archivieren', schedule: 'daily', color: null, archivedAt: null });
  await context.setOffline(true);

  const item = habitItems(page).filter({ hasText: 'Offline archivieren' });
  await item.getByRole('button', { name: 'Archivieren' }).click();
  await expect(item).toHaveCount(0);
  // One entry for the seed, one for the archive — both still queued offline.
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(2);

  await context.setOffline(false);
  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  const row = await withDb((client) =>
    client.query('SELECT archived_at FROM habits WHERE name = $1', ['Offline archivieren']),
  );
  expect(row.rows[0].archived_at).not.toBeNull();
});

/* -------------------------------------------------------------------------- */
/* AK: Semantische Tokens, Dark Mode, prefers-reduced-motion                  */
/* -------------------------------------------------------------------------- */

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

function colorDotFor(page: Page, name: string) {
  return habitItems(page).filter({ hasText: name }).locator('.habit-list__color');
}

test('eine Gewohnheit ohne Eigenfarbe zeigt den Standard-Token --area-habits, auch im Dark Mode', async ({
  page,
}) => {
  await page.goto('/heute/gewohnheiten');
  await seedHabit(page, { name: 'Standardfarbe', schedule: 'daily', color: null, archivedAt: null });

  const dot = colorDotFor(page, 'Standardfarbe');
  const lightColor = await dot.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(lightColor).toBe(await resolveColorToken(page, '--area-habits'));

  await page.emulateMedia({ colorScheme: 'dark' });
  const darkColor = await dot.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(darkColor).toBe(await resolveColorToken(page, '--area-habits'));
  // Proves the token actually resolved to dark mode's value, not a frozen literal.
  expect(darkColor).not.toBe(lightColor);
});

test('eine gewählte Eigenfarbe zeigt den passenden Bereichs-Token', async ({ page }) => {
  await page.goto('/heute/gewohnheiten');
  await seedHabit(page, {
    name: 'Eigenfarbe',
    schedule: 'daily',
    color: '--area-journal',
    archivedAt: null,
  });

  const dot = colorDotFor(page, 'Eigenfarbe');
  const color = await dot.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(color).toBe(await resolveColorToken(page, '--area-journal'));
});

test('bei reduzierter Bewegung öffnet das Anlegen-Sheet nur mit einem Opacity-Übergang', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/heute/gewohnheiten');
  await openAddHabit(page);

  const dialog = createDialog(page);
  const transitionProperty = await dialog.evaluate(
    (el) => getComputedStyle(el.firstElementChild as Element).transitionProperty,
  );
  expect(transitionProperty).toBe('opacity');
});

test('bei reduzierter Bewegung ist der Klapp-Übergang des Archiv-Bereichs augenblicklich', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/heute/gewohnheiten');
  await seedHabit(page, {
    name: 'Archiviert & ruhig',
    schedule: 'daily',
    color: null,
    archivedAt: '2026-01-01T00:00:00.000Z',
  });

  const collapse = page.locator('.section-card__collapse');
  const transitionDuration = await collapse.evaluate(
    (el) => getComputedStyle(el).transitionDuration,
  );
  // Chromium serializes very small numbers in exponential notation (e.g. "1e-05s"),
  // so compare the parsed value rather than the exact string.
  expect(parseFloat(transitionDuration)).toBeLessThan(0.001);
});
