import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, skewClock } from './helpers';

// A Wednesday — same reference date as streak.test.ts. The running week is
// 2026-07-13..2026-07-19 (Mon–Sun), the running month is July 2026.
const NOW = '2026-07-15T12:00:00.000Z';

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
