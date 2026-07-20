import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetDatabase, skewClock } from './helpers';

// A Wednesday, same reference date as habits-heute.spec.ts.
const NOW = '2026-07-15T12:00:00.000Z';
const TODAY = '2026-07-15';
const YESTERDAY = '2026-07-14';
const TWO_DAYS_AGO = '2026-07-13';
const TOMORROW = '2026-07-16T12:00:00.000Z'; // skewed to after skipping TODAY

const MONDAY_THIS_WEEK = '2026-07-13';
const MONDAY_LAST_WEEK = '2026-07-06';
const MONDAY_TWO_WEEKS_AGO = '2026-06-29';

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
  await resetDatabase();
  // The list must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await registerPasskey(page);
  await skewClock(page, NOW);
  await page.goto('/heute');
});

/* -------------------------------------------------------------------------- */
/* AK: daily — 3 Tage in Folge -> Streak 3; ausgelassener Tag -> kein Streak  */
/* -------------------------------------------------------------------------- */

test('drei aufeinanderfolgende Tage zeigen Streak 3 (issue #104 AC1)', async ({ page }) => {
  const habitId = await seedHabit(page, { name: 'Yoga', schedule: 'daily', color: null, archivedAt: null });
  await seedHabitLog(page, { habitId, logDate: TWO_DAYS_AGO, done: true });
  await seedHabitLog(page, { habitId, logDate: YESTERDAY, done: true });
  await seedHabitLog(page, { habitId, logDate: TODAY, done: true });

  const item = habitTodayItems(page).filter({ hasText: 'Yoga' });
  await expect(item.getByLabel('Streak: 3')).toBeVisible();
});

test('ein ausgelassener Tag zeigt keinen Streak (issue #104 AC1)', async ({ page }) => {
  const habitId = await seedHabit(page, {
    name: 'Ohne Serie',
    schedule: 'daily',
    color: null,
    archivedAt: null,
  });
  // Two days ago is done, but yesterday was skipped — no streak reaches today.
  await seedHabitLog(page, { habitId, logDate: TWO_DAYS_AGO, done: true });

  const item = habitTodayItems(page).filter({ hasText: 'Ohne Serie' });
  await expect(item).toBeVisible();
  await expect(item.locator('.habit-today__streak')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* AK: Tageswechsel bricht die Serie nicht, solange gestern erledigt war      */
/* -------------------------------------------------------------------------- */

test('heute noch offen bricht die Serie nicht, solange gestern erledigt war (issue #104 AC2)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, {
    name: 'Dehnen',
    schedule: 'daily',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: YESTERDAY, done: true });

  const item = habitTodayItems(page).filter({ hasText: 'Dehnen' });
  await expect(item.getByLabel('Streak: 1')).toBeVisible();
});

test('wird der offene Tag übersprungen, ist die Serie am nächsten Tag weg (issue #104 AC2)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, {
    name: 'Dehnen',
    schedule: 'daily',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: YESTERDAY, done: true });

  // The day that was open (TODAY) passes without ever being checked off — the
  // clock moves on to the next calendar day, as it would after reopening the
  // PWA the next morning (page.clock, not a running timer, per #75's helper).
  await skewClock(page, TOMORROW);
  await page.reload();

  const item = habitTodayItems(page).filter({ hasText: 'Dehnen' });
  await expect(item).toBeVisible();
  await expect(item.locator('.habit-today__streak')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* AK: weekly — zwei Wochen in Folge -> Streak 2; ausgelassene Woche -> Reset */
/* -------------------------------------------------------------------------- */

test('zwei aufeinanderfolgende Wochen zeigen Streak 2 (issue #104 AC3)', async ({ page }) => {
  const habitId = await seedHabit(page, {
    name: 'Großputz',
    schedule: 'weekly',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: MONDAY_LAST_WEEK, done: true });
  await seedHabitLog(page, { habitId, logDate: MONDAY_THIS_WEEK, done: true });

  const item = habitTodayItems(page).filter({ hasText: 'Großputz' });
  await expect(item.getByLabel('Streak: 2')).toBeVisible();
});

test('eine ausgelassene Woche setzt die Serie zurück (issue #104 AC3)', async ({ page }) => {
  const habitId = await seedHabit(page, {
    name: 'Fenster putzen',
    schedule: 'weekly',
    color: null,
    archivedAt: null,
  });
  // Two weeks ago and this week are done, but last week was skipped.
  await seedHabitLog(page, { habitId, logDate: MONDAY_TWO_WEEKS_AGO, done: true });
  await seedHabitLog(page, { habitId, logDate: MONDAY_THIS_WEEK, done: true });

  const item = habitTodayItems(page).filter({ hasText: 'Fenster putzen' });
  await expect(item.getByLabel('Streak: 1')).toBeVisible();
});
