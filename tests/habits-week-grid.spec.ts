import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetDatabase, skewClock, withDb } from './helpers';

// A Wednesday, same reference date as habits-heute.spec.ts / streaks.spec.ts.
const NOW = '2026-07-15T12:00:00.000Z';
const MONDAY_THIS_WEEK = '2026-07-13';
const WEDNESDAY_THIS_WEEK = '2026-07-15';
const SUNDAY_THIS_WEEK = '2026-07-19';

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

function weekGrid(page: Page, habitName: string) {
  return page.getByRole('list', { name: `Woche: ${habitName}` });
}

test.beforeEach(async ({ page }) => {
  await resetDatabase();
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
/* AK: Raster zeigt Mo–So korrekt, heutiger Tag markiert                      */
/* -------------------------------------------------------------------------- */

test('das Raster zeigt sieben Tage Mo–So, der heutige Tag ist markiert (issue #105 AC1)', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Yoga', schedule: 'daily', color: null, archivedAt: null });

  const grid = weekGrid(page, 'Yoga');
  const cells = grid.getByRole('button');
  await expect(cells).toHaveCount(7);
  await expect(cells).toHaveText(['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']);

  // NOW is a Wednesday — the third cell (index 2) is today.
  await expect(cells.nth(2)).toHaveAttribute('data-today', '');
  await expect(cells.nth(2)).toHaveAccessibleName(/\(heute\)/);
  for (const index of [0, 1, 3, 4, 5, 6]) {
    await expect(cells.nth(index)).not.toHaveAttribute('data-today', '');
  }

  // Every cell stays a real touch target (min 44px) even on the 375px project
  // (playwright.config.ts runs this spec in both the mobile and desktop project).
  const box = await cells.first().boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
});

/* -------------------------------------------------------------------------- */
/* AK: Erledigte Tage gefüllt, offene leer — passend zu habit_logs            */
/* -------------------------------------------------------------------------- */

test('erledigte Tage sind gefüllt, offene bleiben leer (issue #105 AC2)', async ({ page }) => {
  const habitId = await seedHabit(page, {
    name: 'Lesen',
    schedule: 'daily',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: MONDAY_THIS_WEEK, done: true });
  await seedHabitLog(page, { habitId, logDate: WEDNESDAY_THIS_WEEK, done: true });

  const cells = weekGrid(page, 'Lesen').getByRole('button');
  await expect(cells.nth(0)).toHaveClass(/habit-week-grid__day--done/);
  await expect(cells.nth(2)).toHaveClass(/habit-week-grid__day--done/);
  for (const index of [1, 3, 4, 5, 6]) {
    await expect(cells.nth(index)).not.toHaveClass(/habit-week-grid__day--done/);
  }
});

test('ein zurückgenommener Log leert die Zelle wieder', async ({ page }) => {
  const habitId = await seedHabit(page, {
    name: 'Tagebuch',
    schedule: 'daily',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: SUNDAY_THIS_WEEK, done: false });

  const cells = weekGrid(page, 'Tagebuch').getByRole('button');
  await expect(cells.nth(6)).not.toHaveClass(/habit-week-grid__day--done/);
});

/* -------------------------------------------------------------------------- */
/* AK: Tippen einer Zelle schreibt/entfernt den Log für diesen Tag, offline   */
/* -------------------------------------------------------------------------- */

test('Tippen einer offenen Zelle markiert den Tag als erledigt, erneutes Tippen nimmt es zurück (issue #105 AC3)', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Meditieren', schedule: 'daily', color: null, archivedAt: null });
  const monday = weekGrid(page, 'Meditieren').getByRole('button').nth(0);

  await expect(monday).toHaveAttribute('aria-pressed', 'false');
  await monday.click();
  await expect(monday).toHaveAttribute('aria-pressed', 'true');
  await expect(monday).toHaveClass(/habit-week-grid__day--done/);

  await monday.click();
  await expect(monday).toHaveAttribute('aria-pressed', 'false');
  await expect(monday).not.toHaveClass(/habit-week-grid__day--done/);

  // Both taps must upsert the same row, not create a second one (UNIQUE(habit_id, log_date)).
  const entries = await page.evaluate(() => window.__starship.pending());
  const logMutations = entries.filter((entry) => entry.table === 'habit_logs');
  expect(logMutations).toHaveLength(2);
  expect(new Set(logMutations.map((entry) => entry.rowId)).size).toBe(1);
});

test('offline getippt erreicht der Log online den Server (issue #105 AC3)', async ({
  page,
  context,
}) => {
  await seedHabit(page, { name: 'Vitamine', schedule: 'daily', color: null, archivedAt: null });
  await context.setOffline(true);

  const monday = weekGrid(page, 'Vitamine').getByRole('button').nth(0);
  await monday.click();
  await expect(monday).toHaveAttribute('aria-pressed', 'true');
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
  expect(row.rows[0].log_date).toBe(MONDAY_THIS_WEEK);
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

test('eine erledigte Zelle zeigt die Habit-Farbe als Hintergrund, auch im Dark Mode (issue #105 AC4)', async ({
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
  await seedHabitLog(page, { habitId, logDate: MONDAY_THIS_WEEK, done: true });

  const monday = weekGrid(page, 'Eigenfarbe').getByRole('button').nth(0);
  await expect(monday).toHaveClass(/habit-week-grid__day--done/);
  const expectedLight = await resolveBackgroundToken(page, '--area-journal');
  let lightColor = '';
  await expect
    .poll(async () => {
      lightColor = await monday.evaluate((el) => getComputedStyle(el).backgroundColor);
      return lightColor;
    })
    .toBe(expectedLight);

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const expectedDark = await resolveBackgroundToken(page, '--area-journal');
  let darkColor = '';
  await expect
    .poll(async () => {
      darkColor = await monday.evaluate((el) => getComputedStyle(el).backgroundColor);
      return darkColor;
    })
    .toBe(expectedDark);
  expect(darkColor).not.toBe(lightColor);
});

test('bei reduzierter Bewegung ist der Zellen-Übergang augenblicklich (issue #105 AC4)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await seedHabit(page, { name: 'Ruhig', schedule: 'daily', color: null, archivedAt: null });

  const monday = weekGrid(page, 'Ruhig').getByRole('button').nth(0);
  const transitionDuration = await monday.evaluate(
    (el) => getComputedStyle(el).transitionDuration,
  );
  // Chromium serializes very small numbers in exponential notation (e.g. "1e-05s"),
  // so compare the parsed value rather than the exact string.
  for (const duration of transitionDuration.split(',')) {
    expect(parseFloat(duration)).toBeLessThan(0.001);
  }
});
