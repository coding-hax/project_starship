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

/* -------------------------------------------------------------------------- */
/* AK1–AK5 (issue #960): Kachel-Zeilen (Label/Zahl/Balken) über ein Subgrid   */
/* geteilt, statt unabhängig im Fluss zu stehen                              */
/* -------------------------------------------------------------------------- */

test('AK1 (#960): die drei Kachelzahlen stehen auf einer Höhe, obwohl HEUTE einzeilig und die beiden anderen Label zweizeilig umbrechen', async ({
  page,
}) => {
  const habitA = await seedHabit(page, { name: 'Kachel A' });
  await seedHabit(page, { name: 'Kachel B' });
  await seedHabitLog(page, habitA, TODAY);
  await page.goto('/routinen');

  const tiles = page.locator('.habit-tiles__tile');
  await expect(tiles).toHaveCount(3);

  // Zeilenzahl über die Textzeilen selbst messen (Range.getClientRects), nicht
  // über die Box-Höhe des Labels: `align-self: stretch` (Grid-Item-Default)
  // dehnt jedes Label auf die geteilte Zeilenhöhe — das ist genau der Fix, aber
  // es macht die drei Label-Boxen gleich hoch und damit als Umbruch-Nachweis
  // untauglich.
  const lineCount = (label: Locator) =>
    label.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getClientRects().length;
    });
  const heuteLines = await lineCount(tiles.nth(0).locator('.habit-tiles__label'));
  const wocheLines = await lineCount(tiles.nth(1).locator('.habit-tiles__label'));
  const serieLines = await lineCount(tiles.nth(2).locator('.habit-tiles__label'));
  // Der 375px-Normalfall aus dem Screenshot: "HEUTE" bricht einzeilig, die
  // beiden längeren Label zweizeilig — sonst wäre AK1 gar nicht geprüft.
  expect(heuteLines, 'HEUTE bricht einzeilig').toBe(1);
  expect(wocheLines, 'DIESE WOCHE bricht zweizeilig').toBe(2);
  expect(serieLines, 'LÄNGSTE SERIE bricht zweizeilig').toBe(2);

  const values = page.locator('.habit-tiles__value');
  await expect(values).toHaveCount(3);
  const [heuteY, wocheY, serieY] = await values.evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect().y),
  );
  expect(Math.abs(wocheY - heuteY), 'HEUTE vs. DIESE WOCHE').toBeLessThanOrEqual(1);
  expect(Math.abs(serieY - heuteY), 'HEUTE vs. LÄNGSTE SERIE').toBeLessThanOrEqual(1);
});

/* -------------------------------------------------------------------------- */

test('AK2 (#960): die Balken von HEUTE und DIESE WOCHE stehen auf einer Höhe', async ({ page }) => {
  const habitA = await seedHabit(page, { name: 'Balken-Sonde' });
  await seedHabitLog(page, habitA, TODAY);
  await page.goto('/routinen');

  const bars = page.locator('.habit-tiles__bar');
  await expect(bars).toHaveCount(2);
  const [heuteBarY, wocheBarY] = await bars.evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect().y),
  );
  expect(Math.abs(wocheBarY - heuteBarY), 'Balken HEUTE vs. DIESE WOCHE').toBeLessThanOrEqual(1);
});

/* -------------------------------------------------------------------------- */

test('AK3 (#960): die Serien-Kachel bleibt balkenlos — kein Platzhalter für die fehlende Balkenzeile', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Serien-Sonde' });
  await page.goto('/routinen');

  const serie = page.locator('.habit-tiles__tile').nth(2);
  await expect(serie.locator('.habit-tiles__bar')).toHaveCount(0);
  // Das freie Subgrid-Zeilendrittel bleibt unbelegt — kein zusätzliches
  // Element trägt die Reserve, das dl bleibt einziges Kind der Kachel.
  await expect(serie.locator('> *')).toHaveCount(1);
});

/* -------------------------------------------------------------------------- */

test('AK4 (#960): dl/dt/dd bleiben erhalten, .habit-tiles__stat trägt kein display:contents', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Semantik-Sonde' });
  await page.goto('/routinen');

  const stat = page.locator('.habit-tiles__stat').first();
  expect(await stat.evaluate((el) => el.tagName)).toBe('DL');
  expect(await stat.evaluate((el) => getComputedStyle(el).display)).not.toBe('contents');

  const label = page.locator('.habit-tiles__label').first();
  const valueRow = page.locator('.habit-tiles__value-row').first();
  expect(await label.evaluate((el) => el.tagName)).toBe('DT');
  expect(await valueRow.evaluate((el) => el.tagName)).toBe('DD');
});

/* -------------------------------------------------------------------------- */

test('AK5 (#960): bei 375×812 kein waagerechter Überlauf durch das Kachel-Subgrid, hell und dunkel', async ({
  page,
}) => {
  const habitA = await seedHabit(page, { name: 'Überlauf-Sonde A' });
  await seedHabit(page, { name: 'Überlauf-Sonde B' });
  await seedHabitLog(page, habitA, TODAY);
  await page.goto('/routinen');

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth, `kein waagerechter Überlauf (${scheme})`).toBeLessThanOrEqual(
      overflow.clientWidth,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* AK1–AK4/AK7 (issue #963): Zeitplan als zweite Kopfzeile, Startdatum weg,   */
/* eingeklappte Zeile schneidet nichts mehr ab                                */
/* -------------------------------------------------------------------------- */

function rowHeaderByName(page: Page, name: string): Locator {
  return page
    .locator('.habit-table__row', { hasText: name })
    .getByRole('button', { name: new RegExp(`^${name}\\b`) });
}

test('AK1 (#963): der Zeitplan steht als zweite Kopfzeile im Zeilenkopf, nicht im aufklappbaren Rumpf', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Kopfzeilen-Sonde', schedule: 'weekly', target: 3 });
  await page.goto('/routinen');

  const header = rowHeaderByName(page, 'Kopfzeilen-Sonde');
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await expect(header.locator('.habit-table__schedule')).toHaveText('3× pro Woche');

  // Sitzt im Zeilenkopf, nicht mehr im aufklappbaren Rumpf.
  await expect(page.locator('.habit-table__body .habit-table__schedule')).toHaveCount(0);
});

test('AK2 (#963): der Zeitplan sitzt höchstens 4px unter der Unterkante des Namens', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Abstand-Sonde' });
  await page.goto('/routinen');

  const name = page.locator('.habit-table__name', { hasText: 'Abstand-Sonde' });
  const schedule = page
    .locator('.habit-table__row', { hasText: 'Abstand-Sonde' })
    .locator('.habit-table__schedule');
  const [nameBox, scheduleBox] = await Promise.all([
    name.evaluate((el) => el.getBoundingClientRect()),
    schedule.evaluate((el) => el.getBoundingClientRect()),
  ]);
  const gap = scheduleBox.top - nameBox.bottom;
  expect(gap, 'Abstand Name → Zeitplan').toBeGreaterThanOrEqual(0);
  expect(gap, 'Abstand Name → Zeitplan höchstens 4px (var(--space-1))').toBeLessThanOrEqual(4);
});

test('AK3 (#963): das Startdatum ("seit …") steht nirgends mehr, eingeklappt wie aufgeklappt', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Datum-Sonde' });
  await page.goto('/routinen');

  const row = page.locator('.habit-table__row', { hasText: 'Datum-Sonde' });
  await expect(row).not.toContainText('seit');
  expect(await page.locator('.habit-table__meta').count(), '.habit-table__meta entfällt').toBe(0);

  await rowHeaderByName(page, 'Datum-Sonde').click();
  await expect(row).not.toContainText('seit');
});

test('AK4 (#963): eingeklappt hat .habit-table__body eine gemessene Höhe von exakt 0', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Höhe-Sonde' });
  await page.goto('/routinen');

  const header = rowHeaderByName(page, 'Höhe-Sonde');
  await expect(header).toHaveAttribute('aria-expanded', 'false');

  const body = page
    .locator('.habit-table__row', { hasText: 'Höhe-Sonde' })
    .locator('.habit-table__body');
  const height = await body.evaluate((el) => el.getBoundingClientRect().height);
  expect(height).toBe(0);
});

test('AK7 (#963): 375×812 — kein waagerechter Überlauf und keine abgeschnittenen Unterlängen, ein-/aufgeklappt, hell und dunkel', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Randfall-Sonde', schedule: 'weekly', target: 3 });
  await page.goto('/routinen');

  const row = page.locator('.habit-table__row', { hasText: 'Randfall-Sonde' });
  const header = rowHeaderByName(page, 'Randfall-Sonde');
  const headerBox = await header.evaluate((el) => el.getBoundingClientRect());
  expect(headerBox.height, 'Berührungsziel bleibt ≥ var(--touch-target)').toBeGreaterThanOrEqual(44);

  for (const expanded of [false, true]) {
    if (expanded) await header.click();
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const label = `${expanded ? 'aufgeklappt' : 'eingeklappt'}, ${scheme}`;

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(overflow.scrollWidth, `kein waagerechter Überlauf (${label})`).toBeLessThanOrEqual(
        overflow.clientWidth,
      );

      const schedule = row.locator('.habit-table__schedule');
      const clipped = await schedule.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
      expect(clipped, `Zeitplan-Zeile nicht abgeschnitten (${label})`).toBe(false);
    }
  }
});

/* -------------------------------------------------------------------------- */
/* AK1–AK4 (issue #977): Kopfzeile "Routine · 12 Wochen · Serie" entfällt,    */
/* Haarstrich sitzt nur noch zwischen Zeilen, nicht an der Kartenoberkante    */
/* -------------------------------------------------------------------------- */

test('AK1 (#977): die Kopfzeile "Routine · 12 Wochen · Serie" ist verschwunden', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Kopfzeile-weg-Sonde' });
  await page.goto('/routinen');

  await expect(page.locator('.habit-table')).toBeVisible();
  await expect(page.locator('.habit-table__head')).toHaveCount(0);
  await expect(page.getByText('Routine · 12 Wochen · Serie')).toHaveCount(0);
});

test('AK2/AK3 (#977): kein Haarstrich an der Kartenoberkante, aber weiterhin zwischen den Zeilen', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Haarstrich-Sonde A' });
  await seedHabit(page, { name: 'Haarstrich-Sonde B' });
  await page.goto('/routinen');

  const rows = page.locator('.habit-table__row');
  await expect(rows).toHaveCount(2);

  const firstBorder = await rows.nth(0).evaluate((el) => getComputedStyle(el).borderTopWidth);
  expect(firstBorder, 'erste Zeile: kein Haarstrich an der Kartenoberkante').toBe('0px');

  const secondBorder = await rows.nth(1).evaluate((el) => getComputedStyle(el).borderTopWidth);
  expect(secondBorder, 'zweite Zeile: Trennstrich zur ersten Zeile bleibt').toBe('1px');
});

test('AK4 (#977): die erste Zeile bleibt voll bedienbar — Berührungsziel und innerhalb der Kartenfläche', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Bedienbar-Sonde' });
  await page.goto('/routinen');

  const table = page.locator('.habit-table');
  const firstHeader = page.locator('.habit-table__row-header').first();

  const [tableBox, headerBox] = await Promise.all([
    table.evaluate((el) => el.getBoundingClientRect()),
    firstHeader.evaluate((el) => el.getBoundingClientRect()),
  ]);

  expect(headerBox.height, 'Berührungsziel bleibt ≥ var(--touch-target)').toBeGreaterThanOrEqual(44);
  expect(headerBox.top, 'oberer Rand liegt nicht über der Kartenfläche').toBeGreaterThanOrEqual(
    tableBox.top,
  );
});
