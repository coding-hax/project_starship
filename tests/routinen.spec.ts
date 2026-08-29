import { expect, test, type Locator, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, skewClock } from './helpers';

/**
 * Closes the six criteria the AK-Check (29.08.) found un-tested after the
 * table rebuild — AK1 (Aufbau), AK2 (Kacheln), AK5 (Verlaufskarte-Endpunkt),
 * AK6 (Kontrast), AK7 (375×812 mit einer Routine) und AK10 (Dark Mode +
 * reduced-motion). AK3/AK4/AK8/AK9 sind bereits über habits.spec.ts,
 * habits-week-grid.spec.ts und die vier Ableitungs-Tests abgedeckt.
 */

// A Wednesday — same reference date as habits-week-grid.spec.ts /
// habits-streak-summary.spec.ts. The running week is 2026-07-13..2026-07-19
// (Mon–Sun).
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

async function seedHabitLog(
  page: Page,
  habitId: string,
  logDate: string,
  done = true,
): Promise<void> {
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

/** Mirrors grundfarbe-vollfarbe.spec.ts's own probe-span technique. */
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

function relativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/** WCAG contrast ratio (1–21) between two 0–255 sRGB byte tuples. */
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

async function elementBackground(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).backgroundColor);
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // The page must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await registerPasskey(page);
  await skewClock(page, NOW);
});

/* -------------------------------------------------------------------------- */
/* AK1: Aufbau — Kopf, drei Kacheln, Tabelle, Verlaufskarte, in Reihenfolge    */
/* -------------------------------------------------------------------------- */

test('AK1: /routinen zeigt Kopf, Kacheln, Tabelle und Verlaufskarte in dieser Reihenfolge, ohne StreakSummaryCard/HabitList (issue #905)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, { name: 'Aufbau-Sonde' });
  await seedHabitLog(page, habitId, TODAY);
  await page.goto('/routinen');

  const heading = page.getByRole('heading', { level: 1, name: 'Routinen' });
  const tiles = page.locator('.habit-tiles');
  const table = page.locator('.habit-table');
  const history = page.locator('.habit-history-card');
  await expect(heading).toBeVisible();
  await expect(tiles).toBeVisible();
  await expect(table).toBeVisible();
  await expect(history).toBeVisible();

  const [headingY, tilesY, tableY, historyY] = await Promise.all([
    heading.evaluate((el) => el.getBoundingClientRect().y),
    tiles.evaluate((el) => el.getBoundingClientRect().y),
    table.evaluate((el) => el.getBoundingClientRect().y),
    history.evaluate((el) => el.getBoundingClientRect().y),
  ]);
  expect(headingY, 'Kopf steht über den Kacheln').toBeLessThan(tilesY);
  expect(tilesY, 'Kacheln stehen über der Tabelle').toBeLessThan(tableY);
  expect(tableY, 'Tabelle steht über der Verlaufskarte').toBeLessThan(historyY);

  // The standalone management list and the old single-number card are gone —
  // their content lives inside the table/tiles/history card now (issue #905).
  expect(await page.locator('.habit-list').count(), 'HabitList ist verschwunden').toBe(0);
  expect(
    await page.locator('.streak-summary-card').count(),
    'StreakSummaryCard ist verschwunden',
  ).toBe(0);
});

/* -------------------------------------------------------------------------- */
/* AK2: Kacheln — Zähler und Nenner als Text, Balken rein dekorativ           */
/* -------------------------------------------------------------------------- */

test('AK2: die drei Kacheln zeigen Zähler und Nenner als Text, der Balken ist aria-hidden (issue #905)', async ({
  page,
}) => {
  const habitA = await seedHabit(page, { name: 'Kachel A' });
  await seedHabit(page, { name: 'Kachel B' });
  await seedHabitLog(page, habitA, TODAY);
  await page.goto('/routinen');

  const tiles = page.locator('.habit-tiles__tile');
  await expect(tiles).toHaveCount(3);

  const heute = tiles.nth(0);
  await expect(heute.locator('.habit-tiles__label')).toHaveText('HEUTE');
  await expect(heute.locator('.habit-tiles__value')).toHaveText('1');
  await expect(heute.locator('.habit-tiles__denominator')).toHaveText('von 2');
  await expect(heute.locator('.habit-tiles__bar')).toHaveAttribute('aria-hidden', 'true');

  const woche = tiles.nth(1);
  await expect(woche.locator('.habit-tiles__label')).toHaveText('DIESE WOCHE');
  await expect(woche.locator('.habit-tiles__value')).toHaveText('1');
  // 2 tägliche Routinen à 7 Tage Wochensoll (week-goal.ts) = 14.
  await expect(woche.locator('.habit-tiles__denominator')).toHaveText('von 14');
  await expect(woche.locator('.habit-tiles__bar')).toHaveAttribute('aria-hidden', 'true');

  const serie = tiles.nth(2);
  await expect(serie.locator('.habit-tiles__label')).toHaveText('LÄNGSTE SERIE');
  await expect(serie.locator('.habit-tiles__value')).toHaveText('1');
  await expect(serie.locator('.habit-tiles__denominator')).toHaveText('Tage');
  // Keine Farbe allein trägt Bedeutung — die Serien-Kachel hat gar keinen
  // Balken, statt einen immer vollen zu zeigen (issue #905).
  await expect(serie.locator('.habit-tiles__bar')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* AK5: Verlaufskarte — Endpunkt der 30-Tage-Kurve ist markiert               */
/* -------------------------------------------------------------------------- */

test('AK5: der Endpunkt der 30-Tage-Kurve ist als eigener Punkt ganz rechts markiert (issue #905)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, { name: 'Verlaufssonde' });
  await seedHabitLog(page, habitId, TODAY);
  await page.goto('/routinen');

  const dot = page.locator('.habit-history-card__dot');
  await expect(dot).toBeVisible();
  await expect(dot).toHaveAttribute('cx', '100'); // rightmost of the 0..100 viewBox
  const cy = Number(await dot.getAttribute('cy'));
  expect(cy).toBeGreaterThanOrEqual(0);
  expect(cy).toBeLessThanOrEqual(32);
});

/* -------------------------------------------------------------------------- */
/* AK6/AK10: Kontrast der drei neuen Farbmischungen, hell und dunkel          */
/* -------------------------------------------------------------------------- */

test('AK6/AK10: Wochenbalken, Kachel-Balken und Verlaufslinie/-punkt erreichen 3:1 gegen die eigene Fläche, Text 4,5:1 — hell und dunkel (issue #905)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, { name: 'Kontrastsonde' });
  await seedHabitLog(page, habitId, TODAY);
  await page.goto('/routinen');

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });

    const surface = await toRgb(page, await resolveColorToken(page, '--surface'));

    const weekBar = page.locator('.habit-table__week-bar[data-current]').first();
    const weekBarColor = await toRgb(page, await elementBackground(weekBar));
    expect(
      contrastRatio(weekBarColor, surface),
      `Wochenbalken, laufende Woche (${scheme}) gegen die Tabellenfläche`,
    ).toBeGreaterThanOrEqual(3);

    // Die 11 zurückliegenden Wochen sind gedämpft — als Farbmischung, nicht
    // als Deckkraft (Deckkraft mischt gegen --surface und reißt den Kontrast
    // unter 3:1, AK-Check 29.08.). Eigene Messung, weil `backgroundColor`
    // eine `opacity`-Dämpfung nicht mit einschlösse.
    const pastWeekBar = page.locator('.habit-table__week-bar:not([data-current])').first();
    const pastWeekBarColor = await toRgb(page, await elementBackground(pastWeekBar));
    expect(
      contrastRatio(pastWeekBarColor, surface),
      `Wochenbalken, vergangene Woche (${scheme}) gegen die Tabellenfläche`,
    ).toBeGreaterThanOrEqual(3);

    const barFill = page.locator('.habit-tiles__bar-fill').first();
    const barFillColor = await toRgb(page, await elementBackground(barFill));
    expect(
      contrastRatio(barFillColor, surface),
      `Kachel-Balken (${scheme}) gegen die Kachelfläche`,
    ).toBeGreaterThanOrEqual(3);

    const lineColor = await toRgb(
      page,
      await page.locator('.habit-history-card__line').evaluate((el) => getComputedStyle(el).stroke),
    );
    expect(
      contrastRatio(lineColor, surface),
      `Verlaufslinie (${scheme}) gegen die Kartenfläche`,
    ).toBeGreaterThanOrEqual(3);

    const dotColor = await toRgb(
      page,
      await page.locator('.habit-history-card__dot').evaluate((el) => getComputedStyle(el).fill),
    );
    expect(
      contrastRatio(dotColor, surface),
      `Endpunkt (${scheme}) gegen die Kartenfläche`,
    ).toBeGreaterThanOrEqual(3);

    // Jede Beschriftung (Kachel-Label/-Nenner, Zeilenname, Serie, Achse) hängt
    // an genau diesen zwei Karten-Tinte-Tokens — beide gegen --surface messen
    // deckt sie alle ab, statt jedes Element einzeln zu sondieren.
    const textBase = await toRgb(page, await resolveColorToken(page, '--text-base'));
    const textMutedBase = await toRgb(page, await resolveColorToken(page, '--text-muted-base'));
    expect(
      contrastRatio(textBase, surface),
      `--text-base (${scheme}) gegen --surface`,
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(textMutedBase, surface),
      `--text-muted-base (${scheme}) gegen --surface`,
    ).toBeGreaterThanOrEqual(4.5);
  }
});

/* -------------------------------------------------------------------------- */
/* AK7: 375×812, eine Routine, eingeklappt — kein senkrechter Überlauf        */
/* -------------------------------------------------------------------------- */

test('AK7: bei 375×812 passt die Seite mit einer eingeklappten Routine ohne senkrechten oder waagerechten Überlauf (issue #905)', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Eine einzige Routine' });
  await page.goto('/routinen');
  await expect(page.getByRole('button', { name: 'Routine anlegen' })).toBeVisible();

  // Zeile startet eingeklappt (AK3) — misst den spärlichen Default, nicht eine
  // bereits ausgeklappte Zeile, die zusätzliche Höhe frisst.
  await expect(page.locator('.habit-table__row-header')).toHaveAttribute('aria-expanded', 'false');

  const overflow = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollHeight,
    'kein vertikaler Überlauf im spärlichen Default-Zustand',
  ).toBeLessThanOrEqual(overflow.clientHeight);
  expect(overflow.scrollWidth, 'kein horizontaler Überlauf').toBeLessThanOrEqual(overflow.clientWidth);
});

/* -------------------------------------------------------------------------- */
/* AK10: prefers-reduced-motion — Auf-/Zuklappen ist die einzige Bewegung     */
/* -------------------------------------------------------------------------- */

test('AK10: bei reduzierter Bewegung ist der Auf-/Zuklapp-Übergang einer Tabellenzeile augenblicklich (issue #905)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await seedHabit(page, { name: 'Ruhige Zeile' });
  await page.goto('/routinen');

  const collapse = page.locator('.habit-table__collapse');
  const transitionDuration = await collapse.evaluate((el) => getComputedStyle(el).transitionDuration);
  // Chromium serializes very small numbers in exponential notation (e.g. "1e-05s"),
  // so compare the parsed value rather than the exact string (mirrors habits.spec.ts).
  expect(parseFloat(transitionDuration)).toBeLessThan(0.001);
});
