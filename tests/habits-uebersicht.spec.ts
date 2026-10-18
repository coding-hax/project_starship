import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, skewClock, withDb } from './helpers';

// A Wednesday, so "the current week" has days on both sides (issue #103).
const NOW = '2026-07-15T12:00:00.000Z';
const MONDAY_THIS_WEEK = '2026-07-13';

function habitTodayItems(page: Page) {
  return page.getByRole('list', { name: 'Routinen heute' }).getByRole('listitem');
}

async function seedHabit(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'habits', op: 'upsert', payload: p }),
    payload,
  );
}

async function seedHabitLog(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'habit_logs', op: 'upsert', payload: p }),
    payload,
  );
}

// beforeEach aborts every /api/sync/** call, so a checked-off log never reaches
// Postgres in this suite (issue #224) — assert against the IndexedDB record the
// E2E bridge exposes instead, sorted so multi-row assertions stay deterministic.
async function habitLogRecords(page: Page, habitId: string) {
  const records = await page.evaluate(() => window.__starship.debugRecords());
  return records
    .filter((r) => r.table === 'habit_logs' && r.data.habitId === habitId)
    .sort((a, b) => String(a.data.logDate).localeCompare(String(b.data.logDate)));
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // The list must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await registerPasskey(page);
  await skewClock(page, NOW);
  // registerPasskey already lands on /uebersicht — navigate once more so every test
  // starts from a clean mount, then seed. Seeding *before* this would reload the
  // page a second time and re-mount SyncBoot mid-test (issue #103, found via the
  // AC4 test racing its own automatic sync).
  await page.goto('/uebersicht');
});

/* -------------------------------------------------------------------------- */
/* AK: Heutige Habits erscheinen; Abhaken markiert sofort erledigt            */
/* -------------------------------------------------------------------------- */

test('erneutes Tippen nimmt nur das heutige Log der wöchentlichen Routine zurück, der Wochen-Hinweis kommt zurück (issue #224 AC4)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, {
    name: 'Großeinkauf',
    schedule: 'weekly',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: MONDAY_THIS_WEEK, done: true });
  const item = habitTodayItems(page).filter({ hasText: 'Großeinkauf' });
  const checkbox = item.getByRole('checkbox');

  await checkbox.click();
  await expect(checkbox).toBeChecked();
  await checkbox.click();

  await expect(checkbox).not.toBeChecked();
  await expect(item).not.toHaveClass(/habit-today__item--done/);
  await expect(item.getByText('Diese Woche schon erledigt')).toBeVisible();

  const logs = await habitLogRecords(page, habitId);
  expect(logs).toEqual([
    expect.objectContaining({ data: expect.objectContaining({ logDate: MONDAY_THIS_WEEK, done: true }) }),
    expect.objectContaining({ data: expect.objectContaining({ logDate: '2026-07-15', done: false }) }),
  ]);
});

/* -------------------------------------------------------------------------- */
/* AK: Erneutes Tippen nimmt die Markierung zurück — kein Doppel-Log          */
/* -------------------------------------------------------------------------- */

test('erneutes Tippen nimmt die Markierung zurück, ohne einen zweiten Log-Eintrag zu erzeugen (issue #103 AC2)', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Meditieren', schedule: 'daily', color: null, archivedAt: null });
  const checkbox = habitTodayItems(page).filter({ hasText: 'Meditieren' }).getByRole('checkbox');

  await checkbox.click();
  await expect(checkbox).toBeChecked();
  await checkbox.click();
  await expect(checkbox).not.toBeChecked();

  const entries = await page.evaluate(() => window.__starship.pending());
  const logMutations = entries.filter((entry) => entry.table === 'habit_logs');
  expect(logMutations).toHaveLength(2);
  // Both mutations target the same row — that is what the UNIQUE(habit_id,
  // log_date) index relies on staying idempotent instead of colliding.
  expect(new Set(logMutations.map((entry) => entry.rowId)).size).toBe(1);
});

/* -------------------------------------------------------------------------- */
/* AK: Offline abhaken -> online -> serverseitig angekommen                   */
/* -------------------------------------------------------------------------- */

test('offline abgehakt erreicht online den Server als habit_log (issue #103 AC4)', async ({
  page,
  context,
}) => {
  await seedHabit(page, { name: 'Vitamine', schedule: 'daily', color: null, archivedAt: null });
  await context.setOffline(true);

  await habitTodayItems(page).filter({ hasText: 'Vitamine' }).getByRole('checkbox').click();
  await expect(
    habitTodayItems(page).filter({ hasText: 'Vitamine' }).getByRole('checkbox'),
  ).toBeChecked();
  // Not `size()` — seeding above already queued its own (unrelated) 'habits'
  // mutation, so only the habit_logs side of the outbox is asserted here.
  await expect
    .poll(async () => {
      const entries = await page.evaluate(() => window.__starship.pending());
      return entries.filter((entry) => entry.table === 'habit_logs').length;
    })
    .toBe(1);

  // beforeEach cuts the sync endpoints so the list can only ever come from
  // IndexedDB — lift that here to let the queued mutations actually reach Postgres.
  await page.unroute('**/api/sync/**');
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  const row = await withDb((client) =>
    client.query(
      'SELECT l.done FROM habit_logs l JOIN habits h ON h.id = l.habit_id WHERE h.name = $1',
      ['Vitamine'],
    ),
  );
  expect(row.rowCount).toBe(1);
  expect(row.rows[0].done).toBe(true);
});
