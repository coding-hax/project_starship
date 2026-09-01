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
  // `--text-muted` itself is a context variable since issue #832 (the page ground
  // overrides it, cards reset it back). `.habit-today` is the card (issue #975
  // AK1), so its `--text-muted` resolves to the fixed `--text-muted-base` and
  // inherits down to this hint — that's the value this element actually
  // renders, not whatever `--text-muted` means at document level (which here
  // is the route's ground ink).
  const lightColor = await hint.evaluate((el) => getComputedStyle(el).color);
  expect(lightColor).toBe(await resolveColorToken(page, '--text-muted-base'));

  await page.emulateMedia({ colorScheme: 'dark' });
  const darkColor = await hint.evaluate((el) => getComputedStyle(el).color);
  expect(darkColor).toBe(await resolveColorToken(page, '--text-muted-base'));
  expect(darkColor).not.toBe(lightColor);

  const transitionProperty = await hint.evaluate((el) => getComputedStyle(el).transitionProperty);
  expect(transitionProperty).toBe('all');
});

/* -------------------------------------------------------------------------- */
/* AK1: eine Karte statt Karte je Zeile (issue #975)                          */
/* -------------------------------------------------------------------------- */

test('AK1: die Liste selbst trägt Fläche/Radius/Schatten, eine Zeile trägt keine eigenen mehr (issue #975)', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Kartenrumpf', schedule: 'daily', color: null, archivedAt: null });

  const list = page.locator('.habit-today');
  await expect(list).toHaveCSS('background-color', await resolveColorToken(page, '--surface'));
  const listShadow = await list.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(listShadow).not.toBe('none');

  const item = habitTodayItems(page).filter({ hasText: 'Kartenrumpf' });
  const itemStyle = await item.evaluate((el) => {
    const computed = getComputedStyle(el);
    return { background: computed.backgroundColor, shadow: computed.boxShadow };
  });
  expect(itemStyle.background).toBe('rgba(0, 0, 0, 0)');
  expect(itemStyle.shadow).toBe('none');
});

/* -------------------------------------------------------------------------- */
/* AK3: Zeilen ohne Streak bleiben ausgerichtet                               */
/* -------------------------------------------------------------------------- */

test('AK3: eine Zeile ohne Streak zeigt den Farbpunkt an der Stelle der Pille, der Name beginnt bei beiden auf derselben Kante (issue #975)', async ({
  page,
}) => {
  const mitSerieId = await seedHabit(page, {
    name: 'Mit Serie',
    schedule: 'daily',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId: mitSerieId, logDate: '2026-07-15', done: true });
  await seedHabit(page, { name: 'Ohne Serie', schedule: 'daily', color: null, archivedAt: null });

  const mitSerieItem = habitTodayItems(page).filter({ hasText: 'Mit Serie' });
  const ohneSerieItem = habitTodayItems(page).filter({ hasText: 'Ohne Serie' });
  await expect(mitSerieItem.locator('.habit-today__streak')).toBeVisible();
  await expect(mitSerieItem.locator('.habit-today__color')).toHaveCount(0);
  await expect(ohneSerieItem.locator('.habit-today__color')).toBeVisible();
  await expect(ohneSerieItem.locator('.habit-today__streak')).toHaveCount(0);

  const [mitSerieNameX, ohneSerieNameX] = await Promise.all([
    mitSerieItem.locator('.habit-today__name').evaluate((el) => el.getBoundingClientRect().x),
    ohneSerieItem.locator('.habit-today__name').evaluate((el) => el.getBoundingClientRect().x),
  ]);
  expect(mitSerieNameX).toBe(ohneSerieNameX);
});

/* -------------------------------------------------------------------------- */
/* AK4: rundes Häkchen statt Systemcheckbox, Tap-Target bleibt ≥ 44 × 44      */
/* -------------------------------------------------------------------------- */

test('AK4: das Häkchen übernimmt die runde Form von .task-list__checkbox, der ganze 44×44-Wrapper hakt ab (issue #975, issue #867)', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Rundes Häkchen', schedule: 'daily', color: null, archivedAt: null });
  const item = habitTodayItems(page).filter({ hasText: 'Rundes Häkchen' });
  const checkbox = item.getByRole('checkbox');
  const wrap = item.locator('.habit-today__checkbox-wrap');

  const shape = await checkbox.evaluate((el) => {
    const computed = getComputedStyle(el);
    return { appearance: computed.appearance, borderRadius: computed.borderRadius, width: computed.width };
  });
  expect(shape.appearance).toBe('none');
  expect(shape.borderRadius).toBe('50%');
  expect(shape.width).toBe('30px');

  const wrapBox = await wrap.evaluate((el) => el.getBoundingClientRect());
  expect(wrapBox.width).toBeGreaterThanOrEqual(44);
  expect(wrapBox.height).toBeGreaterThanOrEqual(44);

  // Tippt in eine Ecke des Wrappers, nicht auf den kleineren, sichtbaren Kreis
  // — nur ein <label>-Wrapper (statt eines bloßen <span>) leitet das an den
  // Checkbox-Klick weiter (issue #867's genau selbe Begründung).
  await wrap.click({ position: { x: 2, y: 2 } });
  await expect(checkbox).toBeChecked();
});

/* -------------------------------------------------------------------------- */
/* AK8: Kontrast — Pillenschrift, Pillenfläche, Häkchenrand, hell und dunkel  */
/* -------------------------------------------------------------------------- */

function relativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function contrastRatio(rgbA: [number, number, number], rgbB: [number, number, number]): number {
  const [la, lb] = [relativeLuminance(...rgbA), relativeLuminance(...rgbB)];
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** See grundfarbe.spec.ts's own `toRgb` for why canvas, not a regex on rgb()/oklch(). */
async function toRgb(page: Page, color: string): Promise<[number, number, number]> {
  return page.evaluate((c) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b] as [number, number, number];
  }, color);
}

test('AK8: Pillenschrift erreicht 4,5:1, Pillenfläche ist von --surface unterscheidbar, Häkchenrand erreicht 3:1 — hell und dunkel (issue #975)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, {
    name: 'Kontrastsonde',
    schedule: 'daily',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: '2026-07-15', done: true });
  const item = habitTodayItems(page).filter({ hasText: 'Kontrastsonde' });

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });

    const surface = await toRgb(page, await resolveColorToken(page, '--surface'));

    const pill = item.locator('.habit-today__streak');
    const pillStyle = await pill.evaluate((el) => {
      const computed = getComputedStyle(el);
      return { background: computed.backgroundColor, color: computed.color };
    });
    const pillBg = await toRgb(page, pillStyle.background);
    const pillText = await toRgb(page, pillStyle.color);
    expect(
      contrastRatio(pillText, pillBg),
      `Pillenschrift (${scheme}) gegen die Pillenfläche`,
    ).toBeGreaterThanOrEqual(4.5);
    expect(pillStyle.background, `Pillenfläche (${scheme}) gegen --surface`).not.toBe(
      await resolveColorToken(page, '--surface'),
    );

    const checkboxBorder = await toRgb(
      page,
      await item.getByRole('checkbox').evaluate((el) => getComputedStyle(el).borderColor),
    );
    expect(
      contrastRatio(checkboxBorder, surface),
      `Häkchenrand (${scheme}) gegen --surface`,
    ).toBeGreaterThanOrEqual(3);
  }
});

/* -------------------------------------------------------------------------- */
/* AK9: 375 × 812 ohne Überlauf, Dark Mode, langer Name kürzt einzeilig       */
/* -------------------------------------------------------------------------- */

test('AK9: ein langer Routinenname kürzt einzeilig zwischen Pille und Häkchen, kein horizontaler Überlauf bei 375×812, Dark Mode (issue #975)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: 'dark' });
  const habitId = await seedHabit(page, {
    name: 'Ein sehr sehr sehr langer Routinenname, der garantiert nicht in eine Zeile passt',
    schedule: 'daily',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: '2026-07-15', done: true });
  await page.reload();

  const name = habitTodayItems(page)
    .filter({ hasText: 'Ein sehr sehr sehr langer Routinenname' })
    .locator('.habit-today__name');
  await expect(name).toBeVisible();
  const { clientHeight, lineHeight } = await name.evaluate((el) => ({
    clientHeight: el.clientHeight,
    lineHeight: parseFloat(getComputedStyle(el).lineHeight),
  }));
  expect(Math.round(clientHeight / lineHeight)).toBe(1);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});
