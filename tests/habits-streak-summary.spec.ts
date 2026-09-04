import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, skewClock } from './helpers';

// A Wednesday — same reference date as streak.test.ts. The running week is
// 2026-07-13..2026-07-19 (Mon–Sun), the running month is July 2026.
const NOW = '2026-07-15T12:00:00.000Z';
const TODAY = '2026-07-15';

function historyCard(page: Page) {
  return page.locator('.habit-history-card');
}

async function seedHabit(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) =>
      window.__starship.mutate({
        table: 'habits',
        op: 'upsert',
        payload: { name: 'x', schedule: 'daily', color: null, archivedAt: null, ...p },
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

test.beforeEach(async ({ page }) => {
  await resetAppData();
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await registerPasskey(page);
  await skewClock(page, NOW);
  // Umgezogen von /uebersicht auf /routinen (issue #652), jetzt die Verlaufskarte
  // statt der Ein-Zahl-Karte (issue #905, T4), seit #1070 ein Quadratraster
  // statt der Stufenkurve.
  await page.goto('/routinen');
});

/* -------------------------------------------------------------------------- */
/* Karte erscheint, sobald es mindestens eine aktive Routine gibt             */
/* -------------------------------------------------------------------------- */

test('die Karte "Erledigt · 30 Tage" erscheint, sobald es eine aktive Routine gibt', async ({
  page,
}) => {
  await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });

  await expect(historyCard(page).getByText('Erledigt · 30 Tage')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* Kopf-Wert = Summe aller gefüllten Quadrate im Fenster (issue #1070 AC6)    */
/* -------------------------------------------------------------------------- */

test('der Kopf-Wert ist die Summe aller Erledigungen im 30-Tage-Fenster, nicht die Zahl der Routinen mit laufender Serie', async ({
  page,
}) => {
  // Deckt wörtlich das Beispiel aus der Akzeptanzkriterien-Beschreibung ab:
  // 4 aktive Routinen mit zusammen 11 Logs in den letzten 30 Tagen ⇒ 11.
  const a = await seedHabit(page, { name: 'Wasser trinken', createdAt: '2026-06-01T00:00:00.000Z' });
  const b = await seedHabit(page, { name: 'Meditieren', createdAt: '2026-06-01T00:00:00.000Z' });
  const c = await seedHabit(page, { name: 'Dehnen', createdAt: '2026-06-01T00:00:00.000Z' });
  const d = await seedHabit(page, { name: 'Lesen', createdAt: '2026-06-01T00:00:00.000Z' });

  for (const day of ['2026-07-15', '2026-07-14', '2026-07-13', '2026-07-12', '2026-07-11']) {
    await seedHabitLog(page, a, day);
  }
  for (const day of ['2026-07-10', '2026-07-09', '2026-07-08']) {
    await seedHabitLog(page, b, day);
  }
  for (const day of ['2026-07-07', '2026-07-06']) {
    await seedHabitLog(page, c, day);
  }
  await seedHabitLog(page, d, '2026-07-05');

  await expect(historyCard(page).locator('.habit-history-card__value')).toHaveText('11');
});

/* -------------------------------------------------------------------------- */
/* Archivierte Routine liefert weder Zeile noch Quadrat noch Kopf-Beitrag     */
/* -------------------------------------------------------------------------- */

test('eine archivierte Routine liefert weder Zeile noch Quadrat noch einen Beitrag zum Kopf-Wert', async ({
  page,
}) => {
  const archived = await seedHabit(page, {
    createdAt: '2026-06-01T00:00:00.000Z',
    archivedAt: '2026-07-14T00:00:00.000Z',
  });
  await seedHabitLog(page, archived, TODAY);
  // Eine zweite, aktive Routine ohne Erledigung hält die Karte sichtbar.
  await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });

  await expect(historyCard(page).locator('.habit-history-card__value')).toHaveText('0');
});

/* -------------------------------------------------------------------------- */
/* 0 Erledigungen → Kopf-Wert "0", das Raster rendert trotzdem                */
/* -------------------------------------------------------------------------- */

test('ohne jede Erledigung zeigt die Karte "0" und das Raster bleibt sichtbar', async ({ page }) => {
  await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });

  const card = historyCard(page);
  await expect(card.locator('.habit-history-card__value')).toHaveText('0');
  await expect(card.locator('.habit-history-card__grid')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* Keine Routine → Karte weg                                                  */
/* -------------------------------------------------------------------------- */

test('ohne jede Routine erscheint die Karte nicht', async ({ page }) => {
  await expect(historyCard(page)).toHaveCount(0);
});

test('nur archivierte Routinen lassen die Karte ebenfalls weg', async ({ page }) => {
  await seedHabit(page, {
    createdAt: '2026-06-01T00:00:00.000Z',
    archivedAt: '2026-07-01T00:00:00.000Z',
  });

  await expect(historyCard(page)).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* Rein aus IndexedDB, offline                                                */
/* -------------------------------------------------------------------------- */

test('die Karte berechnet sich vollständig offline aus IndexedDB', async ({ page, context }) => {
  await context.setOffline(true);

  const habitId = await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });
  await seedHabitLog(page, habitId, TODAY);

  await expect(historyCard(page).locator('.habit-history-card__value')).toHaveText('1');
});

/* -------------------------------------------------------------------------- */
/* tabular-nums, Dark Mode, 375px/1280px                                      */
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

test('der Kopf-Wert nutzt tabular-nums', async ({ page }) => {
  const habitId = await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });
  await seedHabitLog(page, habitId, TODAY);

  const value = historyCard(page).locator('.habit-history-card__value');
  await expect(value).toHaveCSS('font-variant-numeric', 'tabular-nums');
});

test('die Achsenbeschriftung nutzt den gedämpften Text-Token, auch im Dark Mode', async ({
  page,
}) => {
  await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });

  // `--text-muted` itself is a context variable since issue #832 (the page ground
  // overrides it, cards reset it back). `.habit-history-card` is a card, so its
  // `--text-muted` resolves to the fixed `--text-muted-base` — that's the value
  // this element actually renders, not whatever `--text-muted` means at document
  // level (which here is the route's ground ink).
  const axisLabel = historyCard(page).locator('.habit-history-card__axis span').first();
  const lightColor = await axisLabel.evaluate((el) => getComputedStyle(el).color);
  expect(lightColor).toBe(await resolveColorToken(page, '--text-muted-base'));

  await page.emulateMedia({ colorScheme: 'dark' });
  const darkColor = await axisLabel.evaluate((el) => getComputedStyle(el).color);
  expect(darkColor).toBe(await resolveColorToken(page, '--text-muted-base'));
  expect(darkColor).not.toBe(lightColor);
});

for (const viewport of [
  { width: 375, height: 667 },
  { width: 1280, height: 800 },
]) {
  test(`die Karte ist bei ${viewport.width}px sichtbar`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const habitId = await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });
    await seedHabitLog(page, habitId, TODAY);

    await expect(historyCard(page)).toBeVisible();
  });
}
