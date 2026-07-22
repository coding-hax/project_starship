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

test.beforeEach(async ({ page }) => {
  // resetAppData, not resetDatabase: wiping sessions/credentials forces registerPasskey
  // through a full re-registration every test, and that leaves goto('/gewohnheiten')
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
  await page.goto('/gewohnheiten');
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
/* AK: Raster zeigt genau die Tage des Monats, Mo–So-Spalten, Monatsanfang     */
/* korrekt eingerückt                                                        */
/* -------------------------------------------------------------------------- */

test('das Raster zeigt genau die Tage des Monats, Mo–So-Spalten, Monatsanfang korrekt eingerückt (issue #124 AC1)', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Yoga', schedule: 'daily', color: null, archivedAt: null });

  const grid = monthGrid(page, 'Yoga');
  // All 35 grid cells, including the leading/trailing blanks that keep every
  // row a full Mon–Sun week.
  const cells = grid.locator('> li');
  await expect(cells).toHaveCount(35);
  await expect(cells.nth(0)).toBeEmpty();
  await expect(cells.nth(1)).toBeEmpty();
  await expect(cells.nth(33)).toBeEmpty();
  await expect(cells.nth(34)).toBeEmpty();

  const days = grid.getByRole('button');
  await expect(days).toHaveCount(31);
  await expect(days.first()).toHaveText('1');
  await expect(days.last()).toHaveText('31');

  // Every day cell stays a real touch target (min 44px) even inside a 5-row
  // month grid (playwright.config.ts runs this spec in both viewport projects).
  const box = await days.first().boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
});

/* -------------------------------------------------------------------------- */
/* AK: ‹/› blättern den Monat für alle Gewohnheiten gleichzeitig              */
/* -------------------------------------------------------------------------- */

test('‹ und › blättern den Monat für alle Gewohnheiten gleichzeitig, Überschrift nennt Monat und Jahr (issue #124 AC2)', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Yoga', schedule: 'daily', color: null, archivedAt: null });
  await seedHabit(page, { name: 'Lesen', schedule: 'daily', color: null, archivedAt: null });

  await expect(page.getByText('Juli 2026', { exact: true })).toBeVisible();
  await expect(monthGrid(page, 'Yoga').getByRole('button')).toHaveCount(31);
  await expect(monthGrid(page, 'Lesen').getByRole('button')).toHaveCount(31);

  await page.getByRole('button', { name: 'Vorheriger Monat' }).click();
  await expect(page.getByText('Juni 2026', { exact: true })).toBeVisible();
  // June 2026 has 30 days.
  await expect(monthGrid(page, 'Yoga').getByRole('button')).toHaveCount(30);
  await expect(monthGrid(page, 'Lesen').getByRole('button')).toHaveCount(30);

  await page.getByRole('button', { name: 'Nächster Monat' }).click();
  await page.getByRole('button', { name: 'Nächster Monat' }).click();
  await expect(page.getByText('August 2026', { exact: true })).toBeVisible();
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

  const julyDays = monthGrid(page, 'Lesen').getByRole('button');
  await expect(julyDays.first()).toHaveClass(/habit-week-grid__day--done/);
  await expect(julyDays.nth(1)).not.toHaveClass(/habit-week-grid__day--done/);

  await page.getByRole('button', { name: 'Vorheriger Monat' }).click();
  const juneDays = monthGrid(page, 'Lesen').getByRole('button');
  // June starts on a Monday (no leading blank), so June 10 is the 10th button.
  await expect(juneDays.nth(9)).toHaveClass(/habit-week-grid__day--done/);
  for (const index of [0, 1, 8, 10]) {
    await expect(juneDays.nth(index)).not.toHaveClass(/habit-week-grid__day--done/);
  }
});

/* -------------------------------------------------------------------------- */
/* AK: ein zurückliegender Tag lässt sich nachträglich abhaken/lösen, Outbox  */
/* -------------------------------------------------------------------------- */

test('ein zurückliegender Tag lässt sich nachträglich abhaken und wieder lösen, über die Outbox (issue #124 AC4)', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Meditieren', schedule: 'daily', color: null, archivedAt: null });
  // July 1 — two weeks before NOW.
  const pastDay = monthGrid(page, 'Meditieren').getByRole('button').first();

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
  await context.setOffline(true);

  const pastDay = monthGrid(page, 'Vitamine').getByRole('button').first();
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
/* AK: ein zukünftiger Tag lässt sich nicht abhaken, ist visuell abgesetzt    */
/* -------------------------------------------------------------------------- */

test('ein zukünftiger Tag lässt sich nicht abhaken und ist visuell abgesetzt (issue #124 AC5)', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Vorsorge', schedule: 'daily', color: null, archivedAt: null });
  // July 31 — future relative to NOW (July 15).
  const futureDay = monthGrid(page, 'Vorsorge').getByRole('button').last();
  await expect(futureDay).toHaveText('31');

  await expect(futureDay).toBeDisabled();
  await expect(futureDay).toHaveAttribute('data-future', '');
  await futureDay.click({ force: true });
  await expect(futureDay).not.toHaveClass(/habit-week-grid__day--done/);

  const entries = await page.evaluate(() => window.__starship.pending());
  expect(entries.filter((entry) => entry.table === 'habit_logs')).toHaveLength(0);
});

/* -------------------------------------------------------------------------- */
/* AK: "heute" ist nur im laufenden Monat markiert                            */
/* -------------------------------------------------------------------------- */

test('"heute" ist nur im laufenden Monat markiert (issue #124 AC6)', async ({ page }) => {
  await seedHabit(page, { name: 'Spaziergang', schedule: 'daily', color: null, archivedAt: null });

  const julyDays = monthGrid(page, 'Spaziergang').getByRole('button');
  // NOW is July 15 — the 15th button (index 14).
  await expect(julyDays.nth(14)).toHaveAttribute('data-today', '');
  await expect(julyDays.nth(14)).toHaveAccessibleName(/\(heute\)/);

  await page.getByRole('button', { name: 'Vorheriger Monat' }).click();
  const juneDays = monthGrid(page, 'Spaziergang').getByRole('button');
  const juneCount = await juneDays.count();
  for (let index = 0; index < juneCount; index += 1) {
    await expect(juneDays.nth(index)).not.toHaveAttribute('data-today', '');
  }
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

  const days = monthGrid(page, 'Yoga').getByRole('button');
  // Check off the two days before that — 12th and 13th — straight from the
  // month grid, extending the streak from 2 to 4.
  await days.nth(11).click();
  await days.nth(12).click();

  // A client-side navigation, not a reload — the same liveQuery both screens
  // read from must already reflect the write (due-today.ts's "no fetch needed").
  await page.getByRole('link', { name: 'Heute' }).click();
  await expect(
    page.getByRole('list', { name: 'Gewohnheiten heute' }).getByLabel('Streak: 4'),
  ).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* AK: Ein Monat ohne einen einzigen Log zeigt ein leeres, aber vollständiges */
/* Raster                                                                     */
/* -------------------------------------------------------------------------- */

test('ein Monat ohne einen einzigen Log zeigt ein leeres, aber vollständiges Raster (issue #124 AC8)', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Neu', schedule: 'daily', color: null, archivedAt: null });

  const grid = monthGrid(page, 'Neu');
  await expect(grid).toBeVisible();
  const days = grid.getByRole('button');
  await expect(days).toHaveCount(31);
  for (const index of [0, 5, 13, 30]) {
    await expect(days.nth(index)).not.toHaveClass(/habit-week-grid__day--done/);
  }
});

/* -------------------------------------------------------------------------- */
/* AK: 375px und 1280px — Raster bleibt vollständig sichtbar, kein waagerechtes */
/* Scrollen, Zellen bleiben tippbar                                          */
/* -------------------------------------------------------------------------- */

test('das Monatsraster bleibt innerhalb der Seitenbreite, keine horizontale Verschiebung (issue #124 AC9/AC10)', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Laufen', schedule: 'daily', color: null, archivedAt: null });

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

  const days = monthGrid(page, 'Laufen').getByRole('button');
  const box = await days.first().boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
});

/* -------------------------------------------------------------------------- */
/* AK: Semantische Tokens, Dark Mode, prefers-reduced-motion                  */
/* -------------------------------------------------------------------------- */

/**
 * Same `background` shorthand as `habit-week-grid.tsx`'s inline style, on a probe
 * carrying the same `transition: background-color` as the real cell — Chromium
 * serializes a computed `background-color` differently (oklab vs oklch) once a
 * transition is declared on it, so a probe without one is not a fair comparison.
 */
async function resolveBackgroundToken(page: Page, token: string): Promise<string> {
  return page.evaluate((cssVar) => {
    const probe = document.createElement('button');
    probe.className = 'habit-week-grid__day';
    probe.style.background = `var(${cssVar})`;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }, token);
}

test('eine erledigte Zelle zeigt die Habit-Farbe als Hintergrund, auch im Dark Mode (issue #124 AC11)', async ({
  page,
}) => {
  // Logs load asynchronously from IndexedDB, so the cell briefly paints "open"
  // before this row's `done` class lands, and `.habit-week-grid__day` transitions
  // `background-color` (unlike habit-today.css's static colour dot) — even at the
  // reduced-motion duration of 0.01ms a synchronous read right after the value
  // changes can still catch the pre-transition frame. `expect.poll` waits it out
  // instead of racing it (not a loosened assert — the target colour is unchanged).
  await page.emulateMedia({ reducedMotion: 'reduce' });

  const habitId = await seedHabit(page, {
    name: 'Eigenfarbe',
    schedule: 'daily',
    color: '--area-journal',
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: JULY_1, done: true });

  const day = monthGrid(page, 'Eigenfarbe').getByRole('button').first();
  await expect(day).toHaveClass(/habit-week-grid__day--done/);
  const expectedLight = await resolveBackgroundToken(page, '--area-journal');
  let lightColor = '';
  await expect
    .poll(async () => {
      lightColor = await day.evaluate((el) => getComputedStyle(el).backgroundColor);
      return lightColor;
    })
    .toBe(expectedLight);

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const expectedDark = await resolveBackgroundToken(page, '--area-journal');
  let darkColor = '';
  await expect
    .poll(async () => {
      darkColor = await day.evaluate((el) => getComputedStyle(el).backgroundColor);
      return darkColor;
    })
    .toBe(expectedDark);
  expect(darkColor).not.toBe(lightColor);
});

test('bei reduzierter Bewegung ist der Zellen-Übergang augenblicklich (issue #124 AC11)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await seedHabit(page, { name: 'Ruhig', schedule: 'daily', color: null, archivedAt: null });

  const day = monthGrid(page, 'Ruhig').getByRole('button').first();
  const transitionDuration = await day.evaluate((el) => getComputedStyle(el).transitionDuration);
  // Chromium serializes very small numbers in exponential notation (e.g. "1e-05s"),
  // so compare the parsed value rather than the exact string.
  for (const duration of transitionDuration.split(',')) {
    expect(parseFloat(duration)).toBeLessThan(0.001);
  }
});

