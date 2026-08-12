import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, skewClock, withDb } from './helpers';

// A Wednesday, so "the current week" has days on both sides (issue #103).
const NOW = '2026-07-15T12:00:00.000Z';
const MONDAY_THIS_WEEK = '2026-07-13';
const LAST_MONDAY = '2026-07-06';

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

test('eine tägliche Routine erscheint in der Übersicht-Sektion und lässt sich abhaken (issue #103 AC1)', async ({
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

test('die Journal-Zeile ist nicht antippbar, ein Tipp legt keinen Log an (issue #505 AC5)', async ({
  page,
}) => {
  await seedJournalHabit(page);

  const item = habitTodayItems(page).filter({ hasText: 'Journal' });
  await expect(item).toBeVisible();
  const checkbox = item.getByRole('checkbox');
  await expect(checkbox).toBeDisabled();
  await expect(checkbox).not.toBeChecked();

  await checkbox.click({ force: true });

  await expect(checkbox).not.toBeChecked();
  expect(await habitLogRecords(page, JOURNAL_HABIT_ID)).toHaveLength(0);
});

test('eine wöchentliche Routine ohne Log in dieser Woche erscheint ebenfalls', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Joggen', schedule: 'weekly', color: null, archivedAt: null });

  await expect(habitTodayItems(page).filter({ hasText: 'Joggen' })).toBeVisible();
});

test('eine wöchentliche Routine, die früher diese Woche erledigt wurde, bleibt sichtbar mit dem Hinweis "Diese Woche schon erledigt" (issue #224 AC1/AC2)', async ({
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
  await expect(item).toBeVisible();
  await expect(item.getByText('Diese Woche schon erledigt')).toBeVisible();
  await expect(item.getByRole('checkbox')).not.toBeChecked();
  await expect(item).not.toHaveClass(/habit-today__item--done/);
});

test('ein Klick hakt die wöchentliche Routine für heute ab, der Wochen-Hinweis bleibt (nicht durchgestrichen), und der Zustand übersteht einen Reload (issue #224 AC3, issue #288 AC5)', async ({
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

  await item.getByRole('checkbox').click();

  await expect(item.getByRole('checkbox')).toBeChecked();
  await expect(item).toHaveClass(/habit-today__item--done/);
  const hint = item.getByText('Diese Woche schon erledigt');
  await expect(hint).toBeVisible();
  const nameDecoration = await item
    .locator('.habit-today__name')
    .evaluate((el) => getComputedStyle(el).textDecorationLine);
  expect(nameDecoration).toContain('line-through');
  const hintDecoration = await hint.evaluate((el) => getComputedStyle(el).textDecorationLine);
  expect(hintDecoration).toBe('none');

  await skewClock(page, NOW);
  await page.reload();

  const reloadedItem = habitTodayItems(page).filter({ hasText: 'Großeinkauf' });
  await expect(reloadedItem.getByRole('checkbox')).toBeChecked();
  await expect(reloadedItem.getByText('Diese Woche schon erledigt')).toBeVisible();

  // Both this week's earlier day and today are their own log rows (AC3). The
  // suite-wide route abort in beforeEach keeps this local — read IndexedDB via
  // the E2E bridge, not Postgres (nothing here was ever pushed).
  const logs = await habitLogRecords(page, habitId);
  expect(logs.map((r) => r.data.logDate)).toEqual([MONDAY_THIS_WEEK, '2026-07-15']);
  expect(logs.every((r) => r.data.done === true)).toBe(true);
});

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

test('eine wöchentliche Routine ohne Log oder nur mit letzter Woche erledigt zeigt keinen Wochen-Hinweis (issue #224 AC5)', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Joggen', schedule: 'weekly', color: null, archivedAt: null });
  const habitId = await seedHabit(page, {
    name: 'Wohnung putzen',
    schedule: 'weekly',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: LAST_MONDAY, done: true });

  const joggenItem = habitTodayItems(page).filter({ hasText: 'Joggen' });
  const putzenItem = habitTodayItems(page).filter({ hasText: 'Wohnung putzen' });
  await expect(joggenItem).toBeVisible();
  await expect(putzenItem).toBeVisible();
  await expect(joggenItem.getByText('Diese Woche schon erledigt')).toHaveCount(0);
  await expect(putzenItem.getByText('Diese Woche schon erledigt')).toHaveCount(0);
});

test('eine wöchentliche Routine mit Wochen-Hinweis lässt sich offline für heute abhaken, der Log erreicht online den Server (issue #224 AC6)', async ({
  page,
  context,
}) => {
  const habitId = await seedHabit(page, {
    name: 'Großeinkauf',
    schedule: 'weekly',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: MONDAY_THIS_WEEK, done: true });
  const item = habitTodayItems(page).filter({ hasText: 'Großeinkauf' });

  await context.setOffline(true);
  await item.getByRole('checkbox').click();

  await expect(item.getByRole('checkbox')).toBeChecked();
  await expect(item.getByText('Diese Woche schon erledigt')).toBeVisible();

  await page.unroute('**/api/sync/**');
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  const rows = await withDb((client) =>
    client.query(
      'SELECT done FROM habit_logs l JOIN habits h ON h.id = l.habit_id WHERE h.name = $1 AND log_date = $2',
      ['Großeinkauf', '2026-07-15'],
    ),
  );
  expect(rows.rowCount).toBe(1);
  expect(rows.rows[0].done).toBe(true);
});

/* -------------------------------------------------------------------------- */
/* AK: „N× pro Woche" — Zwischenstand und „schon erledigt" (issue #509 AC2/AC3) */
/* -------------------------------------------------------------------------- */

test('eine "3x pro Woche"-Routine mit 2 von 3 zeigt ihren Zwischenstand (issue #509 AC2)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, {
    name: 'Krafttraining',
    schedule: 'weekly',
    target: 3,
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: MONDAY_THIS_WEEK, done: true });
  await seedHabitLog(page, { habitId, logDate: '2026-07-14', done: true });

  const item = habitTodayItems(page).filter({ hasText: 'Krafttraining' });
  await expect(item).toBeVisible();
  await expect(item.getByText('2 von 3 diese Woche')).toBeVisible();
  await expect(item.getByText('Diese Woche schon erledigt')).toHaveCount(0);
});

test('eine "3x pro Woche"-Routine mit allen 3 Haken gilt als erledigt (issue #509 AC3)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, {
    name: 'Krafttraining',
    schedule: 'weekly',
    target: 3,
    color: null,
    archivedAt: null,
  });
  // All 3 checks land on days earlier this week than "today" — Friday, so Mon/
  // Tue/Thu are all available (Wednesday, the suite's usual NOW, only has two
  // earlier days in its own week to seed on).
  await seedHabitLog(page, { habitId, logDate: MONDAY_THIS_WEEK, done: true });
  await seedHabitLog(page, { habitId, logDate: '2026-07-14', done: true });
  await seedHabitLog(page, { habitId, logDate: '2026-07-16', done: true });
  await skewClock(page, '2026-07-17T12:00:00.000Z'); // Friday, same week
  await page.reload();

  const item = habitTodayItems(page).filter({ hasText: 'Krafttraining' });
  await expect(item).toBeVisible();
  await expect(item.getByText('Diese Woche schon erledigt')).toBeVisible();
  await expect(item.getByText(/von 3 diese Woche/)).toHaveCount(0);
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

test('ohne Routinen zeigt die Übersicht-Sektion einen Leerzustand mit Verweis auf die Verwaltung', async ({
  page,
}) => {
  await expect(page.getByText('Noch keine Routinen.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Jetzt anlegen' })).toHaveAttribute(
    'href',
    '/routinen',
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

test('eine Routine ohne Eigenfarbe zeigt den Standard-Token --area-habits, auch im Dark Mode (issue #103 AC5)', async ({
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

test('der Wochen-Hinweis nutzt den gedämpften Text-Token, auch im Dark Mode, ohne eigene Layout-Animation (issue #224 AC7)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, {
    name: 'Großeinkauf',
    schedule: 'weekly',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: MONDAY_THIS_WEEK, done: true });

  const hint = habitTodayItems(page).filter({ hasText: 'Großeinkauf' }).getByText(
    'Diese Woche schon erledigt',
  );
  await expect(hint).toBeVisible();
  const lightColor = await hint.evaluate((el) => getComputedStyle(el).color);
  expect(lightColor).toBe(await resolveColorToken(page, '--text-muted'));

  await page.emulateMedia({ colorScheme: 'dark' });
  const darkColor = await hint.evaluate((el) => getComputedStyle(el).color);
  expect(darkColor).toBe(await resolveColorToken(page, '--text-muted'));
  expect(darkColor).not.toBe(lightColor);

  const transitionProperty = await hint.evaluate((el) => getComputedStyle(el).transitionProperty);
  expect(transitionProperty).toBe('all');
});
