import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, settleJournalHabitBoot, skewClock, withDb } from './helpers';

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

async function seedHabitFreeze(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'habit_freezes', op: 'upsert', payload: p }),
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
/* Streak-Joker (issue #433, M-3 aus #416)                                    */
/* -------------------------------------------------------------------------- */

test('J1: eine Lücke am Vortag mit Vorserie zeigt die Rescue-Aktion, ein Tap rettet die Serie', async ({
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
  const rescueButton = item.getByRole('button', { name: 'Serie mit Joker retten' });
  await expect(rescueButton).toBeVisible();
  await expect(item.locator('.habit-today__streak')).toHaveCount(0);

  await rescueButton.click();

  await expect(item.getByLabel('Streak: 2, mit Joker überbrückt')).toBeVisible();
  await expect(rescueButton).toBeHidden();
});

test('J2: der Freeze bleibt bestehen — am Folgetag läuft die Serie normal weiter', async ({ page }) => {
  const habitId = await seedHabit(page, {
    name: 'Serie-Weiter',
    schedule: 'daily',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: TWO_DAYS_AGO, done: true });
  await seedHabitFreeze(page, { habitId, freezeDate: YESTERDAY });
  await seedHabitLog(page, { habitId, logDate: TODAY, done: true });
  await page.reload();

  const item = habitTodayItems(page).filter({ hasText: 'Serie-Weiter' });
  await expect(item.getByLabel('Streak: 3, mit Joker überbrückt')).toBeVisible();

  // A day passes, today (16th) gets logged too — the frozen 14th still counts.
  await skewClock(page, TOMORROW);
  await seedHabitLog(page, { habitId, logDate: '2026-07-16', done: true });
  await page.reload();

  await expect(item.getByLabel('Streak: 4, mit Joker überbrückt')).toBeVisible();
});

test('J3: erschöpftes Kontingent zeigt keine Rescue-Aktion, die Serie bleibt gebrochen', async ({
  page,
}) => {
  const habitId = await seedHabit(page, {
    name: 'Kein-Joker-Mehr',
    schedule: 'daily',
    color: null,
    archivedAt: null,
  });
  // Two jokers already spent on this habit this month — quota is exhausted.
  await seedHabitFreeze(page, { habitId, freezeDate: '2026-07-01' });
  await seedHabitFreeze(page, { habitId, freezeDate: '2026-07-02' });
  // 13th done, 14th (gap) unlogged, 15th (today) still open.
  await seedHabitLog(page, { habitId, logDate: TWO_DAYS_AGO, done: true });
  await page.reload();

  const item = habitTodayItems(page).filter({ hasText: 'Kein-Joker-Mehr' });
  await expect(item.getByRole('button', { name: 'Serie mit Joker retten' })).toBeHidden();
  await expect(item.locator('.habit-today__streak')).toHaveCount(0);
});

test('J4: eine wöchentliche Routine bekommt nie eine Rescue-Aktion', async ({ page }) => {
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
  await expect(item.getByRole('button', { name: 'Serie mit Joker retten' })).toBeHidden();
});

test('J5 Offline-Pfad: ein offline eingesetzter Joker landet nach dem Sync in Postgres', async ({
  page,
}) => {
  const habitId = await seedHabit(page, {
    name: 'Offline-Joker',
    schedule: 'daily',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: TWO_DAYS_AGO, done: true });

  // Flush the two seed mutations so the outbox below reflects only the rescue's
  // own mutation — this test proves the *rescue* reaches Postgres offline, not
  // the pre-existing habit/log (same route/unroute dance as sync.spec.ts).
  // Also settle the Journal habit (issue #505 AC1) in the same window: this is
  // the first successful sync of the test, so it is what first lets a device know
  // it is safe to create the row (journal-habit-boot.tsx's "never before the first
  // pull" guard) — done here, its own boot effect would otherwise still fire on the
  // reload below (`META_LAST_PULLED_SEQ` is now set) and land as a second, unrelated
  // pending mutation right next to the rescue's.
  await page.unroute('**/api/sync/**');
  await settleJournalHabitBoot(page);
  await page.route('**/api/sync/**', (route) => route.abort('failed'));

  await page.reload();

  // beforeEach already cuts **/api/sync/** — the joker must land in IndexedDB
  // through the outbox before it ever reaches the server.
  const item = habitTodayItems(page).filter({ hasText: 'Offline-Joker' });
  await item.getByRole('button', { name: 'Serie mit Joker retten' }).click();
  await expect(item.getByLabel('Streak: 2, mit Joker überbrückt')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  // `::text` avoids `pg`'s automatic `date` → local-midnight `Date` parsing (see
  // sync.spec.ts for the same reasoning), which would shift the calendar day in
  // a timezone east of UTC.
  const row = await withDb((client) =>
    client.query(
      'SELECT freeze_date::text AS freeze_date FROM habit_freezes WHERE habit_id = $1',
      [habitId],
    ),
  );
  expect(row.rows).toHaveLength(1);
  expect(row.rows[0].freeze_date).toBe(YESTERDAY);
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

test('AK2: ein mit Joker überbrückter Streak trägt zwei SVG-Icons, der Text weiterhin nur die Zahl (issue #640)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, {
    name: 'Icon-Joker',
    schedule: 'daily',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: TWO_DAYS_AGO, done: true });
  await page.reload();

  const item = habitTodayItems(page).filter({ hasText: 'Icon-Joker' });
  await item.getByRole('button', { name: 'Serie mit Joker retten' }).click();

  const streak = item.locator('.habit-today__streak');
  await expect(streak.locator('svg')).toHaveCount(2);
  await expect(streak).toHaveText('2');
});
