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
  // statt der Ein-Zahl-Karte (issue #905, T4).
  await page.goto('/routinen');
});

/* -------------------------------------------------------------------------- */
/* Karte erscheint, sobald es mindestens eine aktive Routine gibt             */
/* -------------------------------------------------------------------------- */

test('die Karte "Routinen in Serie" erscheint, sobald es eine aktive Routine gibt', async ({
  page,
}) => {
  await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });

  await expect(historyCard(page).getByText('Routinen in Serie')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* Kopf-Wert = aktueller Tag / Anzahl aktiver Routinen                        */
/* -------------------------------------------------------------------------- */

test('der Kopf-Wert zählt nur Routinen mit laufender Serie, gegen alle aktiven', async ({
  page,
}) => {
  const withStreak = await seedHabit(page, {
    name: 'Wasser trinken',
    schedule: 'daily',
    createdAt: '2026-06-01T00:00:00.000Z',
  });
  const weeklyWithStreak = await seedHabit(page, {
    name: 'Großeinkauf',
    schedule: 'weekly',
    createdAt: '2026-06-01T00:00:00.000Z',
  });
  await seedHabit(page, {
    name: 'Meditieren',
    schedule: 'daily',
    createdAt: '2026-06-01T00:00:00.000Z',
  }); // ohne jeden Log -> keine Serie

  await seedHabitLog(page, withStreak, TODAY);
  await seedHabitLog(page, weeklyWithStreak, '2026-07-14'); // diese Woche

  await expect(historyCard(page).locator('.habit-history-card__value')).toHaveText('2/3');
});

/* -------------------------------------------------------------------------- */
/* Archivierte Routine mit Serie zählt nicht, auch nicht im Nenner            */
/* -------------------------------------------------------------------------- */

test('eine archivierte Routine mit laufender Serie zählt weder mit noch im Nenner', async ({
  page,
}) => {
  const archived = await seedHabit(page, {
    createdAt: '2026-06-01T00:00:00.000Z',
    archivedAt: '2026-07-14T00:00:00.000Z',
  });
  await seedHabitLog(page, archived, TODAY);
  // Eine zweite, aktive Routine ohne Serie hält die Karte sichtbar.
  await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });

  await expect(historyCard(page).locator('.habit-history-card__value')).toHaveText('0/1');
});

/* -------------------------------------------------------------------------- */
/* 0 laufende Serien → Kopf-Wert "0/N", Kurve rendert trotzdem                */
/* -------------------------------------------------------------------------- */

test('ohne laufende Serie zeigt die Karte "0/N" und die Kurve bleibt sichtbar', async ({
  page,
}) => {
  await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });

  const card = historyCard(page);
  await expect(card.locator('.habit-history-card__value')).toHaveText('0/1');
  await expect(card.locator('.habit-history-card__svg')).toBeVisible();
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

  await expect(historyCard(page).locator('.habit-history-card__value')).toHaveText('1/1');
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
