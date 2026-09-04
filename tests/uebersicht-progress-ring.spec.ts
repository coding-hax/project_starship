import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, skewClock } from './helpers';

/** A Wednesday, so a weekly habit's "current week" has days on both sides. */
const NOW = '2026-07-15T12:00:00.000Z';
const TODAY_EVENING = '2026-07-15T18:00:00.000Z';
const YESTERDAY_MORNING = '2026-07-14T09:00:00.000Z';
const TOMORROW_MORNING = '2026-07-16T09:00:00.000Z';
const MODULES_OFF_KEY = 'starship:modules-off';

function ring(page: Page) {
  return page.locator('.daily-progress-ring');
}

async function seedTask(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: p }),
    payload,
  );
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

async function setModulesOff(page: Page, off: string[]): Promise<void> {
  await page.evaluate(
    ({ key, off }) => localStorage.setItem(key, JSON.stringify(off)),
    { key: MODULES_OFF_KEY, off },
  );
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // The ring reads from IndexedDB only (CLAUDE.md rule 8), never a fetch.
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await page.route('https://api.open-meteo.com/**', (route) => route.abort('failed'));
  // No target: every test in this file opens with its own goto, so loading
  // /uebersicht here would only be thrown away (issue #1075).
  await registerPasskey(page, null);
  await skewClock(page, NOW);
});

test('zeigt einen Ring mit der Zahl "N/M" im Inneren und einem sprechenden aria-label, sobald etwas fällig ist (issue #428 AC1, issue #652 AK3+AK4)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Heute fällig', dueAt: TODAY_EVENING });

  await expect(ring(page)).toBeVisible();
  await expect(ring(page)).toHaveText(/^\d+\/\d+$/);
  await expect(ring(page)).toHaveText('0/1');
  await expect(ring(page)).toHaveAttribute('aria-label', 'heute 0 von 1 erledigt');
  await expect(ring(page)).toHaveAttribute('role', 'status');
});

test('zählt fällige Aufgaben (dueTodayOnly-Logik) und fällige Routinen zusammen, erledigt via completedAt/isDoneOnDay (issue #428 AC2)', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  // Tasks: due-or-overdue counts, future does not (matches TaskList dueTodayOnly).
  await seedTask(page, { title: 'Überfällig, offen', dueAt: YESTERDAY_MORNING });
  await seedTask(page, { title: 'Heute erledigt', dueAt: YESTERDAY_MORNING, completedAt: NOW });
  await seedTask(page, { title: 'Erst morgen', dueAt: TOMORROW_MORNING });

  // Habits: daily is always due; weekly is due (isDueOnDay treats the whole week as
  // due), one checked off today, one not.
  const dailyId = await seedHabit(page, {
    name: 'Wasser trinken',
    schedule: 'daily',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId: dailyId, logDate: '2026-07-15', done: true });
  await seedHabit(page, { name: 'Joggen', schedule: 'weekly', color: null, archivedAt: null });
  // Archived habits never count, even though isDueOnDay would say yes.
  await seedHabit(page, {
    name: 'Alt',
    schedule: 'daily',
    color: null,
    archivedAt: YESTERDAY_MORNING,
  });

  // Tasks: 2 due (1 done), Habits: 2 due (1 done) -> 2 von 4.
  await expect(ring(page)).toHaveText('2/4');
});

test('ein abgeschaltetes Modul trägt nichts zur Zählung bei (issue #428 AC3)', async ({ page }) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Heute fällig', dueAt: TODAY_EVENING });
  const habitId = await seedHabit(page, {
    name: 'Lesen',
    schedule: 'daily',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: '2026-07-15', done: true });
  await expect(ring(page)).toHaveText('1/2');

  await setModulesOff(page, ['aufgaben']);
  await page.reload();
  await expect(ring(page)).toHaveText('1/1');

  await setModulesOff(page, ['routinen']);
  await page.reload();
  await expect(ring(page)).toHaveText('0/1');
});

test('ohne heute Fälliges bleibt der Ring weg — kein "0 von 0" (issue #428 AC4)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Erst morgen', dueAt: TOMORROW_MORNING });

  await expect(ring(page)).toHaveCount(0);
  await expect(page.getByText('von 0')).toHaveCount(0);
});

test('beide Module aus lässt den Ring weg, obwohl Daten vorhanden sind (issue #428 AC4)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Heute fällig', dueAt: TODAY_EVENING });
  await seedHabit(page, { name: 'Lesen', schedule: 'daily', color: null, archivedAt: null });
  await expect(ring(page)).toBeVisible();

  await setModulesOff(page, ['aufgaben', 'routinen']);
  await page.reload();

  await expect(ring(page)).toHaveCount(0);
});

test('nach einem Reload mit vorhandenen Daten erscheint der Ring direkt mit den korrekten Zahlen, ohne Spinner (issue #428 AC5)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Heute fällig', dueAt: TODAY_EVENING });
  await expect(ring(page)).toHaveText('0/1');

  await skewClock(page, NOW);
  await page.reload();

  await expect(ring(page)).toBeVisible();
  await expect(ring(page)).toHaveText('0/1');
  await expect(
    ring(page).locator('[role="progressbar"], .spinner, [class*="skeleton"]'),
  ).toHaveCount(0);
});

test('Ring auf Mobile und Desktop, tabular-nums, Dark Mode und reduzierte Bewegung (issue #428 AC6+AC7)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Heute fällig', dueAt: TODAY_EVENING });
  await expect(ring(page)).toBeVisible();

  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(ring(page)).toBeVisible();
    await expect(ring(page)).toHaveText('0/1');
  }

  const label = ring(page).locator('.daily-progress-ring__count');
  const lightNums = await label.evaluate((el) => getComputedStyle(el).fontVariantNumeric);
  expect(lightNums).toContain('tabular-nums');
  const lightColor = await label.evaluate((el) => getComputedStyle(el).color);

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.reload();

  await expect(ring(page)).toBeVisible();
  const darkColor = await label.evaluate((el) => getComputedStyle(el).color);
  expect(darkColor).not.toBe(lightColor);

  // No animation ships in this ticket (fill-animation polish is #418) — the fill
  // circle must not carry a transition/animation that reduced motion would need
  // to zero out.
  const fillTransition = await ring(page)
    .locator('.daily-progress-ring__fill')
    .evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(parseFloat(fillTransition)).toBeLessThan(0.001);
});

test('eine wöchentliche Routine, die früher diese Woche abgehakt wurde, fällt aus dem Ring heraus (issue #503 AC1)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Überfällig, offen', dueAt: YESTERDAY_MORNING });
  const habitId = await seedHabit(page, {
    name: 'Joggen',
    schedule: 'weekly',
    color: null,
    archivedAt: null,
  });
  await expect(ring(page)).toHaveText('0/2');

  // Monday of the current Mon–Sun week — earlier than today (Wednesday).
  await seedHabitLog(page, { habitId, logDate: '2026-07-13', done: true });
  await page.reload();

  await expect(ring(page)).toHaveText('0/1');
});

test('eine wöchentliche Routine, die heute abgehakt wurde, bleibt im Ring (kein Rückwärtssprung) (issue #503 AC2)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const habitId = await seedHabit(page, {
    name: 'Joggen',
    schedule: 'weekly',
    color: null,
    archivedAt: null,
  });
  await expect(ring(page)).toHaveText('0/1');

  await seedHabitLog(page, { habitId, logDate: '2026-07-15', done: true });
  await page.reload();

  await expect(ring(page)).toHaveText('1/1');
});

test('eine monatliche Routine, die am 3. abgehakt wurde, fällt am 4. aus dem Ring heraus (issue #509 AC4)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const habitId = await seedHabit(page, {
    name: 'Miete überweisen',
    schedule: 'monthly',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: '2026-07-03', done: true });

  await skewClock(page, '2026-07-04T09:00:00.000Z');
  await page.reload();

  await expect(ring(page)).toHaveCount(0);
});

test('die monatliche Routine ist im neuen Monat wieder offen (issue #509 AC5)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const habitId = await seedHabit(page, {
    name: 'Miete überweisen',
    schedule: 'monthly',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: '2026-07-03', done: true });

  await skewClock(page, '2026-08-01T09:00:00.000Z');
  await page.reload();

  await expect(ring(page)).toHaveText('0/1');
});
