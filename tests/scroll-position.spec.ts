import { expect, test, type Page } from '@playwright/test';
import { openMeteoForecastBody, registerPasskey, resetAppData, skewClock } from './helpers';

/** Same fixed "now" convention as uebersicht.spec.ts. */
const NOW = '2026-07-18T12:00:00.000Z';
const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';

const TALL_HISTORY_COUNT = 20;
/** The seeded completed-today tasks plus one still-open one (below). */
const TASK_ROW_COUNT = TALL_HISTORY_COUNT + 1;

test.beforeEach(async ({ page }) => {
  await resetAppData();
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  // Every /uebersicht visit fires the weather fetch — aborted by default like
  // weather.spec.ts/uebersicht.spec.ts, so it never leaks into a `networkidle`
  // wait. The one test below that needs a real forecast overrides this.
  await page.route(OPEN_METEO_PATTERN, (route) => route.abort('failed'));
  await registerPasskey(page);
  await skewClock(page, NOW);
});

async function seedTask(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: p }),
    payload,
  );
}

/**
 * Enough completed-today history plus one still-open task to overflow both
 * /uebersicht's embedded Aufgaben section and the full /aufgaben list on the
 * 375×812 test viewport — and, on /aufgaben, to give its own scroll anchor
 * (issue #88) something to land on below the fold.
 */
async function seedTallTaskHistory(page: Page) {
  for (let i = 0; i < TALL_HISTORY_COUNT; i++) {
    await seedTask(page, {
      title: `Erledigt ${i}`,
      createdAt: new Date(Date.UTC(2026, 6, 18, 0, i)).toISOString(),
      dueAt: NOW,
      completedAt: NOW,
    });
  }
  await seedTask(page, {
    title: 'Ältestes offenes Todo',
    createdAt: new Date(Date.UTC(2026, 6, 18, 1, 0)).toISOString(),
    dueAt: NOW,
  });
}

/** Same accessible name on both /uebersicht (aria-labelledby the <h2>) and
 *  /aufgaben (aria-label directly) — see task-list.tsx. */
function taskListItems(page: Page) {
  return page.getByRole('list', { name: 'Aufgaben' }).getByRole('listitem');
}

function nav(page: Page) {
  return page.getByRole('navigation', { name: 'Hauptnavigation' });
}

async function goToAufgabenAndScrollDown(page: Page) {
  await page.goto('/aufgaben');
  await expect(taskListItems(page)).toHaveCount(TASK_ROW_COUNT);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
}

async function goToUebersichtAndScrollDown(page: Page) {
  await page.goto('/uebersicht');
  await expect(taskListItems(page)).toHaveCount(TASK_ROW_COUNT);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
}

test('Übersicht startet oben, auch mit reichlich erledigter Aufgaben-Historie (issue #647 AC1)', async ({
  page,
}) => {
  await seedTallTaskHistory(page);
  await page.goto('/uebersicht');

  // Waits past the async liveQuery load — the check below then holds against
  // the settled state, not just the first frame.
  await expect(taskListItems(page)).toHaveCount(TASK_ROW_COUNT);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.locator('.weather-forecast')).toBeVisible();
});

test('von einer heruntergescrollten Seite per Bottom-Nav auf die Übersicht wechseln landet oben (issue #647 AC2)', async ({
  page,
}) => {
  await seedTallTaskHistory(page);
  await goToAufgabenAndScrollDown(page);

  await nav(page).getByRole('link', { name: 'Übersicht', exact: true }).click();
  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test('keine Seite erbt die Scrollposition der vorherigen — anker-lose Routen landen oben, Aufgaben und Kalender an ihrem eigenen Startpunkt (issue #647 AC3)', async ({
  page,
}) => {
  await seedTallTaskHistory(page);

  const anchorLessRoutes: { path: string; label: string }[] = [
    { path: '/uebersicht', label: 'Übersicht' },
    { path: '/routinen', label: 'Routinen' },
    { path: '/journal', label: 'Journal' },
    { path: '/aktivitaeten', label: 'Aktivitäten' },
  ];

  for (const { path, label } of anchorLessRoutes) {
    await goToAufgabenAndScrollDown(page);
    await nav(page).getByRole('link', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  }

  // Aufgaben and Kalender keep their own on-mount anchor (issue #88; Kalender's
  // agenda anchor is untouched by this ticket) — arriving via in-app navigation
  // must match a fresh direct load of the very same route, not a blanket 0.
  await page.goto('/aufgaben');
  await expect(taskListItems(page)).toHaveCount(TASK_ROW_COUNT);
  const aufgabenReference = await page.evaluate(() => window.scrollY);
  expect(aufgabenReference).toBeGreaterThan(0);

  await goToUebersichtAndScrollDown(page);
  await nav(page).getByRole('link', { name: 'Aufgaben', exact: true }).click();
  await expect(page).toHaveURL(/\/aufgaben$/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(aufgabenReference);

  await page.goto('/kalender');
  const kalenderReference = await page.evaluate(() => window.scrollY);

  await goToUebersichtAndScrollDown(page);
  await nav(page).getByRole('link', { name: 'Kalender', exact: true }).click();
  await expect(page).toHaveURL(/\/kalender$/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(kalenderReference);
});

test('Browser-Zurück landet wieder auf dem Startpunkt der vorherigen Seite, nicht auf der verlassenen Position (issue #647 AC4)', async ({
  page,
}) => {
  await seedTallTaskHistory(page);

  await page.goto('/aufgaben');
  await expect(taskListItems(page)).toHaveCount(TASK_ROW_COUNT);
  const aufgabenStart = await page.evaluate(() => window.scrollY);
  expect(aufgabenStart).toBeGreaterThan(0);

  // Scrolled further than the anchor's own resting point, so a restored old
  // position is distinguishable from a fresh return to the start point.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const scrolledFurther = await page.evaluate(() => window.scrollY);
  expect(scrolledFurther).toBeGreaterThan(aufgabenStart);

  await nav(page).getByRole('link', { name: 'Übersicht', exact: true }).click();
  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  await page.goBack();
  await expect(page).toHaveURL(/\/aufgaben$/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(aufgabenStart);
});

test('der Sprung zum Seitenanfang stiehlt keinen Fokus und läuft ohne Animation, auch mit reduzierter Bewegung (issue #647 AC6+AC7)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const dates = [
    '2026-07-18',
    '2026-07-19',
    '2026-07-20',
    '2026-07-21',
    '2026-07-22',
    '2026-07-23',
    '2026-07-24',
  ];
  await page.route(OPEN_METEO_PATTERN, (route) =>
    route.fulfill({
      json: openMeteoForecastBody({
        dates,
        tempsMax: dates.map(() => 20),
        tempsMin: dates.map(() => 10),
      }),
    }),
  );
  await seedTallTaskHistory(page);
  await page.goto('/uebersicht');
  await expect(taskListItems(page)).toHaveCount(TASK_ROW_COUNT);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  await page.locator('.weather-forecast').locator('a.weather-forecast__day-link').first().click();
  await expect(page).toHaveURL(/\/wetter\//);

  // Instant, not animated — window.scrollTo(0, 0) never opts into a CSS
  // scroll-behavior: smooth (never set anywhere in this codebase, tokens.css
  // only ever forces it back to `auto`), so this holds immediately, not just
  // eventually.
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  // Issue #233's fix (the <header> itself, not the link, absorbs the App
  // Router's post-navigation focus) still holds — our own scroll jump never
  // calls .focus() on anything.
  await expect(page.locator('.weather-day__back')).not.toBeFocused();
});
