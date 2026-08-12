import { expect, test, type Page } from '@playwright/test';
import { openMeteoForecastBody, registerPasskey, resetAppData, skewClock } from './helpers';

/** Same fixed "now" convention as uebersicht.spec.ts. */
const NOW = '2026-07-18T12:00:00.000Z';
const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';

/**
 * Completed-today history seeded *above* and *below* the single open task, so the
 * open task lands in the MIDDLE of the /aufgaben list rather than at its end. That
 * placement is what AC4 needs: the #88 anchor rests the open task with real content
 * still below it, so a scroll position *past* the anchor exists and is
 * distinguishable from the anchor's own start point. With the open task last the
 * anchor would sit at the document's max scroll, and "scrolled further" could not
 * differ from "returned to start". Both counts also overflow /uebersicht and the
 * full /aufgaben list by several screenfuls on the 375×812 test viewport.
 */
const HISTORY_ABOVE = 5;
const HISTORY_BELOW = 20;
/** All seeded completed-today rows plus the one still-open task between them. */
const TASK_ROW_COUNT = HISTORY_ABOVE + 1 + HISTORY_BELOW;

// These tests navigate through many routes, and on the dev server every route
// compiles on first visit — this spec is the only one that reaches /routinen,
// /journal, /aktivitaeten and /kalender, so it pays all of those cold compiles on
// top of repeatedly rendering the tall task list. The heaviest case sits just over
// Playwright's default 30s; give the whole file room the same way journal-key-race
// does (test.describe.configure), rather than trimming coverage. Not a flake mask:
// the assertions are unchanged and pass with time, nothing is being papered over.
test.describe.configure({ timeout: 60_000 });

test.beforeEach(async ({ page }) => {
  await resetAppData();
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  // The weather fetch is fulfilled (not aborted) for the whole spec, and registered
  // here before any navigation so both the initial load and the periodic
  // refreshIfStale succeed. A failed fetch logs `console.error('[weather] refresh
  // failed', …)` — harmless for the app, but Next.js's dev overlay turns that into a
  // `<nextjs-portal>` badge pinned over the bottom-left nav slots that silently eats
  // their clicks, and the failing refresh re-renders the forecast mid-click. Both are
  // pure test-environment artefacts; a successful forecast removes them. It also keeps
  // the fetch from leaking into any `networkidle` wait.
  await mockWeatherForecast(page);
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
 * Seeds a tall running list (issue #88 orders it strictly by `createdAt`): a block
 * of completed-today history, then the single still-open task, then more completed
 * history below it. See `HISTORY_ABOVE`/`HISTORY_BELOW` for why the open task sits
 * in the middle rather than at the end.
 */
async function seedTallTaskHistory(page: Page) {
  let minute = 0;
  const seedCompleted = (index: number) =>
    seedTask(page, {
      title: `Erledigt ${index}`,
      createdAt: new Date(Date.UTC(2026, 6, 18, 0, minute++)).toISOString(),
      dueAt: NOW,
      completedAt: NOW,
    });
  for (let i = 0; i < HISTORY_ABOVE; i++) await seedCompleted(i);
  await seedTask(page, {
    title: 'Ältestes offenes Todo',
    createdAt: new Date(Date.UTC(2026, 6, 18, 0, minute++)).toISOString(),
    dueAt: NOW,
  });
  for (let i = 0; i < HISTORY_BELOW; i++) await seedCompleted(HISTORY_ABOVE + i);
}

/** Same accessible name on both /uebersicht (aria-labelledby the <h2>) and
 *  /aufgaben (aria-label directly) — see task-list.tsx. */
function taskListItems(page: Page) {
  return page.getByRole('list', { name: 'Aufgaben' }).getByRole('listitem');
}

function nav(page: Page) {
  return page.getByRole('navigation', { name: 'Hauptnavigation' });
}

/**
 * Aktivitäten is the sixth bottom-nav entry (issue #180), so on the 375px viewport
 * the nav is a horizontal carousel (issue #205) and its last item sits off-screen —
 * not reliably clickable. This ticket is about the scroll position *after* an in-app
 * navigation, not about the carousel, so flatten every slot to fit all six without
 * overflow (the same lever nav-order.mobile.spec.ts uses). It must be an init script
 * armed before the navigation that installs it, and it retries until `<head>` exists,
 * because `addInitScript` runs before the document has parsed a single tag.
 */
async function fitAllNavItems(page: Page) {
  await page.addInitScript(() => {
    const install = () => {
      if (!document.head) {
        requestAnimationFrame(install);
        return;
      }
      const style = document.createElement('style');
      style.textContent = '.nav__item { flex-basis: 16% !important; }';
      document.head.appendChild(style);
    };
    install();
  });
}

/**
 * A successful open-meteo forecast for the week starting at NOW, wired up in
 * `beforeEach` (see there for why a *successful* forecast matters). AC6 also relies
 * on it rendering real day-links to /wetter/<date>.
 */
async function mockWeatherForecast(page: Page) {
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

// AC3 is split across the next two tests, one per half of its definition. Kept
// apart on purpose, not merged for tidiness: on the dev server every route
// compiles on first visit, and *this* spec is the only one that reaches
// /routinen, /journal, /aktivitaeten and /kalender — one test walking all of them
// plus the tall-list renders overruns Playwright's 30s per-test budget. Each half
// pays only its own share and stays inside it, without touching the timeout.
test('keine anker-lose Route erbt die Scrollposition der vorherigen — alle landen oben (issue #647 AC3)', async ({
  page,
}) => {
  await seedTallTaskHistory(page);
  // Reach Aktivitäten (carousel overflow) by a plain click like every other tab.
  await fitAllNavItems(page);

  const anchorLessRoutes: { path: string; label: string }[] = [
    { path: '/uebersicht', label: 'Übersicht' },
    { path: '/routinen', label: 'Routinen' },
    { path: '/journal', label: 'Journal' },
    { path: '/aktivitaeten', label: 'Aktivitäten' },
  ];

  // The navigation under test is always "a scrolled /aufgaben → route B". The tall
  // /aufgaben page is loaded once; every following Seite A is reached by an in-app
  // nav click rather than a fresh `page.goto`, so the loop pays a full app reload
  // (IndexedDB re-init, re-hydrate) once instead of four times — four reloads
  // overran the 30s budget on the dev server, this keeps the same coverage inside it.
  const scrollAufgabenAsSeiteA = async () => {
    await nav(page).getByRole('link', { name: 'Aufgaben', exact: true }).click();
    await expect(page).toHaveURL(/\/aufgaben$/);
    await expect(taskListItems(page)).toHaveCount(TASK_ROW_COUNT);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  };

  await goToAufgabenAndScrollDown(page);
  for (let i = 0; i < anchorLessRoutes.length; i++) {
    if (i > 0) await scrollAufgabenAsSeiteA();
    const { path, label } = anchorLessRoutes[i];
    await nav(page).getByRole('link', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  }
});

test('Aufgaben und Kalender landen bei In-App-Navigation auf ihrem eigenen Startpunkt, nicht auf 0 (issue #647 AC3)', async ({
  page,
}) => {
  await seedTallTaskHistory(page);
  await fitAllNavItems(page);

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
