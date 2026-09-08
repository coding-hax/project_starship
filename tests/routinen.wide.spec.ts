import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, skewClock } from './helpers';

/**
 * Dritte Desktop-Stufe (issue #1125, Nachfolger von #1117/#1123, ADR-0030):
 * ab 1440px steht die Routinen-Tabelle links über beide Inhaltszeilen, rechts
 * daneben die vier Kacheln über der 30-Tage-Verlaufskarte. Läuft im
 * `desktop-wide`-Messplatz (1800 × 1000, playwright.config.ts), wie
 * kalender.wide.spec.ts/seitenkopf.wide.spec.ts. AK5 schaltet innerhalb
 * seines eigenen Tests per `setViewportSize` auf 1280/375 zurück, statt
 * eigene Dateien für `desktop`/`mobile` anzulegen — die bisherige gestapelte
 * Reihenfolge dort bürgt sonst schon routinen.spec.ts AK1.
 */

const NOW = '2026-07-15T12:00:00.000Z';
const TODAY = '2026-07-15';

async function seedHabit(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) =>
      window.__starship.mutate({
        table: 'habits',
        op: 'upsert',
        payload: { schedule: 'daily', color: null, archivedAt: null, ...p },
      }),
    payload,
  );
}

async function seedHabitLog(page: Page, habitId: string, logDate: string, done = true): Promise<void> {
  await page.evaluate(
    ({ habitId, logDate, done }) =>
      window.__starship.mutate({
        table: 'habit_logs',
        op: 'upsert',
        payload: { habitId, logDate, done },
      }),
    { habitId, logDate, done },
  );
}

/**
 * A dozen active habits — collapsed rows alone already outgrow the tiles +
 * history card combined (AK1/AK3 need that overheight to be meaningful: a
 * short table wouldn't exercise the `grid-template-rows: … minmax(0, 1fr)`
 * guard at all).
 */
async function seedTallTable(page: Page, count: number): Promise<string> {
  let firstId = '';
  for (let i = 0; i < count; i++) {
    const id = await seedHabit(page, { name: `Tabellen-Sonde ${i}` });
    if (i === 0) firstId = id;
  }
  return firstId;
}

/** Runs entirely inside the page — 1284 individual round-trips through
 *  Playwright's evaluate bridge would be the slow way to seed this (AK2's
 *  "1284 mal" only needs the *count* of done logs, `HabitTiles`' `totalDone`
 *  doesn't dedupe by date, so reusing one long-past date for all of them is
 *  fine offline: the sync route is aborted in `beforeEach`, and the
 *  (habitId, logDate) unique index only lives server-side, drizzle
 *  schema.ts). */
async function seedManyDoneLogs(page: Page, habitId: string, count: number): Promise<void> {
  await page.evaluate(
    ({ habitId, count }) =>
      Promise.all(
        Array.from({ length: count }, () =>
          window.__starship.mutate({
            table: 'habit_logs',
            op: 'upsert',
            payload: { habitId, logDate: '2000-01-01', done: true },
          }),
        ),
      ),
    { habitId, count },
  );
}

/** Mirrors routinen.spec.ts's own `resolveColorToken`, for a length instead of a color. */
async function resolveSpaceToken(page: Page, token: string): Promise<number> {
  return page.evaluate((cssVar) => {
    const probe = document.createElement('span');
    probe.style.marginTop = `var(${cssVar})`;
    document.body.appendChild(probe);
    const value = parseFloat(getComputedStyle(probe).marginTop);
    probe.remove();
    return value;
  }, token);
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // The page must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await registerPasskey(page, '/routinen');
  await skewClock(page, NOW);
});

/* -------------------------------------------------------------------------- */
/* AK1: Tabelle links über beide Inhaltszeilen, Kacheln + Verlauf rechts      */
/* -------------------------------------------------------------------------- */

test('die Tabelle steht links über beide Inhaltszeilen, rechts stehen die Kacheln über der Verlaufskarte (issue #1125 AK1)', async ({
  page,
}) => {
  await seedTallTable(page, 12);
  await page.goto('/routinen');

  const table = page.locator('.habit-table');
  const tiles = page.locator('.habit-tiles');
  const history = page.locator('.habit-history-card');
  await expect(table).toBeVisible();
  await expect(tiles).toBeVisible();
  await expect(history).toBeVisible();

  const [tableBox, tilesBox, historyBox] = await Promise.all([
    table.boundingBox(),
    tiles.boundingBox(),
    history.boundingBox(),
  ]);
  if (!tableBox || !tilesBox || !historyBox) throw new Error('AK1: Karte ohne BoundingBox');

  // Tabelle links, Kacheln/Verlauf rechts daneben.
  expect(tableBox.x).toBeLessThan(tilesBox.x);
  expect(tableBox.x + tableBox.width).toBeLessThanOrEqual(tilesBox.x + 1);
  expect(Math.abs(tilesBox.x - historyBox.x), 'Kacheln und Verlauf in derselben Spalte').toBeLessThanOrEqual(1);

  // Kacheln oben, Verlauf darunter — beide rechts.
  expect(tilesBox.y).toBeLessThan(historyBox.y);

  // Die Tabelle beginnt auf Höhe der Kacheln (Zeile 2) und reicht über deren
  // Ende hinaus (in Zeile 3, wo der Verlauf steht) — "über beide
  // Inhaltszeilen".
  expect(Math.abs(tableBox.y - tilesBox.y), 'Tabelle startet auf Kachel-Höhe').toBeLessThanOrEqual(1);
  expect(
    tableBox.y + tableBox.height,
    'Tabelle reicht über das Ende der Kacheln hinaus',
  ).toBeGreaterThan(tilesBox.y + tilesBox.height);
});

/* -------------------------------------------------------------------------- */
/* AK2: rechte Spalte 440px, „1284 mal" bricht nicht um                      */
/* -------------------------------------------------------------------------- */

test('die rechte Spalte ist 440px breit, und eine vierstellige Total-Zahl bricht nicht um (issue #1125 AK2)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, { name: 'Total-Sonde' });
  await seedManyDoneLogs(page, habitId, 1284);
  await page.goto('/routinen');

  const columns = await page
    .locator("[data-ground='routinen']")
    .evaluate((el) => getComputedStyle(el).gridTemplateColumns);
  const [, right] = columns.split(' ');
  expect(parseFloat(right), `grid-template-columns: ${columns}`).toBeCloseTo(440, 0);

  const totalTile = page.locator('.habit-tiles__tile').nth(3);
  await expect(totalTile.locator('.habit-tiles__label')).toHaveText('Total');
  await expect(totalTile.locator('.habit-tiles__value')).toHaveText('1284');
  await expect(totalTile.locator('.habit-tiles__denominator')).toHaveText('mal');

  // Bricht die Zeile um, wächst ihre Höhe auf etwa das Doppelte einer
  // einzeiligen Kachel (HEUTE, immer kurz) — statt eine feste Pixelzahl zu
  // raten, vergleicht das gegen die garantiert einzeilige Nachbarkachel.
  const [heuteRowHeight, totalRowHeight] = await Promise.all([
    page.locator('.habit-tiles__tile').nth(0).locator('.habit-tiles__value-row').evaluate((el) => el.getBoundingClientRect().height),
    totalTile.locator('.habit-tiles__value-row').evaluate((el) => el.getBoundingClientRect().height),
  ]);
  expect(totalRowHeight, '"1284 mal" bleibt einzeilig').toBeLessThanOrEqual(heuteRowHeight + 2);
});

/* -------------------------------------------------------------------------- */
/* AK3: höchstens --space-4 zwischen Kacheln und Verlaufskarte, auch wenn    */
/* die Tabelle deutlich höher ist als beide zusammen                         */
/* -------------------------------------------------------------------------- */

test('zwischen Kacheln und Verlaufskarte liegt höchstens --space-4, auch wenn die spannende Tabelle deutlich höher ist (issue #1125 AK3)', async ({
  page,
}) => {
  await seedTallTable(page, 12);
  await page.goto('/routinen');

  const tiles = page.locator('.habit-tiles');
  const history = page.locator('.habit-history-card');
  const table = page.locator('.habit-table');
  const [tilesBox, historyBox, tableBox, space4] = await Promise.all([
    tiles.boundingBox(),
    history.boundingBox(),
    table.boundingBox(),
    resolveSpaceToken(page, '--space-4'),
  ]);
  if (!tilesBox || !historyBox || !tableBox) throw new Error('AK3: Karte ohne BoundingBox');

  // Die Tabelle ist tatsächlich höher als Kacheln + Lücke + Verlauf
  // zusammen — sonst testete dieser Fall die Verteilungs-Regel gar nicht.
  expect(tableBox.height).toBeGreaterThan(tilesBox.height + space4 + historyBox.height);

  const gap = historyBox.y - (tilesBox.y + tilesBox.height);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap, `Lücke ${gap}px vs. --space-4 (${space4}px)`).toBeLessThanOrEqual(space4 + 1);
});

/* -------------------------------------------------------------------------- */
/* AK4: Kartenform + Subgrid-Ausrichtung (#960) bleiben erhalten             */
/* -------------------------------------------------------------------------- */

test('die vier Kacheln behalten Kartenform und Subgrid-Ausrichtung — Label, Zahl und Balken auf einer Linie (issue #1125 AK4, #960)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, { name: 'Subgrid-Sonde' });
  await seedHabitLog(page, habitId, TODAY);
  await page.goto('/routinen');

  const tileStyles = await page.locator('.habit-tiles__tile').evaluateAll((els) =>
    els.map((el) => {
      const style = getComputedStyle(el);
      return { borderRadius: style.borderRadius, boxShadow: style.boxShadow, background: style.backgroundColor };
    }),
  );
  expect(tileStyles).toHaveLength(4);
  for (const style of tileStyles) {
    expect(style.borderRadius, 'Rundung bleibt').not.toBe('0px');
    expect(style.boxShadow, 'Schatten bleibt').not.toBe('none');
    expect(style.background, 'eigene Fläche bleibt').not.toBe('rgba(0, 0, 0, 0)');
  }

  const values = page.locator('.habit-tiles__value');
  await expect(values).toHaveCount(4);
  const valueYs = await values.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().y));
  for (const y of valueYs.slice(1)) {
    expect(Math.abs(y - valueYs[0]), 'Zahlen auf einer Linie').toBeLessThanOrEqual(1);
  }

  const labels = page.locator('.habit-tiles__label');
  const labelYs = await labels.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().y));
  for (const y of labelYs.slice(1)) {
    expect(Math.abs(y - labelYs[0]), 'Labels auf einer Linie').toBeLessThanOrEqual(1);
  }

  // Nur HEUTE und WOCHE tragen einen Balken (#960 AK3) — beide auf einer Linie.
  const bars = page.locator('.habit-tiles__bar');
  await expect(bars).toHaveCount(2);
  const barYs = await bars.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().y));
  expect(Math.abs(barYs[1] - barYs[0]), 'Balken auf einer Linie').toBeLessThanOrEqual(1);
});

/* -------------------------------------------------------------------------- */
/* AK5: unter 1440px bleibt die gestapelte Reihenfolge unverändert           */
/* -------------------------------------------------------------------------- */

test('bei 1280 und 375 bleibt die gestapelte Reihenfolge Kacheln → Tabelle → Verlauf erhalten (issue #1125 AK5)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, { name: 'Schmalspur-Sonde' });
  await seedHabitLog(page, habitId, TODAY);
  await page.goto('/routinen');

  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);

    const tiles = page.locator('.habit-tiles');
    const table = page.locator('.habit-table');
    const history = page.locator('.habit-history-card');
    await expect(tiles).toBeVisible();
    await expect(table).toBeVisible();
    await expect(history).toBeVisible();

    const [tilesY, tableY, historyY] = await Promise.all([
      tiles.evaluate((el) => el.getBoundingClientRect().y),
      table.evaluate((el) => el.getBoundingClientRect().y),
      history.evaluate((el) => el.getBoundingClientRect().y),
    ]);
    expect(tilesY, `${viewport.width}px: Kacheln stehen über der Tabelle`).toBeLessThan(tableY);
    expect(tableY, `${viewport.width}px: Tabelle steht über dem Verlauf`).toBeLessThan(historyY);
  }
});
