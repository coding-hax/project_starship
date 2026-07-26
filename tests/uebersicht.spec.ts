import { expect, test, type Locator, type Page } from '@playwright/test';
import { openMeteoForecastBody, registerPasskey, resetAppData, skewClock } from './helpers';

/** Fixes "now" so due-today vs. overdue vs. future is deterministic (issue #87). */
const NOW = '2026-07-18T12:00:00.000Z';
const YESTERDAY_MORNING = '2026-07-17T09:00:00.000Z';
const YESTERDAY_EVENING = '2026-07-17T18:00:00.000Z';
const TODAY_EVENING = '2026-07-18T18:00:00.000Z';
const TOMORROW_MORNING = '2026-07-19T09:00:00.000Z';
/** Same wall-clock moment as NOW, one day later — for the day-change assertions. */
const TOMORROW_NOON = '2026-07-19T12:00:00.000Z';
const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';

function dueTaskItems(page: Page) {
  // Labelled by the visible <h2>Aufgaben</h2> above it, not its own aria-label
  // (issue #157 AC: no double announcement).
  return page.getByRole('list', { name: 'Aufgaben' }).getByRole('listitem');
}

/** Vertical distance between the bottom of `above` and the top of `below`. */
async function gapBetween(above: Locator, below: Locator): Promise<number> {
  const top = await above.boundingBox();
  const bottom = await below.boundingBox();
  if (!top || !bottom) throw new Error('Beide Überschriften müssen sichtbar sein');
  return bottom.y - (top.y + top.height);
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
  // spec). registerPasskey below already lands on /uebersicht, which fires the first
  // forecast fetch — without this, that request would hit the real network and
  // cache real data before a per-test mock ever gets a chance to register.
  await page.route(OPEN_METEO_PATTERN, (route) => route.abort('failed'));
  await registerPasskey(page);
  await skewClock(page, NOW);
});

test('/uebersicht listet offene Aufgaben, fällig heute oder überfällig (issue #87 AC1)', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  await seedTask(page, { title: 'Überfällig', dueAt: YESTERDAY_MORNING });
  await seedTask(page, { title: 'Heute fällig', dueAt: TODAY_EVENING });
  await seedTask(page, { title: 'Erst morgen', dueAt: TOMORROW_MORNING });
  await seedTask(page, { title: 'Ohne Fälligkeit' });
  await seedTask(page, {
    title: 'Heute erledigt',
    dueAt: YESTERDAY_MORNING,
    completedAt: NOW,
  });
  await seedTask(page, {
    title: 'Gestern erledigt',
    dueAt: YESTERDAY_MORNING,
    completedAt: YESTERDAY_EVENING,
  });
  // Never listed while open, so being checked off today does not pull it in
  // (issue #228 AC4).
  await seedTask(page, {
    title: 'Morgen fällig, heute erledigt',
    dueAt: TOMORROW_MORNING,
    completedAt: NOW,
  });

  await expect(page.getByText('Überfällig')).toBeVisible();
  await expect(page.getByText('Heute fällig')).toBeVisible();
  // Checked off today, so it stays for the rest of the day (issue #228 AC1).
  await expect(page.getByText('Heute erledigt')).toBeVisible();
  await expect(dueTaskItems(page)).toHaveCount(3);
  await expect(page.getByText('Erst morgen')).toHaveCount(0);
  await expect(page.getByText('Ohne Fälligkeit')).toHaveCount(0);
  await expect(page.getByText('Gestern erledigt')).toHaveCount(0);
  await expect(page.getByText('Morgen fällig, heute erledigt')).toHaveCount(0);
});

test('ein gestalteter Leerzustand statt einer leeren Fläche (issue #87 AC2)', async ({ page }) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Erst morgen', dueAt: TOMORROW_MORNING });

  await expect(page.getByText('Nichts fällig. Genieß den Tag.')).toBeVisible();
});

test('die Übersicht-Liste nutzt dieselbe TaskItem-Zeile wie /aufgaben — das Häkchen erledigt sofort, die Zeile bleibt den Tag über stehen (issue #87 AC3, issue #228 AC1+AC5)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Wird erledigt', dueAt: YESTERDAY_MORNING, priority: 2 });

  await expect(dueTaskItems(page).locator('.task-list__priority-dot')).toHaveClass(
    /task-list__priority-dot--dringend/,
  );
  // Overdue while open — red. After the check-off it must not shout any more.
  await expect(dueTaskItems(page).locator('.task-list__due')).toHaveClass(
    /task-list__due--overdue/,
  );

  const checkbox = page.getByRole('checkbox', { name: 'Wird erledigt als erledigt markieren' });
  await checkbox.click();

  // Not `page.getByText('Wird erledigt')` — the undo toast's own text ("„Wird
  // erledigt" erledigt") contains that same substring, scoped to the list instead.
  await expect(dueTaskItems(page)).toHaveCount(1);
  await expect(dueTaskItems(page).first()).toHaveClass(/task-list__item--done/);
  await expect(checkbox).toBeChecked();
  await expect(dueTaskItems(page).locator('.task-list__due')).not.toHaveClass(
    /task-list__due--overdue/,
  );
  await expect(page.getByText('Nichts fällig. Genieß den Tag.')).toHaveCount(0);

  // The row stays reachable, so the same tap takes it back (issue #228 AC5).
  await checkbox.click();
  await expect(dueTaskItems(page)).toHaveCount(1);
  await expect(checkbox).not.toBeChecked();
  await expect(dueTaskItems(page).first()).not.toHaveClass(/task-list__item--done/);
});

test('am Folgetag ist die gestern abgehakte Aufgabe aus der Übersicht verschwunden (issue #228 AC2+AC3)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Wird erledigt', dueAt: YESTERDAY_MORNING });

  await page.getByRole('checkbox', { name: 'Wird erledigt als erledigt markieren' }).click();
  await expect(dueTaskItems(page)).toHaveCount(1);

  await skewClock(page, TOMORROW_NOON);
  await page.reload();

  await expect(dueTaskItems(page)).toHaveCount(0);
  await expect(page.getByText('Nichts fällig. Genieß den Tag.')).toBeVisible();
});

test('ohne fällige Aufgabe rückt der Leerzustand nicht auseinander — der Abstand zwischen den Abschnitten bleibt wie mit einer Aufgabe (issue #228 AC6)', async ({
  page,
}) => {
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/uebersicht');

    const aufgaben = page.getByRole('heading', { name: 'Aufgaben', level: 2 });
    const gewohnheiten = page.getByRole('heading', { name: 'Gewohnheiten', level: 2 });
    await expect(page.getByText('Nichts fällig. Genieß den Tag.')).toBeVisible();
    const emptyGap = await gapBetween(aufgaben, gewohnheiten);

    const id = await seedTask(page, { title: 'Eine Aufgabe', dueAt: YESTERDAY_MORNING });
    await expect(dueTaskItems(page)).toHaveCount(1);
    const filledGap = await gapBetween(aufgaben, gewohnheiten);

    // The empty state occupies one card's box, so the two gaps differ by rounding
    // at most. Anything beyond that is the hole this ticket is about — the numbers
    // travel in the message, so a red run says how far off it is.
    expect(
      Math.abs(emptyGap - filledGap),
      `leer ${emptyGap}px vs. mit Aufgabe ${filledGap}px bei ${width}px`,
    ).toBeLessThanOrEqual(8);

    await page.evaluate(
      (rowId) => window.__starship.mutate({ table: 'tasks', rowId, op: 'delete' }),
      id,
    );
    await expect(dueTaskItems(page)).toHaveCount(0);
  }
});

test('kein "Gewohnheiten verwalten"-Link mehr auf /uebersicht — der Nav-Tab bleibt der Weg (issue #137 AC1+AC2)', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  await expect(page.getByRole('link', { name: 'Gewohnheiten verwalten' })).toHaveCount(0);

  await page
    .getByRole('navigation', { name: 'Hauptnavigation' })
    .getByRole('link', { name: 'Gewohnheiten' })
    .click();
  await expect(page).toHaveURL(/\/gewohnheiten$/);
  await expect(
    page.getByRole('heading', { name: 'Gewohnheiten verwalten', level: 1 }),
  ).toBeVisible();
});

test('über der Aufgabenliste steht ein sichtbares <h2>Aufgaben</h2>, gestaltet wie „Gewohnheiten" (issue #157 AC5)', async ({
  page,
}) => {
  await page.goto('/uebersicht');

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
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Heute fällig', dueAt: TODAY_EVENING });

  const list = page.getByRole('list', { name: 'Aufgaben' });
  await expect(list).toBeVisible();
  await expect(list).toHaveAttribute('aria-labelledby', 'uebersicht-aufgaben-heading');
  expect(await list.getAttribute('aria-label')).toBeNull();
});

test('Tab-Sonne und Wetter-Sonne sind auf demselben Bildschirm eindeutig unterscheidbar (issue #157 AC3)', async ({
  page,
}) => {
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
        weatherCodes: dates.map(() => 0), // 0 = klar -> IconWeatherClear
        tempsMax: dates.map(() => 20),
        tempsMin: dates.map(() => 10),
      }),
    }),
  );
  await page.goto('/uebersicht');

  const todaySunSvg = page
    .getByRole('navigation', { name: 'Hauptnavigation' })
    .getByRole('link', { name: 'Übersicht' })
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
