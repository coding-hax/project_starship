import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, seedHabitFreeze, skewClock } from './helpers';

// A Wednesday, same reference date as habits-heute.spec.ts.
const NOW = '2026-07-15T12:00:00.000Z';
const TODAY = '2026-07-15';
const YESTERDAY = '2026-07-14';
const TWO_DAYS_AGO = '2026-07-13';
const TOMORROW = '2026-07-16T12:00:00.000Z'; // skewed to after skipping TODAY

const MONDAY_LAST_WEEK = '2026-07-06';
const MONDAY_TWO_WEEKS_AGO = '2026-06-29';

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

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // The list must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await registerPasskey(page);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');
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
  // Logged *today* rather than on Monday — a weekly habit done earlier in the
  // current week (but not today) drops out of the Übersicht-Sektion entirely
  // (issue #103), so a today-log is the only way the row — and its streak —
  // stays visible for this week's completion.
  await seedHabitLog(page, { habitId, logDate: TODAY, done: true });

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
  // Two weeks ago and this week (logged today, see the test above) are done,
  // but last week was skipped.
  await seedHabitLog(page, { habitId, logDate: MONDAY_TWO_WEEKS_AGO, done: true });
  await seedHabitLog(page, { habitId, logDate: TODAY, done: true });

  const item = habitTodayItems(page).filter({ hasText: 'Fenster putzen' });
  await expect(item.getByLabel('Streak: 1')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* AK: beliebige Perioden — Streak zählt Perioden mit erreichtem target       */
/* (issue #509 AC7)                                                           */
/* -------------------------------------------------------------------------- */

test('eine monatliche Routine zeigt Streak 2 über zwei aufeinanderfolgende Monate', async ({
  page,
}) => {
  const habitId = await seedHabit(page, {
    name: 'Miete überweisen',
    schedule: 'monthly',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: '2026-06-05', done: true }); // Vormonat
  await seedHabitLog(page, { habitId, logDate: TODAY, done: true }); // laufender Monat

  const item = habitTodayItems(page).filter({ hasText: 'Miete überweisen' });
  await expect(item.getByLabel('Streak: 2')).toBeVisible();
});

test('die laufende, noch offene Periode bricht die Serie nicht (issue #104, verallgemeinert in #509)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, {
    name: 'Miete überweisen',
    schedule: 'monthly',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: '2026-06-05', done: true }); // Vormonat erledigt
  // Laufender Monat (Juli) noch offen — kein Log.

  const item = habitTodayItems(page).filter({ hasText: 'Miete überweisen' });
  await expect(item.getByLabel('Streak: 1')).toBeVisible();
});

test('eine „3× pro Woche"-Routine zählt eine Woche erst als Serienglied, wenn alle 3 stehen', async ({
  page,
}) => {
  const habitId = await seedHabit(page, {
    name: 'Krafttraining',
    schedule: 'weekly',
    target: 3,
    color: null,
    archivedAt: null,
  });
  // Vorwoche: alle 3 erledigt.
  await seedHabitLog(page, { habitId, logDate: '2026-07-06', done: true });
  await seedHabitLog(page, { habitId, logDate: '2026-07-07', done: true });
  await seedHabitLog(page, { habitId, logDate: '2026-07-08', done: true });
  // Diese Woche: nur 2 von 3 — die laufende Periode ist noch offen.
  await seedHabitLog(page, { habitId, logDate: '2026-07-14', done: true });
  await seedHabitLog(page, { habitId, logDate: TODAY, done: true });

  const item = habitTodayItems(page).filter({ hasText: 'Krafttraining' });
  await expect(item.getByLabel('Streak: 1')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* Streak-Joker entfernt (issue #796) — Abwesenheits-Regression                */
/* -------------------------------------------------------------------------- */

test('nach einer echten Lücke gibt es keine Rescue-Aktion mehr, der Streak bleibt bei 0 (issue #796)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, {
    name: 'Joker-Test',
    schedule: 'daily',
    color: null,
    archivedAt: null,
  });
  // 13th done, 14th (gap) unlogged, 15th (today) still open.
  await seedHabitLog(page, { habitId, logDate: TWO_DAYS_AGO, done: true });
  await page.reload();

  const item = habitTodayItems(page).filter({ hasText: 'Joker-Test' });
  await expect(item).toBeVisible();
  await expect(item.getByRole('button', { name: 'Serie mit Joker retten' })).toHaveCount(0);
  await expect(item.locator('.habit-today__streak')).toHaveCount(0);
});

test('eine direkt in Postgres liegende habit_freezes-Restzeile überbrückt die Serie nicht mehr (issue #796)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, {
    name: 'Alte-Freeze-Zeile',
    schedule: 'daily',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: TWO_DAYS_AGO, done: true });
  // A leftover row from before #796 — the table stays (no migration, no data
  // loss), but the pull no longer reads `habit_freezes`, so this can never
  // reach the client the way a real `seedHabitLog` mutation would.
  await seedHabitFreeze(habitId, YESTERDAY);
  await seedHabitLog(page, { habitId, logDate: TODAY, done: true });
  await page.reload();

  // Before #796 this would have read "Streak: 3, mit Joker überbrückt" — the
  // gap on the 14th now breaks the streak, only today counts, and the badge
  // never grows a second icon.
  const item = habitTodayItems(page).filter({ hasText: 'Alte-Freeze-Zeile' });
  await expect(item.getByLabel('Streak: 1')).toBeVisible();
  await expect(item.locator('.habit-today__streak svg')).toHaveCount(1);
});

test('eine wöchentliche Routine zeigt nie eine Rescue-Aktion (issue #796)', async ({ page }) => {
  const habitId = await seedHabit(page, {
    name: 'Wöchentlich ohne Joker',
    schedule: 'weekly',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: MONDAY_TWO_WEEKS_AGO, done: true });
  await page.reload();

  const item = habitTodayItems(page).filter({ hasText: 'Wöchentlich ohne Joker' });
  await expect(item).toBeVisible();
  await expect(item.getByRole('button', { name: 'Serie mit Joker retten' })).toHaveCount(0);
});

test('Abhaken erzeugt offline keine habit_freezes-Mutation mehr (issue #796)', async ({ page }) => {
  await seedHabit(page, { name: 'Ohne Joker-Spur', schedule: 'daily', color: null, archivedAt: null });

  // beforeEach already cuts **/api/sync/** — the checkbox mutation lands only
  // in the outbox, so it is the outbox itself (not Postgres) that proves no
  // habit_freezes row ever gets minted as a side effect of a plain check-off.
  const item = habitTodayItems(page).filter({ hasText: 'Ohne Joker-Spur' });
  const checkbox = item.getByRole('checkbox');
  await expect(checkbox).not.toBeChecked();

  // A single unconditional click, like every other checkbox in this suite
  // (habits-uebersicht.spec.ts) — `.check()` re-clicks itself when the checked
  // state hasn't caught up yet, and since `toggle()` flips rather than sets,
  // that second click landed on the just-created log and flipped it straight
  // back to `done: false` (flaky "did not change its state").
  await checkbox.click();
  await expect(checkbox).toBeChecked();

  const pending = await page.evaluate(() => window.__starship.pending());
  expect(pending.length).toBeGreaterThan(0);
  expect(pending.every((mutation) => mutation.table !== 'habit_freezes')).toBe(true);
});

test('AK1: der Streak-Badge trägt genau ein SVG-Icon, der Text nur die Zahl (issue #640)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, {
    name: 'Icon-Streak',
    schedule: 'daily',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: YESTERDAY, done: true });
  await seedHabitLog(page, { habitId, logDate: TODAY, done: true });

  const item = habitTodayItems(page).filter({ hasText: 'Icon-Streak' });
  const streak = item.locator('.habit-today__streak');
  await expect(streak.locator('svg')).toHaveCount(1);
  await expect(streak).toHaveText('2');
});
