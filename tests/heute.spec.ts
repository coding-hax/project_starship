import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, skewClock } from './helpers';

/** Fixes "now" so due-today vs. overdue vs. future is deterministic (issue #87). */
const NOW = '2026-07-18T12:00:00.000Z';
const YESTERDAY_MORNING = '2026-07-17T09:00:00.000Z';
const TODAY_EVENING = '2026-07-18T18:00:00.000Z';
const TOMORROW_MORNING = '2026-07-19T09:00:00.000Z';
const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';

function dueTaskItems(page: Page) {
  // Labelled by the visible <h2>Aufgaben</h2> above it, not its own aria-label
  // (issue #157 AC: no double announcement).
  return page.getByRole('list', { name: 'Aufgaben' }).getByRole('listitem');
}

async function seedTask(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: p }),
    payload,
  );
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // The list must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  // Default: abort, like weather.spec.ts (the real API is never reachable from a
  // spec). registerPasskey below already lands on /heute, which fires the first
  // forecast fetch — without this, that request would hit the real network and
  // cache real data before a per-test mock ever gets a chance to register.
  await page.route(OPEN_METEO_PATTERN, (route) => route.abort('failed'));
  await registerPasskey(page);
  await skewClock(page, NOW);
});

test('/heute listet offene Aufgaben, fällig heute oder überfällig (issue #87 AC1)', async ({
  page,
}) => {
  await page.goto('/heute');

  await seedTask(page, { title: 'Überfällig', dueAt: YESTERDAY_MORNING });
  await seedTask(page, { title: 'Heute fällig', dueAt: TODAY_EVENING });
  await seedTask(page, { title: 'Erst morgen', dueAt: TOMORROW_MORNING });
  await seedTask(page, { title: 'Ohne Fälligkeit' });
  const doneId = await seedTask(page, { title: 'Erledigt, war überfällig', dueAt: YESTERDAY_MORNING });
  await page.evaluate(
    (rowId) =>
      window.__starship.mutate({
        table: 'tasks',
        rowId,
        op: 'upsert',
        payload: { completedAt: new Date().toISOString() },
      }),
    doneId,
  );

  await expect(page.getByText('Überfällig')).toBeVisible();
  await expect(page.getByText('Heute fällig')).toBeVisible();
  await expect(dueTaskItems(page)).toHaveCount(2);
  await expect(page.getByText('Erst morgen')).toHaveCount(0);
  await expect(page.getByText('Ohne Fälligkeit')).toHaveCount(0);
  await expect(page.getByText('Erledigt, war überfällig')).toHaveCount(0);
});

test('ein gestalteter Leerzustand statt einer leeren Fläche (issue #87 AC2)', async ({ page }) => {
  await page.goto('/heute');
  await seedTask(page, { title: 'Erst morgen', dueAt: TOMORROW_MORNING });

  await expect(page.getByText('Nichts fällig. Genieß den Tag.')).toBeVisible();
});

test('die Heute-Liste nutzt dieselbe TaskItem-Zeile wie /aufgaben — Häkchen erledigt sofort und lässt die Aufgabe verschwinden (issue #87 AC3)', async ({
  page,
}) => {
  await page.goto('/heute');
  await seedTask(page, { title: 'Wird erledigt', dueAt: YESTERDAY_MORNING, priority: 2 });

  await expect(dueTaskItems(page).locator('.task-list__priority-dot')).toHaveClass(
    /task-list__priority-dot--dringend/,
  );

  await page.getByRole('checkbox', { name: 'Wird erledigt als erledigt markieren' }).click();

  // Not `page.getByText('Wird erledigt')` — the undo toast's own text ("„Wird
  // erledigt" erledigt") contains that same substring, scoped to the list instead.
  await expect(dueTaskItems(page)).toHaveCount(0);
  await expect(page.getByText('Nichts fällig. Genieß den Tag.')).toBeVisible();
});

test('kein "Gewohnheiten verwalten"-Link mehr auf /heute — der Nav-Tab bleibt der Weg (issue #137 AC1+AC2)', async ({
  page,
}) => {
  await page.goto('/heute');

  await expect(page.getByRole('link', { name: 'Gewohnheiten verwalten' })).toHaveCount(0);

  await page
    .getByRole('navigation', { name: 'Hauptnavigation' })
    .getByRole('link', { name: 'Gewohnheiten' })
    .click();
  await expect(page).toHaveURL(/\/gewohnheiten$/);
  await expect(page.getByRole('heading', { name: 'Gewohnheiten verwalten', level: 1 })).toBeVisible();
});

test('über der Aufgabenliste steht ein sichtbares <h2>Aufgaben</h2>, gestaltet wie „Gewohnheiten" (issue #157 AC5)', async ({
  page,
}) => {
  await page.goto('/heute');

  const aufgabenHeading = page.getByRole('heading', { name: 'Aufgaben', level: 2 });
  const gewohnheitenHeading = page.getByRole('heading', { name: 'Gewohnheiten', level: 2 });
  await expect(aufgabenHeading).toBeVisible();
  await expect(gewohnheitenHeading).toBeVisible();

  const [aufgabenStyle, gewohnheitenStyle] = await Promise.all([
    aufgabenHeading.evaluate((el) => {
      const s = getComputedStyle(el);
      return { fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color, margin: s.margin };
    }),
    gewohnheitenHeading.evaluate((el) => {
      const s = getComputedStyle(el);
      return { fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color, margin: s.margin };
    }),
  ]);
  expect(aufgabenStyle).toEqual(gewohnheitenStyle);
});

test('die Aufgabenliste wird nicht doppelt angesagt — die Überschrift benennt sie statt eines eigenen aria-label (issue #157 AC6)', async ({
  page,
}) => {
  await page.goto('/heute');
  await seedTask(page, { title: 'Heute fällig', dueAt: TODAY_EVENING });

  const list = page.getByRole('list', { name: 'Aufgaben' });
  await expect(list).toBeVisible();
  await expect(list).toHaveAttribute('aria-labelledby', 'heute-aufgaben-heading');
  expect(await list.getAttribute('aria-label')).toBeNull();
});

test('Tab-Sonne und Wetter-Sonne sind auf demselben Bildschirm eindeutig unterscheidbar (issue #157 AC3)', async ({
  page,
}) => {
  const dates = ['2026-07-18', '2026-07-19', '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24'];
  await page.route(OPEN_METEO_PATTERN, (route) =>
    route.fulfill({
      json: {
        daily: {
          time: dates,
          weather_code: dates.map(() => 0), // 0 = klar -> IconWeatherClear
          temperature_2m_max: dates.map(() => 20),
          temperature_2m_min: dates.map(() => 10),
          precipitation_probability_max: dates.map(() => 0),
        },
      },
    }),
  );
  await page.goto('/heute');

  const todaySunSvg = page
    .getByRole('navigation', { name: 'Hauptnavigation' })
    .getByRole('link', { name: 'Heute' })
    .locator('svg');
  const weatherSunSvg = page.getByRole('img', { name: 'Klar' }).first().locator('svg');
  await expect(weatherSunSvg).toBeVisible();

  const [todayCircleR, weatherCircleR, todayPathD, weatherPathD] = await Promise.all([
    todaySunSvg.locator('circle').first().getAttribute('r'),
    weatherSunSvg.locator('circle').first().getAttribute('r'),
    todaySunSvg.locator('path').first().getAttribute('d'),
    weatherSunSvg.locator('path').first().getAttribute('d'),
  ]);
  expect(todayCircleR).not.toBe(weatherCircleR);
  expect(todayPathD).not.toBe(weatherPathD);
});
