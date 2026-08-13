import { expect, test, type Page } from '@playwright/test';
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
 * Opens the editor by hitting the habit's name button.
 *
 * Clicking the list item itself used to work while the item was a single row, but
 * since #105 it also holds the week grid — so the item's centre point lands on a
 * day cell and toggles a log instead of opening the editor. The regex is anchored
 * so it matches the name button ("Joggen Wöchentlich") and not the seven grid
 * buttons, whose accessible names read "Mo: Joggen offen".
 */
async function tapHabit(page: Page, name: string) {
  await habitItems(page)
    .filter({ hasText: name })
    .getByRole('button', { name: new RegExp(`^${name}\\b`) })
    .click();
}

async function seedHabit(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'habits', op: 'upsert', payload: p }),
    payload,
  );
}

/** Mirrors JOURNAL_HABIT_ID in src/features/journal/journal-habit.ts (issue #505). */
const JOURNAL_HABIT_ID = '5b5c9dc3-25c8-4f97-a4c5-61cb4c736c80';

async function seedJournalHabit(page: Page, overrides: Record<string, unknown> = {}): Promise<void> {
  await page.evaluate(
    (p) =>
      window.__starship.mutate({
        table: 'habits',
        rowId: p.rowId,
        op: 'upsert',
        payload: p.payload,
      }),
    {
      rowId: JOURNAL_HABIT_ID,
      payload: {
        name: 'Journal',
        schedule: 'daily',
        color: '--area-journal',
        archivedAt: null,
        ...overrides,
      },
    },
  );
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // The list must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8) —
  // with the sync endpoints cut, that is the only way any of these tests can pass.
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await registerPasskey(page);
});

test('ein designter Leerzustand statt eines leeren Screens', async ({ page }) => {
  await page.goto('/routinen');
  await expect(page.getByText('Keine Routinen. Leg deine erste an.')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* issue #645: Offline-Notiz                                                  */
/* -------------------------------------------------------------------------- */

test('die Routinen bleiben offline sichtbar, mit einer ruhigen Notiz statt eines Fehlers (issue #645 AC1)', async ({
  page,
  context,
}) => {
  await page.goto('/routinen');
  await seedHabit(page, { name: 'Bleibt da', schedule: 'daily', color: null, archivedAt: null });
  await expect(habitItems(page).filter({ hasText: 'Bleibt da' })).toBeVisible();

  await context.setOffline(true);

  // A calm status note, not a red alert — nothing here uses role="alert".
  await expect(page.getByRole('status')).toContainText('Offline');
  await expect(habitItems(page).filter({ hasText: 'Bleibt da' })).toBeVisible();

  await context.setOffline(false);
});

test('die Offline-Notiz bei den Routinen verschwindet nach dem Onlinegehen wieder, ohne Neuladen (issue #645 AC2)', async ({
  page,
  context,
}) => {
  await page.goto('/routinen');

  await context.setOffline(true);
  await expect(page.getByRole('status')).toContainText('Offline');

  await context.setOffline(false);

  await expect(page.getByRole('status')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* AK: Habit mit Name + Schedule anlegen; erscheint in der Liste              */
/* -------------------------------------------------------------------------- */

test('eine per FAB angelegte Routine erscheint sofort in der Liste', async ({ page }) => {
  await page.goto('/routinen');
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
  await page.goto('/routinen');
  await openAddHabit(page);

  await createDialog(page).getByRole('button', { name: 'Anlegen' }).click();

  await expect(createDialog(page)).toBeVisible();
  await expect(nameField(page)).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
});

test('Rhythmus „Täglich" ist der Standard, wenn nichts anderes gewählt wird', async ({ page }) => {
  await page.goto('/routinen');
  await openAddHabit(page);
  await nameField(page).fill('Meditieren');
  await createDialog(page).getByRole('button', { name: 'Anlegen' }).click();

  await expect(habitItems(page).filter({ hasText: 'Meditieren' })).toContainText('Täglich');
});

/* -------------------------------------------------------------------------- */
/* AK: Tippen auf den Rhythmus stiehlt dem Namensfeld nicht den Fokus (#138)  */
/* -------------------------------------------------------------------------- */

test('Tippen auf den Rhythmus lässt Fokus und Cursor im Namensfeld, Weitertippen hängt an statt zu ersetzen (#138)', async ({
  page,
}) => {
  await page.goto('/routinen');
  await openAddHabit(page);

  await nameField(page).pressSequentially('Wasser');
  await createDialog(page).getByRole('radio', { name: 'Wöchentlich' }).click();

  await expect(nameField(page)).toBeFocused();
  await expect(createDialog(page).getByRole('radio', { name: 'Wöchentlich' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  await page.keyboard.type(' trinken');
  await expect(nameField(page)).toHaveValue('Wasser trinken');

  await createDialog(page).getByRole('button', { name: 'Anlegen' }).click();
  await expect(createDialog(page)).toBeHidden();
  const item = habitItems(page).filter({ hasText: 'Wasser trinken' });
  await expect(item).toBeVisible();
  await expect(item).toContainText('Wöchentlich');
});

test('Tastaturbedienung des Rhythmus bleibt unverändert: Tab erreicht die Auswahl, Pfeiltasten verschieben Fokus und Auswahl (#138)', async ({
  page,
}) => {
  await page.goto('/routinen');
  await openAddHabit(page);
  await nameField(page).fill('Lesen');

  await page.keyboard.press('Tab');
  await expect(createDialog(page).getByRole('radio', { name: 'Täglich' })).toBeFocused();

  await page.keyboard.press('ArrowRight');
  const weekly = createDialog(page).getByRole('radio', { name: 'Wöchentlich' });
  await expect(weekly).toBeFocused();
  await expect(weekly).toHaveAttribute('aria-checked', 'true');
});

/* -------------------------------------------------------------------------- */
/* AK: Neue Rhythmen — 1–6× pro Woche, zweiwöchentlich, monatlich, …          */
/* (issue #509 AC1, AC7)                                                      */
/* -------------------------------------------------------------------------- */

test('die Rhythmus-Auswahl bietet alle sechs Perioden an (issue #509 AC1)', async ({ page }) => {
  await page.goto('/routinen');
  await openAddHabit(page);

  const dialog = createDialog(page);
  for (const label of [
    'Täglich',
    'Wöchentlich',
    'Alle zwei Wochen',
    'Monatlich',
    'Quartalsweise',
    'Jährlich',
  ]) {
    await expect(dialog.getByRole('radio', { name: label })).toBeVisible();
  }
});

test('der Ziel-Zähler erscheint nur bei „Wöchentlich" und speichert den gewählten Wert (issue #509 AC1)', async ({
  page,
}) => {
  await page.goto('/routinen');
  await openAddHabit(page);
  const dialog = createDialog(page);

  await expect(dialog.getByRole('radiogroup', { name: 'Wie oft pro Woche' })).toHaveCount(0);

  await nameField(page).fill('Laufen');
  await dialog.getByRole('radio', { name: 'Wöchentlich' }).check();
  const counter = dialog.getByRole('radiogroup', { name: 'Wie oft pro Woche' });
  await expect(counter).toBeVisible();
  await counter.getByRole('radio', { name: '3' }).click();

  await dialog.getByRole('button', { name: 'Anlegen' }).click();
  await expect(dialog).toBeHidden();

  const entries = await page.evaluate(() => window.__starship.pending());
  const last = entries[entries.length - 1];
  expect(last.payload).toMatchObject({ schedule: 'weekly', target: 3 });

  const item = habitItems(page).filter({ hasText: 'Laufen' });
  await expect(item).toContainText('3× pro Woche');
});

test('wechselt man von „Wöchentlich" zu einer anderen Periode, verschwindet der Zähler und target bleibt 1 (issue #509)', async ({
  page,
}) => {
  await page.goto('/routinen');
  await openAddHabit(page);
  const dialog = createDialog(page);

  await nameField(page).fill('Großputz');
  await dialog.getByRole('radio', { name: 'Wöchentlich' }).check();
  await dialog.getByRole('radiogroup', { name: 'Wie oft pro Woche' }).getByRole('radio', { name: '5' }).click();
  await dialog.getByRole('radio', { name: 'Monatlich' }).check();

  await expect(dialog.getByRole('radiogroup', { name: 'Wie oft pro Woche' })).toHaveCount(0);

  await dialog.getByRole('button', { name: 'Anlegen' }).click();
  await expect(dialog).toBeHidden();

  const entries = await page.evaluate(() => window.__starship.pending());
  const last = entries[entries.length - 1];
  expect(last.payload).toMatchObject({ schedule: 'monthly', target: 1 });
});

test('Tippen auf eine andere Periode lässt den Fokus im Namensfeld (Erweiterung von #138 auf issue #509)', async ({
  page,
}) => {
  await page.goto('/routinen');
  await openAddHabit(page);

  await nameField(page).pressSequentially('Vitamine');
  await createDialog(page).getByRole('radio', { name: 'Monatlich' }).click();

  await expect(nameField(page)).toBeFocused();
  await expect(createDialog(page).getByRole('radio', { name: 'Monatlich' })).toBeChecked();

  await page.keyboard.type('!');
  await expect(nameField(page)).toHaveValue('Vitamine!');
});

test('eine Routine ohne target-Feld aus der Zeit vor #509 zeigt sich unverändert als „Wöchentlich" (AC7)', async ({
  page,
}) => {
  await page.goto('/routinen');
  // No `target` key at all — simulates a record synced before this migration.
  await seedHabit(page, { name: 'Alte Routine', schedule: 'weekly', color: null, archivedAt: null });

  const item = habitItems(page).filter({ hasText: 'Alte Routine' });
  await expect(item).toContainText('Wöchentlich');
  await expect(item).not.toContainText('×');

  await tapHabit(page, 'Alte Routine');
  const dialog = editDialog(page);
  await expect(dialog.getByRole('radio', { name: 'Wöchentlich' })).toBeChecked();
  await expect(dialog.getByRole('radiogroup', { name: 'Wie oft pro Woche' }).getByRole('radio', { name: '1' })).toBeChecked();
});

/* -------------------------------------------------------------------------- */
/* AK: Bearbeiten und Archivieren funktionieren; archivierte verschwinden     */
/* -------------------------------------------------------------------------- */

test('Tippen auf eine Routine öffnet den Editor mit Name und Rhythmus', async ({ page }) => {
  await page.goto('/routinen');
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
  await page.goto('/routinen');
  await seedHabit(page, { name: 'Lesen', schedule: 'daily', color: null, archivedAt: null });

  await tapHabit(page, 'Lesen');
  const dialog = editDialog(page);
  await dialog.getByRole('radio', { name: 'Wöchentlich' }).check();
  await dialog.getByRole('button', { name: 'Sichern' }).click();
  await expect(dialog).toBeHidden();

  const entries = await page.evaluate(() => window.__starship.pending());
  const last = entries[entries.length - 1];
  expect(last.op).toBe('upsert');
  expect(last.payload).toEqual({ schedule: 'weekly' });
});

test('eine Farbe wählen und speichern setzt die Eigenfarbe der Routine', async ({ page }) => {
  await page.goto('/routinen');
  await seedHabit(page, { name: 'Dehnen', schedule: 'daily', color: null, archivedAt: null });

  await tapHabit(page, 'Dehnen');
  const dialog = editDialog(page);
  await dialog.getByRole('radio', { name: 'Koralle' }).check();
  await dialog.getByRole('button', { name: 'Sichern' }).click();
  await expect(dialog).toBeHidden();

  const entries = await page.evaluate(() => window.__starship.pending());
  const last = entries[entries.length - 1];
  expect(last.payload).toEqual({ color: '--area-tasks' });
});

/* -------------------------------------------------------------------------- */
/* issue #658: Farbwähler von 4 auf 10 Swatches, Raster 5x2                   */
/* -------------------------------------------------------------------------- */

const COLOR_LABELS_658 = [
  'Grün (Standard)',
  'Koralle',
  'Teal',
  'Violett',
  'Blau',
  'Rosé',
  'Bernstein',
  'Limette',
  'Himmelblau',
  'Magenta',
];

test('der Farbwähler zeigt genau zehn Optionen in der festgelegten Reihenfolge (issue #658 AC1)', async ({
  page,
}) => {
  await page.goto('/routinen');
  await seedHabit(page, { name: 'Zehn Farben', schedule: 'daily', color: null, archivedAt: null });

  await tapHabit(page, 'Zehn Farben');
  const dialog = editDialog(page);
  const radios = dialog.locator('.habit-editor__colors').getByRole('radio');
  await expect(radios).toHaveCount(10);

  const names = await radios.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
  expect(names).toEqual(COLOR_LABELS_658);
});

test('die Farboptionen sind per Pfeiltasten innerhalb der Radiogruppe erreichbar (issue #658 AC4)', async ({
  page,
}) => {
  await page.goto('/routinen');
  await seedHabit(page, { name: 'Pfeiltasten-Farbe', schedule: 'daily', color: null, archivedAt: null });

  await tapHabit(page, 'Pfeiltasten-Farbe');
  const dialog = editDialog(page);
  await dialog.getByRole('radio', { name: 'Grün (Standard)' }).focus();

  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('radio', { name: 'Koralle' })).toBeChecked();

  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('radio', { name: 'Teal' })).toBeChecked();
});

test('jede Farboption hat eine Trefferfläche von mindestens 44×44px (issue #658 AC5, 375×812)', async ({
  page,
}) => {
  await page.goto('/routinen');
  await seedHabit(page, { name: 'Trefferfläche', schedule: 'daily', color: null, archivedAt: null });

  await tapHabit(page, 'Trefferfläche');
  const dialog = editDialog(page);
  const options = dialog.locator('.habit-editor__color-option');
  await expect(options).toHaveCount(10);

  const boxes = await options.evaluateAll((els) =>
    els.map((el) => {
      const rect = el.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }),
  );
  for (const box of boxes) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
});

test('eine neu gewählte Farbe (--swatch-lime) übersteht einen Reload und erscheint in der Liste (issue #658 AC7)', async ({
  page,
}) => {
  await page.goto('/routinen');
  await seedHabit(page, { name: 'Limette wählen', schedule: 'daily', color: null, archivedAt: null });

  await tapHabit(page, 'Limette wählen');
  const dialog = editDialog(page);
  await dialog.getByRole('radio', { name: 'Limette' }).check();
  await dialog.getByRole('button', { name: 'Sichern' }).click();
  await expect(dialog).toBeHidden();

  await page.reload();

  const dot = colorDotFor(page, 'Limette wählen');
  await expect(dot).toBeVisible();
  const color = await dot.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(color).toBe(await resolveColorToken(page, '--swatch-lime'));
});

test('eine Farbe offline geändert kommt nach dem Onlinegehen serverseitig an (issue #658 AC8)', async ({
  page,
  context,
}) => {
  await page.goto('/routinen');
  await seedHabit(page, { name: 'Farbe offline ändern', schedule: 'daily', color: null, archivedAt: null });
  await context.setOffline(true);

  await tapHabit(page, 'Farbe offline ändern');
  const dialog = editDialog(page);
  await dialog.getByRole('radio', { name: 'Himmelblau' }).check();
  await dialog.getByRole('button', { name: 'Sichern' }).click();
  await expect(dialog).toBeHidden();
  // One entry for the seed, one for the colour change — both queued offline.
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(2);

  // Order matters here — see the comment at the equivalent point above (#120).
  await page.unroute('**/api/sync/**');
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  const row = await withDb((client) =>
    client.query('SELECT color FROM habits WHERE name = $1', ['Farbe offline ändern']),
  );
  expect(row.rows[0].color).toBe('--swatch-sky');
});

test('Archivieren entfernt die Routine aus der aktiven Liste und zeigt einen Undo-Toast', async ({
  page,
}) => {
  await page.goto('/routinen');
  await seedHabit(page, { name: 'Tagebuch', schedule: 'daily', color: null, archivedAt: null });
  const item = habitItems(page).filter({ hasText: 'Tagebuch' });
  await expect(item).toBeVisible();

  await item.getByRole('button', { name: 'Archivieren', exact: true }).click();

  await expect(item).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'archiviert' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeVisible();

  await expandArchived(page);
  await expect(archivedHabitItems(page).filter({ hasText: 'Tagebuch' })).toBeVisible();
});

test('der Undo-Toast beim Archivieren macht es rückgängig, die Routine ist wieder aktiv', async ({
  page,
}) => {
  await page.goto('/routinen');
  await seedHabit(page, { name: 'Stretching', schedule: 'daily', color: null, archivedAt: null });
  const item = habitItems(page).filter({ hasText: 'Stretching' });

  await item.getByRole('button', { name: 'Archivieren', exact: true }).click();
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

  await archivedItem.getByRole('button', { name: 'Reaktivieren' }).click();

  await expect(habitItems(page).filter({ hasText: 'Alte Routine' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* issue #505 AC2/AC3: die Journal-Routine ist fest — kein Archivieren,    */
/* Editor zeigt nur den Rhythmus                                              */
/* -------------------------------------------------------------------------- */

test('die Journal-Routine hat keinen Archivieren-Button, eine normale Routine weiterhin (issue #505 AC2)', async ({
  page,
}) => {
  await page.goto('/routinen');
  await seedJournalHabit(page);
  await seedHabit(page, { name: 'Joggen', schedule: 'daily', color: null, archivedAt: null });

  const journalItem = habitItems(page).filter({ hasText: 'Journal' });
  await expect(journalItem).toBeVisible();
  await expect(journalItem.getByRole('button', { name: /^(Archivieren|Reaktivieren)$/ })).toHaveCount(0);

  const joggenItem = habitItems(page).filter({ hasText: 'Joggen' });
  await expect(joggenItem.getByRole('button', { name: 'Archivieren', exact: true })).toBeVisible();
});

test('der Editor der Journal-Routine zeigt nur den Rhythmus, kein Namens- oder Farbfeld (issue #505 AC3)', async ({
  page,
}) => {
  await page.goto('/routinen');
  await seedJournalHabit(page);

  await tapHabit(page, 'Journal');
  const dialog = editDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveCount(0);
  await expect(dialog.locator('.habit-editor__colors')).toHaveCount(0);
  await expect(dialog.getByRole('radio', { name: 'Täglich' })).toBeChecked();

  await dialog.getByRole('radio', { name: 'Wöchentlich' }).check();
  await dialog.getByRole('button', { name: 'Sichern' }).click();
  await expect(dialog).toBeHidden();

  const entries = await page.evaluate(() => window.__starship.pending());
  const last = entries[entries.length - 1];
  expect(last.op).toBe('upsert');
  expect(last.payload).toEqual({ schedule: 'weekly' });
});

/* -------------------------------------------------------------------------- */
/* AK: Offline anlegen -> online -> serverseitig angekommen                   */
/* -------------------------------------------------------------------------- */

test('offline angelegt: sofort sichtbar, genau ein Eintrag in der Outbox', async ({
  page,
  context,
}) => {
  await page.goto('/routinen');
  await context.setOffline(true);

  await openAddHabit(page);
  await nameField(page).fill('Im Zug gestreckt');
  await createDialog(page).getByRole('button', { name: 'Anlegen' }).click();

  await expect(habitItems(page).filter({ hasText: 'Im Zug gestreckt' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  await context.setOffline(false);
});

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

  await tapHabit(page, 'Rhythmus wechseln');
  const dialog = editDialog(page);
  await dialog.getByRole('radio', { name: 'Wöchentlich' }).check();
  await dialog.getByRole('radiogroup', { name: 'Wie oft pro Woche' }).getByRole('radio', { name: '4' }).click();
  await dialog.getByRole('button', { name: 'Sichern' }).click();
  await expect(dialog).toBeHidden();

  const item = habitItems(page).filter({ hasText: 'Rhythmus wechseln' });
  await expect(item).toContainText('4× pro Woche');
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

test('eine Routine ohne Eigenfarbe zeigt den Standard-Token --area-habits, auch im Dark Mode', async ({
  page,
}) => {
  await page.goto('/routinen');
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
  await page.goto('/routinen');
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

test('alle zehn Swatch-Hintergrundfarben sind paarweise verschieden und von --surface unterscheidbar, hell und dunkel (issue #658 AC3)', async ({
  page,
}) => {
  await page.goto('/routinen');
  await seedHabit(page, { name: 'Farbvergleich', schedule: 'daily', color: null, archivedAt: null });

  await tapHabit(page, 'Farbvergleich');
  const dialog = editDialog(page);
  const swatches = dialog.locator('.habit-editor__color-swatch');
  await expect(swatches).toHaveCount(10);

  async function readSwatchesAndSurface() {
    const colors = await swatches.evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
    const surface = await resolveColorToken(page, '--surface');
    return { colors, surface };
  }

  const light = await readSwatchesAndSurface();
  expect(new Set(light.colors).size).toBe(10);
  for (const color of light.colors) {
    expect(color).not.toBe('rgba(0, 0, 0, 0)');
    expect(color).not.toBe(light.surface);
  }

  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dunkel'));
  const dark = await readSwatchesAndSurface();
  expect(new Set(dark.colors).size).toBe(10);
  for (const color of dark.colors) {
    expect(color).not.toBe('rgba(0, 0, 0, 0)');
    expect(color).not.toBe(dark.surface);
  }
});

test('eine Routine auf --area-tasks bleibt nach der Erweiterung auf zehn Farben in Koralle, Editor zeigt genau Swatch 2 ausgewählt (issue #658 AC6)', async ({
  page,
}) => {
  await page.goto('/routinen');
  await seedHabit(page, { name: 'Bestandsfarbe', schedule: 'daily', color: '--area-tasks', archivedAt: null });

  const dot = colorDotFor(page, 'Bestandsfarbe');
  const rowColor = await dot.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(rowColor).toBe(await resolveColorToken(page, '--area-tasks'));

  await tapHabit(page, 'Bestandsfarbe');
  const dialog = editDialog(page);
  await expect(dialog.getByRole('radio', { name: 'Koralle' })).toBeChecked();
  const checkedCount = await dialog.locator('.habit-editor__colors input:checked').count();
  expect(checkedCount).toBe(1);
});

test('bei reduzierter Bewegung öffnet das Anlegen-Sheet nur mit einem Opacity-Übergang', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/routinen');
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
  await page.goto('/routinen');
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

/* -------------------------------------------------------------------------- */
/* AK: Abstand zwischen aktiver Liste und Archiv-Block (issue #486)          */
/* -------------------------------------------------------------------------- */

test('der Abstand zwischen letzter aktiver Routine und Archiv-Block ist größer als der Abstand zwischen zwei Routinenkarten', async ({
  page,
}) => {
  await page.goto('/routinen');
  await seedHabit(page, { name: 'Aktiv 1', schedule: 'daily', color: null, archivedAt: null });
  await seedHabit(page, {
    name: 'Archiviert 1',
    schedule: 'daily',
    color: null,
    archivedAt: '2026-01-01T00:00:00.000Z',
  });

  const listItems = habitItems(page);
  const lastActiveItem = listItems.last();
  const archivedSection = page.locator('.section-card');

  await expect.poll(() => lastActiveItem.evaluate((el) => el.getAnimations().some((a) => a.playState === 'running'))).toBe(false);

  const lastActiveRect = await lastActiveItem.boundingBox();
  const archivedRect = await archivedSection.boundingBox();

  if (lastActiveRect && archivedRect) {
    const spacingBetween = archivedRect.y - (lastActiveRect.y + lastActiveRect.height);
    // --space-6 = 24px
    expect(spacingBetween).toBeGreaterThanOrEqual(24);
  }
});

test('der Abstand zum Archiv-Block existiert auch bei fehlenden aktiven Routinen', async ({
  page,
}) => {
  await page.goto('/routinen');
  await seedHabit(page, {
    name: 'Nur archiviert',
    schedule: 'daily',
    color: null,
    archivedAt: '2026-01-01T00:00:00.000Z',
  });

  const emptyMessage = page.getByText('Keine aktiven Routinen.');
  const archivedSection = page.locator('.section-card');

  await expect.poll(() => archivedSection.evaluate((el) => el.getAnimations().some((a) => a.playState === 'running'))).toBe(false);

  const emptyRect = await emptyMessage.boundingBox();
  const archivedRect = await archivedSection.boundingBox();

  if (emptyRect && archivedRect) {
    const spacingBetween = archivedRect.y - (emptyRect.y + emptyRect.height);
    // --space-6 = 24px
    expect(spacingBetween).toBeGreaterThanOrEqual(24);
  }
});
