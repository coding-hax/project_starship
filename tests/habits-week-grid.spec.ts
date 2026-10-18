import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, skewClock, withDb } from './helpers';

// A Wednesday, same reference date as habits-heute.spec.ts / streaks.spec.ts.
// July 2026 starts on a Wednesday (2 leading blanks, 31 days, 2 trailing
// blanks = 35 grid cells); June 2026 starts on a Monday (0 leading blanks).
const NOW = '2026-07-15T12:00:00.000Z';
const JULY_1 = '2026-07-01';
const JULY_14 = '2026-07-14';
const JULY_15_TODAY = '2026-07-15';
const JUNE_10 = '2026-06-10';

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

function monthGrid(page: Page, habitName: string) {
  return page.getByRole('list', { name: `Monat: ${habitName}` });
}

function habitRow(page: Page, habitName: string) {
  return page
    .getByRole('list', { name: 'Routinen', exact: true })
    .getByRole('listitem')
    .filter({ hasText: habitName });
}

/** The month grid lives in the expanded row body (issue #905 AK4) — every row
 * starts collapsed, so each test expands its own row before reaching for
 * `monthGrid()`. */
async function expandHabit(page: Page, habitName: string): Promise<void> {
  // Not `\b` after the name: `\b` is defined via ASCII `\w`, so it never
  // matches right after a name ending in "ß" or another non-ASCII letter
  // (neither side of that boundary is a "word" character) — the button then
  // silently matches nothing and the click times out (issue #487 AC8, "Maß").
  await habitRow(page, habitName)
    .getByRole('button', { name: new RegExp(`^${habitName}(?:\\s|$)`) })
    .click();
}

/**
 * Addresses a grid cell by its accessible name (day, month, year) instead of
 * position — since #487, leading/trailing cells are real neighbour-month
 * days, so "Nth button" no longer means "Nth of the viewed month".
 */
function dayButton(grid: ReturnType<typeof monthGrid>, day: number, month: string) {
  return grid.getByRole('button', { name: new RegExp(`^${day}\\. ${month} 2026\\b`) });
}

test.beforeEach(async ({ page }) => {
  // resetAppData, not resetDatabase: wiping sessions/credentials forces registerPasskey
  // through a full re-registration every test, and that leaves goto('/routinen')
  // racing session propagation — a stale session redirects to /anmelden, where the app
  // layout (and with it the E2E bridge) never mounts, so window.__starship never appears
  // and the wait below hits its timeout (#120). The stable habit specs (habits-heute,
  // streaks) all reset only app data; this one diverged for no reason. Domain tests need
  // empty rows, not a logged-out browser.
  await resetAppData();
  // The grid must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await registerPasskey(page);
  await skewClock(page, NOW);
  await page.goto('/routinen');
  // The E2E bridge attaches window.__starship from a post-hydration effect
  // (src/ui/e2e-bridge.tsx), which can land after goto's load event. These tests
  // reach for seedHabit → window.__starship.mutate as their very first step, with no
  // UI interaction in between to gate on — so wait for the handle before touching it.
  // Poll on an explicit timer, not the default rAF: skewClock above installed a fake
  // clock (page.clock.setFixedTime), under which rAF is not guaranteed to advance,
  // while ordinary timers keep firing. A condition, not a fixed timeout.
  await page.waitForFunction(() => typeof window.__starship?.mutate === 'function', null, {
    polling: 100,
  });
});

/* -------------------------------------------------------------------------- */
/* AK: Erledigte Tage gefüllt, offene leer — auch in vergangenen Monaten     */
/* -------------------------------------------------------------------------- */

test('erledigte Tage sind gefüllt, offene bleiben leer — auch in vergangenen Monaten (issue #124 AC3)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, {
    name: 'Lesen',
    schedule: 'daily',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: JULY_1, done: true });
  await seedHabitLog(page, { habitId, logDate: JUNE_10, done: true });
  await expandHabit(page, 'Lesen');

  const julyGrid = monthGrid(page, 'Lesen');
  await expect(dayButton(julyGrid, 1, 'Juli')).toHaveClass(/habit-week-grid__day--done/);
  await expect(dayButton(julyGrid, 2, 'Juli')).not.toHaveClass(/habit-week-grid__day--done/);

  await page.getByRole('button', { name: 'Vorheriger Monat' }).click();
  const juneGrid = monthGrid(page, 'Lesen');
  await expect(dayButton(juneGrid, 10, 'Juni')).toHaveClass(/habit-week-grid__day--done/);
  for (const day of [1, 2, 9, 11]) {
    await expect(dayButton(juneGrid, day, 'Juni')).not.toHaveClass(/habit-week-grid__day--done/);
  }
});

/* -------------------------------------------------------------------------- */
/* AK: ein zurückliegender Tag lässt sich nachträglich abhaken/lösen, Outbox  */
/* -------------------------------------------------------------------------- */

test('ein zurückliegender Tag lässt sich nachträglich abhaken und wieder lösen, über die Outbox (issue #124 AC4)', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Meditieren', schedule: 'daily', color: null, archivedAt: null });
  await expandHabit(page, 'Meditieren');
  // July 1 — two weeks before NOW.
  const pastDay = dayButton(monthGrid(page, 'Meditieren'), 1, 'Juli');

  await expect(pastDay).toHaveAttribute('aria-pressed', 'false');
  await pastDay.click();
  await expect(pastDay).toHaveAttribute('aria-pressed', 'true');
  await expect(pastDay).toHaveClass(/habit-week-grid__day--done/);

  await pastDay.click();
  await expect(pastDay).toHaveAttribute('aria-pressed', 'false');
  await expect(pastDay).not.toHaveClass(/habit-week-grid__day--done/);

  // Both taps must upsert the same row, not create a second one (UNIQUE(habit_id, log_date)).
  const entries = await page.evaluate(() => window.__starship.pending());
  const logMutations = entries.filter((entry) => entry.table === 'habit_logs');
  expect(logMutations).toHaveLength(2);
  expect(new Set(logMutations.map((entry) => entry.rowId)).size).toBe(1);
});

test('ein zurückliegender Tag offline getippt erreicht den Server, sobald online (issue #124 AC4)', async ({
  page,
  context,
}) => {
  await seedHabit(page, { name: 'Vitamine', schedule: 'daily', color: null, archivedAt: null });
  await expandHabit(page, 'Vitamine');
  await context.setOffline(true);

  const pastDay = dayButton(monthGrid(page, 'Vitamine'), 1, 'Juli');
  await pastDay.click();
  await expect(pastDay).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(async () => {
      const entries = await page.evaluate(() => window.__starship.pending());
      return entries.filter((entry) => entry.table === 'habit_logs').length;
    })
    .toBe(1);

  // Must unroute before going online: the app's own 'online' listener fires an
  // automatic sync() the instant we go online, and unrouting after that races its
  // in-flight request against the route being torn down — the request never settles (#120).
  await page.unroute('**/api/sync/**');
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  const row = await withDb((client) =>
    client.query(
      'SELECT l.done, l.log_date::text AS log_date FROM habit_logs l ' +
        'JOIN habits h ON h.id = l.habit_id WHERE h.name = $1',
      ['Vitamine'],
    ),
  );
  expect(row.rowCount).toBe(1);
  expect(row.rows[0].done).toBe(true);
  expect(row.rows[0].log_date).toBe(JULY_1);
});

/* -------------------------------------------------------------------------- */
/* AK: Nachträgliches Abhaken schlägt sich sofort in der Streak-Anzeige nieder */
/* -------------------------------------------------------------------------- */

test('nachträgliches Abhaken schlägt sich sofort in der Streak-Anzeige nieder (issue #124 AC7)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, { name: 'Yoga', schedule: 'daily', color: null, archivedAt: null });
  await seedHabitLog(page, { habitId, logDate: JULY_14, done: true });
  await seedHabitLog(page, { habitId, logDate: JULY_15_TODAY, done: true });
  await expandHabit(page, 'Yoga');

  const grid = monthGrid(page, 'Yoga');
  // Check off the two days before that — 12th and 13th — straight from the
  // month grid, extending the streak from 2 to 4.
  await dayButton(grid, 12, 'Juli').click();
  await dayButton(grid, 13, 'Juli').click();

  // A client-side navigation, not a reload — the same liveQuery both screens
  // read from must already reflect the write (due-today.ts's "no fetch needed").
  await page.getByRole('link', { name: 'Übersicht' }).click();
  await expect(
    page.getByRole('list', { name: 'Routinen heute' }).getByLabel('Streak: 4'),
  ).toBeVisible();
});
