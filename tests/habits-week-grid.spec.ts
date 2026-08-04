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

/** Mirrors JOURNAL_HABIT_ID in src/features/journal/journal-habit.ts (issue #505). */
const JOURNAL_HABIT_ID = '5b5c9dc3-25c8-4f97-a4c5-61cb4c736c80';

async function seedJournalHabit(page: Page): Promise<void> {
  await page.evaluate(
    (p) => window.__starship.mutate({ table: 'habits', rowId: p.rowId, op: 'upsert', payload: p.payload }),
    {
      rowId: JOURNAL_HABIT_ID,
      payload: { name: 'Journal', schedule: 'daily', color: '--area-journal', archivedAt: null },
    },
  );
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

test('das Raster zeigt genau die Tage des Monats plus die echten Nachbartage, Mo–So-Spalten (issue #124 AC1, #487 AC1)', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Yoga', schedule: 'daily', color: null, archivedAt: null });

  const grid = monthGrid(page, 'Yoga');
  // All 35 grid cells are real, tappable days now — the leading/trailing
  // weeks show June 29/30 and August 1/2 instead of empty padding (#487 AC1).
  const cells = grid.locator('> li');
  await expect(cells).toHaveCount(35);
  const allDays = grid.getByRole('button');
  await expect(allDays).toHaveCount(35);

  const julyDays = grid.locator('button:not([data-outside])');
  await expect(julyDays).toHaveCount(31);
  await expect(julyDays.first()).toHaveText('1');
  await expect(julyDays.last()).toHaveText('31');

  await expect(dayButton(grid, 29, 'Juni')).toBeVisible();
  await expect(dayButton(grid, 30, 'Juni')).toBeVisible();
  await expect(dayButton(grid, 1, 'August')).toBeVisible();
  await expect(dayButton(grid, 2, 'August')).toBeVisible();

  // Every day cell stays a real touch target (min 44px) even inside a 5-row
  // month grid (playwright.config.ts runs this spec in both viewport projects).
  const box = await allDays.first().boundingBox();
  // Rounded, not compared exactly: Chromium's grid layout can report a
  // sub-pixel-short boundingBox (e.g. 43.999969...) for a 44px min-height box
  // (same float-serialization class as the neighbour-day check below, #526) —
  // the CSS token is an exact 44px, this only guards against that.
  expect(Math.round(box?.width ?? 0)).toBeGreaterThanOrEqual(44);
  expect(Math.round(box?.height ?? 0)).toBeGreaterThanOrEqual(44);
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
  await expect(monthGrid(page, 'Yoga').locator('button:not([data-outside])')).toHaveCount(31);
  await expect(monthGrid(page, 'Lesen').locator('button:not([data-outside])')).toHaveCount(31);

  await page.getByRole('button', { name: 'Vorheriger Monat' }).click();
  await expect(page.getByText('Juni 2026', { exact: true })).toBeVisible();
  // June 2026 has 30 days.
  await expect(monthGrid(page, 'Yoga').locator('button:not([data-outside])')).toHaveCount(30);
  await expect(monthGrid(page, 'Lesen').locator('button:not([data-outside])')).toHaveCount(30);

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
/* AK: ein zukünftiger Tag lässt sich nicht abhaken, ist visuell abgesetzt    */
/* -------------------------------------------------------------------------- */

test('ein zukünftiger Tag lässt sich nicht abhaken und ist visuell abgesetzt (issue #124 AC5)', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Vorsorge', schedule: 'daily', color: null, archivedAt: null });
  // July 31 — future relative to NOW (July 15).
  const futureDay = dayButton(monthGrid(page, 'Vorsorge'), 31, 'Juli');
  await expect(futureDay).toHaveText('31');

  await expect(futureDay).toBeDisabled();
  await expect(futureDay).toHaveAttribute('data-future', '');
  await futureDay.click({ force: true });
  await expect(futureDay).not.toHaveClass(/habit-week-grid__day--done/);

  const entries = await page.evaluate(() => window.__starship.pending());
  expect(entries.filter((entry) => entry.table === 'habit_logs')).toHaveLength(0);
});

/* -------------------------------------------------------------------------- */
/* AK: "heute" ist markiert, wo immer der Tag im Raster steht — auch als      */
/* Nachbartag in der Ansicht des Nachbarmonats (issue #487 AC6, ersetzt die   */
/* alte Annahme aus #124 AC6 "heute nur im laufenden Monat markiert")         */
/* -------------------------------------------------------------------------- */

test('"heute" ist markiert, auch wenn der Tag als Nachbartag in einer anderen Monatsansicht erscheint (issue #487 AC6)', async ({
  page,
}) => {
  // July 31, 2026 is a Friday — a leading neighbour day in August's grid.
  // July 15 (beforeEach) and July 31 are the same month, so the already-
  // mounted "viewedMonth" state (July) still matches after this skew.
  await skewClock(page, '2026-07-31T12:00:00.000Z');
  await seedHabit(page, { name: 'Spaziergang', schedule: 'daily', color: null, archivedAt: null });

  const julyGrid = monthGrid(page, 'Spaziergang');
  const julyToday = dayButton(julyGrid, 31, 'Juli');
  await expect(julyToday).toHaveAttribute('data-today', '');
  await expect(julyToday).toHaveAccessibleName(/\(heute\)/);

  await page.getByRole('button', { name: 'Nächster Monat' }).click();
  const augustGrid = monthGrid(page, 'Spaziergang');
  const augustNeighbourToday = dayButton(augustGrid, 31, 'Juli');
  await expect(augustNeighbourToday).toHaveAttribute('data-outside', '');
  await expect(augustNeighbourToday).toHaveAttribute('data-today', '');
  await expect(augustNeighbourToday).toHaveAccessibleName(/\(heute\)/);

  // A neighbour day that isn't today stays unmarked.
  await expect(dayButton(augustGrid, 27, 'Juli')).not.toHaveAttribute('data-today', '');
});

/* -------------------------------------------------------------------------- */
/* issue #505 AC5: die Journal-Zeile im Monatsraster ist nicht antippbar      */
/* -------------------------------------------------------------------------- */

test('die Journal-Zeile im Monatsraster ist nicht antippbar, ein Tipp legt keinen Log an (issue #505 AC5)', async ({
  page,
}) => {
  await seedJournalHabit(page);

  const days = monthGrid(page, 'Journal').getByRole('button');
  const july14 = days.nth(13); // JULY_14 — weder heute noch Zukunft, nur readOnly deaktiviert
  await expect(july14).toBeDisabled();

  await july14.click({ force: true });

  const logs = await page.evaluate(async (habitId) => {
    const records = await window.__starship.debugRecords();
    return records.filter((r) => r.table === 'habit_logs' && r.data.habitId === habitId);
  }, JOURNAL_HABIT_ID);
  expect(logs).toHaveLength(0);
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

  const grid = monthGrid(page, 'Yoga');
  // Check off the two days before that — 12th and 13th — straight from the
  // month grid, extending the streak from 2 to 4.
  await dayButton(grid, 12, 'Juli').click();
  await dayButton(grid, 13, 'Juli').click();

  // A client-side navigation, not a reload — the same liveQuery both screens
  // read from must already reflect the write (due-today.ts's "no fetch needed").
  await page.getByRole('link', { name: 'Übersicht' }).click();
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
  await expect(grid.locator('> li')).toHaveCount(35);
  await expect(grid.locator('button:not([data-outside])')).toHaveCount(31);
  await expect(grid.locator('.habit-week-grid__day--done')).toHaveCount(0);
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
  // Rounded, not compared exactly: same sub-pixel boundingBox artifact as the
  // month-grid check above (#526) — the CSS token is an exact 44px.
  expect(Math.round(box?.width ?? 0)).toBeGreaterThanOrEqual(44);
  expect(Math.round(box?.height ?? 0)).toBeGreaterThanOrEqual(44);
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

  const day = dayButton(monthGrid(page, 'Eigenfarbe'), 1, 'Juli');
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

/* -------------------------------------------------------------------------- */
/* AK: Nachbartage sind optisch klar abgesetzt, bleiben aber lesbar           */
/* -------------------------------------------------------------------------- */

test('Nachbartage sind gedimmt und optisch von den Tagen des gewählten Monats abgesetzt (issue #487 AC2)', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Kontrast', schedule: 'daily', color: null, archivedAt: null });

  const grid = monthGrid(page, 'Kontrast');
  const outsideDay = dayButton(grid, 30, 'Juni');
  const inMonthDay = dayButton(grid, 2, 'Juli');

  await expect(outsideDay).toHaveAttribute('data-outside', '');
  await expect(inMonthDay).not.toHaveAttribute('data-outside', '');

  const outsideOpacity = Number(
    await outsideDay.evaluate((el) => getComputedStyle(el).opacity),
  );
  const inMonthOpacity = Number(
    await inMonthDay.evaluate((el) => getComputedStyle(el).opacity),
  );
  expect(outsideOpacity).toBeLessThan(inMonthOpacity);
  // Dimmed, but still readable — not fully transparent.
  expect(outsideOpacity).toBeGreaterThan(0);
});

/* -------------------------------------------------------------------------- */
/* AK: ein Nachbartag ist vollwertig abhakbar, wie ein Tag des Monats         */
/* -------------------------------------------------------------------------- */

test('ein Nachbartag ist vollwertig abhakbar wie ein Tag des gewählten Monats, zeigt die Habit-Farbe (issue #487 AC3)', async ({
  page,
}) => {
  await seedHabit(page, {
    name: 'Nachbar',
    schedule: 'daily',
    color: '--area-tasks',
    archivedAt: null,
  });

  const neighbourDay = dayButton(monthGrid(page, 'Nachbar'), 30, 'Juni');

  await expect(neighbourDay).toHaveAttribute('aria-pressed', 'false');
  await neighbourDay.click();
  await expect(neighbourDay).toHaveAttribute('aria-pressed', 'true');
  await expect(neighbourDay).toHaveClass(/habit-week-grid__day--done/);

  const entries = await page.evaluate(() => window.__starship.pending());
  const logMutations = entries.filter((entry) => entry.table === 'habit_logs');
  expect(logMutations).toHaveLength(1);
  expect(logMutations[0].payload).toMatchObject({ logDate: '2026-06-30' });

  await neighbourDay.click();
  await expect(neighbourDay).toHaveAttribute('aria-pressed', 'false');
  await expect(neighbourDay).not.toHaveClass(/habit-week-grid__day--done/);

  // Both taps upsert the same row, same as a normal in-month day (issue #124 AC4).
  const entriesAfter = await page.evaluate(() => window.__starship.pending());
  const logMutationsAfter = entriesAfter.filter((entry) => entry.table === 'habit_logs');
  expect(logMutationsAfter).toHaveLength(2);
  expect(new Set(logMutationsAfter.map((entry) => entry.rowId)).size).toBe(1);
});

/* -------------------------------------------------------------------------- */
/* AK: die Zukunftsregel gilt unverändert auch für Nachbartage                */
/* -------------------------------------------------------------------------- */

test('die Zukunftsregel gilt auch für einen zukünftigen Nachbartag (issue #487 AC4)', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Vorsorge2', schedule: 'daily', color: null, archivedAt: null });

  // NOW is July 15 — August 1 is a trailing neighbour day of July's view and
  // lies in the future.
  const futureNeighbour = dayButton(monthGrid(page, 'Vorsorge2'), 1, 'August');

  await expect(futureNeighbour).toHaveAttribute('data-outside', '');
  await expect(futureNeighbour).toHaveAttribute('data-future', '');
  await expect(futureNeighbour).toBeDisabled();
  await futureNeighbour.click({ force: true });
  await expect(futureNeighbour).not.toHaveClass(/habit-week-grid__day--done/);

  const entries = await page.evaluate(() => window.__starship.pending());
  expect(entries.filter((entry) => entry.table === 'habit_logs')).toHaveLength(0);
});

/* -------------------------------------------------------------------------- */
/* AK: derselbe Tag zeigt in zwei Monatsansichten denselben Zustand           */
/* -------------------------------------------------------------------------- */

test('derselbe Tag zeigt in beiden Monatsansichten denselben Zustand, sofort nach dem Blättern (issue #487 AC5)', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Grenztag', schedule: 'daily', color: null, archivedAt: null });

  const julyGrid = monthGrid(page, 'Grenztag');
  const june30AsNeighbour = dayButton(julyGrid, 30, 'Juni');
  await june30AsNeighbour.click();
  await expect(june30AsNeighbour).toHaveClass(/habit-week-grid__day--done/);

  await page.getByRole('button', { name: 'Vorheriger Monat' }).click();
  const juneGrid = monthGrid(page, 'Grenztag');
  const june30InMonth = dayButton(juneGrid, 30, 'Juni');
  await expect(june30InMonth).not.toHaveAttribute('data-outside', '');
  await expect(june30InMonth).toHaveClass(/habit-week-grid__day--done/);

  // Toggling from the "home" month view is visible after paging back too.
  await june30InMonth.click();
  await expect(june30InMonth).not.toHaveClass(/habit-week-grid__day--done/);

  await page.getByRole('button', { name: 'Nächster Monat' }).click();
  const june30AsNeighbourAgain = dayButton(monthGrid(page, 'Grenztag'), 30, 'Juni');
  await expect(june30AsNeighbourAgain).not.toHaveClass(/habit-week-grid__day--done/);
});

/* -------------------------------------------------------------------------- */
/* AK: der zugängliche Name eines Nachbartags nennt Tag und Monat eindeutig   */
/* -------------------------------------------------------------------------- */

test('der zugängliche Name eines Nachbartags nennt Tag und Monat eindeutig (issue #487 AC7)', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Name', schedule: 'daily', color: null, archivedAt: null });

  const grid = monthGrid(page, 'Name');
  await expect(grid.getByRole('button', { name: /^30\. Juni 2026: Name/ })).toBeVisible();
  await expect(grid.getByRole('button', { name: /^1\. August 2026: Name/ })).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* AK: Nachbartage bleiben ≥44px, kein horizontales Scrollen                  */
/* -------------------------------------------------------------------------- */

test('Nachbartage bleiben ≥44px groß, kein horizontales Scrollen (issue #487 AC8)', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Maß', schedule: 'daily', color: null, archivedAt: null });

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

  const neighbourDay = dayButton(monthGrid(page, 'Maß'), 30, 'Juni');
  const box = await neighbourDay.boundingBox();
  // Rounded, not compared exactly: Chromium's grid layout can report a
  // sub-pixel-short boundingBox (e.g. 43.999969...) for a 44px min-height box
  // (same float-serialization class as the reduced-motion duration check
  // below) — the CSS token is an exact 44px, this only guards against that.
  expect(Math.round(box?.width ?? 0)).toBeGreaterThanOrEqual(44);
  expect(Math.round(box?.height ?? 0)).toBeGreaterThanOrEqual(44);
});

