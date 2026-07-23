import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, skewClock, withDb } from './helpers';

// A Wednesday, so "the current week" has days on both sides (issue #103).
const NOW = '2026-07-15T12:00:00.000Z';
const MONDAY_THIS_WEEK = '2026-07-13';
const LAST_MONDAY = '2026-07-06';

function habitTodayItems(page: Page) {
  return page.getByRole('list', { name: 'Gewohnheiten heute' }).getByRole('listitem');
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

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // The list must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await registerPasskey(page);
  await skewClock(page, NOW);
  // registerPasskey already lands on /heute — navigate once more so every test
  // starts from a clean mount, then seed. Seeding *before* this would reload the
  // page a second time and re-mount SyncBoot mid-test (issue #103, found via the
  // AC4 test racing its own automatic sync).
  await page.goto('/heute');
});

/* -------------------------------------------------------------------------- */
/* AK: Heutige Habits erscheinen; Abhaken markiert sofort erledigt            */
/* -------------------------------------------------------------------------- */

test('eine tägliche Gewohnheit erscheint in der Heute-Sektion und lässt sich abhaken (issue #103 AC1)', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Wasser trinken', schedule: 'daily', color: null, archivedAt: null });

  const item = habitTodayItems(page).filter({ hasText: 'Wasser trinken' });
  await expect(item).toBeVisible();
  await expect(item.getByRole('checkbox')).not.toBeChecked();

  await item.getByRole('checkbox').click();

  await expect(item.getByRole('checkbox')).toBeChecked();
  await expect(item).toHaveClass(/habit-today__item--done/);
});

test('eine wöchentliche Gewohnheit ohne Log in dieser Woche erscheint ebenfalls', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Joggen', schedule: 'weekly', color: null, archivedAt: null });

  await expect(habitTodayItems(page).filter({ hasText: 'Joggen' })).toBeVisible();
});

test('eine wöchentliche Gewohnheit, die diese Woche schon erledigt wurde, erscheint heute nicht mehr', async ({
  page,
}) => {
  const habitId = await seedHabit(page, {
    name: 'Großeinkauf',
    schedule: 'weekly',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: MONDAY_THIS_WEEK, done: true });

  await expect(habitTodayItems(page).filter({ hasText: 'Großeinkauf' })).toHaveCount(0);
});

test('eine wöchentliche Gewohnheit, die letzte Woche erledigt wurde, ist diese Woche wieder fällig', async ({
  page,
}) => {
  const habitId = await seedHabit(page, {
    name: 'Wohnung putzen',
    schedule: 'weekly',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: LAST_MONDAY, done: true });

  await expect(habitTodayItems(page).filter({ hasText: 'Wohnung putzen' })).toBeVisible();
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
/* AK: Nach Reload/Sync bleibt der heutige Stand erhalten                     */
/* -------------------------------------------------------------------------- */

test('der abgehakte Stand bleibt nach einem Reload erhalten (issue #103 AC3)', async ({ page }) => {
  await seedHabit(page, { name: 'Lesen', schedule: 'daily', color: null, archivedAt: null });
  await habitTodayItems(page).filter({ hasText: 'Lesen' }).getByRole('checkbox').click();
  await expect(
    habitTodayItems(page).filter({ hasText: 'Lesen' }).getByRole('checkbox'),
  ).toBeChecked();

  await skewClock(page, NOW);
  await page.reload();

  await expect(
    habitTodayItems(page).filter({ hasText: 'Lesen' }).getByRole('checkbox'),
  ).toBeChecked();
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

/* -------------------------------------------------------------------------- */
/* Leerzustand, wenn keine Habits existieren (Verweis auf Verwaltung, #102)   */
/* -------------------------------------------------------------------------- */

test('ohne Gewohnheiten zeigt die Heute-Sektion einen Leerzustand mit Verweis auf die Verwaltung', async ({
  page,
}) => {
  await expect(page.getByText('Noch keine Gewohnheiten.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Jetzt anlegen' })).toHaveAttribute(
    'href',
    '/gewohnheiten',
  );
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

test('eine Gewohnheit ohne Eigenfarbe zeigt den Standard-Token --area-habits, auch im Dark Mode (issue #103 AC5)', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Standardfarbe', schedule: 'daily', color: null, archivedAt: null });

  const dot = habitTodayItems(page)
    .filter({ hasText: 'Standardfarbe' })
    .locator('.habit-today__color');
  const lightColor = await dot.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(lightColor).toBe(await resolveColorToken(page, '--area-habits'));

  await page.emulateMedia({ colorScheme: 'dark' });
  const darkColor = await dot.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(darkColor).toBe(await resolveColorToken(page, '--area-habits'));
  expect(darkColor).not.toBe(lightColor);
});

test('bei reduzierter Bewegung ist die Abhak-Animation augenblicklich (issue #103 AC5)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await seedHabit(page, { name: 'Ruhig abhaken', schedule: 'daily', color: null, archivedAt: null });

  const item = habitTodayItems(page).filter({ hasText: 'Ruhig abhaken' });
  const transitionDuration = await item.evaluate((el) => getComputedStyle(el).transitionDuration);
  // Chromium serializes very small numbers in exponential notation (e.g. "1e-05s"),
  // so compare the parsed value rather than the exact string.
  expect(parseFloat(transitionDuration)).toBeLessThan(0.001);
});

test('die Abhak-Animation bewegt ausschließlich Opacity/Scale, keine Layout-Eigenschaften (issue #103 AC5)', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Sanft', schedule: 'daily', color: null, archivedAt: null });

  const item = habitTodayItems(page).filter({ hasText: 'Sanft' });
  const itemTransitionProperty = await item.evaluate(
    (el) => getComputedStyle(el).transitionProperty,
  );
  expect(itemTransitionProperty).toBe('opacity');

  const checkboxTransitionProperty = await item
    .getByRole('checkbox')
    .evaluate((el) => getComputedStyle(el).transitionProperty);
  expect(checkboxTransitionProperty).toBe('transform');
});
