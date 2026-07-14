import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetDatabase } from './helpers';

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
