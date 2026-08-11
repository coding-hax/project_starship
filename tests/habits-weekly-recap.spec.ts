import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, skewClock } from './helpers';

// A Wednesday — same reference date as habits-uebersicht.spec.ts. The last
// fully completed Mon–Sun week (AC2) is 2026-07-06..2026-07-12.
const NOW = '2026-07-15T12:00:00.000Z';

function weekDays(mondayKey: string): string[] {
  const [year, month, day] = mondayKey.split('-').map(Number);
  return Array.from({ length: 7 }, (_, offset) => {
    const d = new Date(year, month - 1, day + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
}

const REF_WEEK = weekDays('2026-07-06'); // die Bezugswoche
const PREV_WEEK = weekDays('2026-06-29'); // die Woche davor
const PREV_PREV_WEEK = weekDays('2026-06-22'); // noch eine Woche davor

function recapCard(page: Page) {
  return page.locator('.weekly-recap-card');
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

async function seedDoneDays(page: Page, habitId: string, days: string[]): Promise<void> {
  for (const day of days) await seedHabitLog(page, habitId, day, true);
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await registerPasskey(page);
  await skewClock(page, NOW);
  await page.goto('/uebersicht');
});

/* -------------------------------------------------------------------------- */
/* AC1: Die Karte "Wochenrückblick" erscheint                                 */
/* -------------------------------------------------------------------------- */

test('die Karte "Wochenrückblick" erscheint, sobald es eine Bezugswoche mit aktiven Routinen gibt (AC1)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });
  await seedDoneDays(page, habitId, REF_WEEK);

  await expect(recapCard(page).getByText('Wochenrückblick')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* AC2: Bezugswoche ist die zuletzt abgeschlossene Woche, nie die laufende    */
/* -------------------------------------------------------------------------- */

test('Logs der laufenden Woche fließen nicht in die Kennzahl ein (AC2)', async ({ page }) => {
  const habitId = await seedHabit(page, { schedule: 'daily', createdAt: '2026-06-01T00:00:00.000Z' });
  // Voll erledigt in der laufenden Woche (13.-19.07.), nichts in der Bezugswoche.
  await seedHabitLog(page, habitId, '2026-07-13');
  await seedHabitLog(page, habitId, '2026-07-14');
  await seedHabitLog(page, habitId, '2026-07-15');

  await expect(recapCard(page).getByText('0 von 1')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* AC3: Kennzahl N von M                                                      */
/* -------------------------------------------------------------------------- */

test('N von M zählt weekly (≥ 1 Log) und daily (alle 7 Tage) korrekt gemischt (AC3)', async ({
  page,
}) => {
  const daily = await seedHabit(page, {
    name: 'Wasser trinken',
    schedule: 'daily',
    createdAt: '2026-06-01T00:00:00.000Z',
  });
  const weekly = await seedHabit(page, {
    name: 'Großeinkauf',
    schedule: 'weekly',
    createdAt: '2026-06-01T00:00:00.000Z',
  });
  const unmet = await seedHabit(page, {
    name: 'Meditieren',
    schedule: 'daily',
    createdAt: '2026-06-01T00:00:00.000Z',
  });

  await seedDoneDays(page, daily, REF_WEEK); // erfüllt: alle 7 Tage
  await seedHabitLog(page, weekly, REF_WEEK[2]); // erfüllt: 1 Log genügt
  await seedDoneDays(page, unmet, REF_WEEK.slice(0, 6)); // nicht erfüllt: ein Tag fehlt

  await expect(recapCard(page).getByText('2 von 3')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* AC4/AC1-#504: Superlativ                                                   */
/* -------------------------------------------------------------------------- */

test('schlägt >= 3 frühere Datenwochen → "Deine beste Woche" (#504 AC1)', async ({ page }) => {
  const habitId = await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });
  await seedDoneDays(page, habitId, REF_WEEK); // Bezugswoche: 7/7, sonst keine Logs -> alle Vorwochen 0/7

  await expect(recapCard(page).getByText('Deine beste Woche')).toBeVisible();
});

test('genau 1 oder 2 Vorwochen mit Daten geschlagen → kein Superlativ, Kennzahl bleibt (#504 AC2)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, { createdAt: '2026-06-22T00:00:00.000Z' });
  await seedDoneDays(page, habitId, REF_WEEK); // Bezugswoche: 7/7
  await seedHabitLog(page, habitId, PREV_WEEK[0]); // Woche davor: 1/7
  await seedHabitLog(page, habitId, PREV_PREV_WEEK[0]); // noch eine Woche davor: 1/7 -> nur 2 Datenwochen

  const card = recapCard(page);
  await expect(card.getByText('1 von 1')).toBeVisible();
  await expect(card).not.toContainText('Beste');
  await expect(card).not.toContainText('So viel wie letzte Woche');
});

test('bessere Woche 2 Kalenderwochen zurück → "Beste Woche seit 2 Wochen" (#504 AC3)', async ({
  page,
}) => {
  const a = await seedHabit(page, { name: 'a', createdAt: '2026-05-01T00:00:00.000Z' });
  const b = await seedHabit(page, { name: 'b', createdAt: '2026-05-01T00:00:00.000Z' });
  const c = await seedHabit(page, { name: 'c', createdAt: '2026-05-01T00:00:00.000Z' });

  await seedDoneDays(page, a, REF_WEEK); // Bezugswoche: a,b voll -> 2/3
  await seedDoneDays(page, b, REF_WEEK);
  await seedDoneDays(page, a, PREV_WEEK); // Vorwoche: nur a voll -> 1/3, schlechter
  await seedDoneDays(page, a, PREV_PREV_WEEK); // 2 Kalenderwochen zurück: alle voll -> 3/3, besser
  await seedDoneDays(page, b, PREV_PREV_WEEK);
  await seedDoneDays(page, c, PREV_PREV_WEEK);

  await expect(recapCard(page).getByText('Beste Woche seit 2 Wochen')).toBeVisible();
});

test('bessere Woche genau 1 Kalenderwoche zurück → kein Superlativ, kein "seit 1 Wochen" (#504 AC4)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });
  await seedDoneDays(page, habitId, PREV_WEEK); // Vorwoche: 7/7 (besser als die Bezugswoche)

  const card = recapCard(page);
  await expect(card.getByText('0 von 1')).toBeVisible();
  await expect(card).not.toContainText('Beste');
  await expect(card).not.toContainText('So viel wie letzte Woche');
});

test('Gleichstand mit der Vorwoche → "So viel wie letzte Woche" (AC4)', async ({ page }) => {
  const habitId = await seedHabit(page, { schedule: 'weekly', createdAt: '2026-06-01T00:00:00.000Z' });
  await seedHabitLog(page, habitId, REF_WEEK[2]); // Bezugswoche: 1/1
  await seedHabitLog(page, habitId, PREV_WEEK[2]); // Vorwoche: 1/1 (Gleichstand)

  await expect(recapCard(page).getByText('So viel wie letzte Woche')).toBeVisible();
});

test('weder Bestwert noch Gleichstand → kein Superlativ, nur die Kennzahl (AC4)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });
  await seedDoneDays(page, habitId, REF_WEEK.slice(0, 3)); // Bezugswoche: unvollständig -> 0/1
  await seedDoneDays(page, habitId, PREV_WEEK); // Vorwoche: vollständig -> 1/1

  const card = recapCard(page);
  await expect(card.getByText('0 von 1')).toBeVisible();
  await expect(card).not.toContainText('Beste');
  await expect(card).not.toContainText('So viel wie letzte Woche');
});

/* -------------------------------------------------------------------------- */
/* AC5: Zu wenig Historie                                                     */
/* -------------------------------------------------------------------------- */

test('erste erfasste Woche zeigt nur die Kennzahl, keinen Superlativ (AC5)', async ({ page }) => {
  // Die Routine existiert erst seit der Bezugswoche selbst — keine Vorwoche möglich.
  const habitId = await seedHabit(page, { createdAt: REF_WEEK[0] + 'T00:00:00.000Z' });
  await seedDoneDays(page, habitId, REF_WEEK);

  const card = recapCard(page);
  await expect(card.getByText('1 von 1')).toBeVisible();
  await expect(card).not.toContainText('Beste');
  await expect(card).not.toContainText('So viel wie letzte Woche');
});

/* -------------------------------------------------------------------------- */
/* AC6: Keine aktiven Routinen → Karte erscheint nicht                    */
/* -------------------------------------------------------------------------- */

test('ohne jede Routine erscheint die Karte nicht (AC6, kein "0 von 0")', async ({ page }) => {
  await expect(recapCard(page)).toHaveCount(0);
});

test('eine erst diese Woche angelegte Routine lässt die Karte ebenfalls weg (AC6)', async ({
  page,
}) => {
  await seedHabit(page, { createdAt: '2026-07-14T00:00:00.000Z' });

  await expect(recapCard(page)).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* AC7: Nie ein Vergleich mit anderen Menschen                                */
/* -------------------------------------------------------------------------- */

test('die Karte erwähnt nie andere Personen, auch im Bestwert-Fall (AC7)', async ({ page }) => {
  const habitId = await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });
  await seedDoneDays(page, habitId, REF_WEEK); // sonst keine Logs -> alle Vorwochen 0/7, >= 3 Datenwochen

  const text = await recapCard(page).innerText();
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  expect(lines).toEqual(['Wochenrückblick', '1 von 1', 'Deine beste Woche']);
});

/* -------------------------------------------------------------------------- */
/* AC8: rein aus db.records, offline, ohne Migration                         */
/* -------------------------------------------------------------------------- */

test('die Karte berechnet sich vollständig offline aus IndexedDB (AC8)', async ({
  page,
  context,
}) => {
  await context.setOffline(true);

  const habitId = await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });
  await seedDoneDays(page, habitId, REF_WEEK);

  await expect(recapCard(page).getByText('1 von 1')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* AC9: tabular-nums, Dark Mode, prefers-reduced-motion, 375px/1280px         */
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

test('die Kennzahl nutzt tabular-nums (AC9)', async ({ page }) => {
  const habitId = await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });
  await seedDoneDays(page, habitId, REF_WEEK);

  const metric = recapCard(page).locator('.weekly-recap-card__metric');
  await expect(metric).toHaveCSS('font-variant-numeric', 'tabular-nums');
});

test('der Superlativ-Text nutzt den gedämpften Text-Token, auch im Dark Mode (AC9)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });
  await seedDoneDays(page, habitId, REF_WEEK); // sonst keine Logs -> alle Vorwochen 0/7, >= 3 Datenwochen

  const superlative = recapCard(page).locator('.weekly-recap-card__superlative');
  const lightColor = await superlative.evaluate((el) => getComputedStyle(el).color);
  expect(lightColor).toBe(await resolveColorToken(page, '--text-muted'));

  await page.emulateMedia({ colorScheme: 'dark' });
  const darkColor = await superlative.evaluate((el) => getComputedStyle(el).color);
  expect(darkColor).toBe(await resolveColorToken(page, '--text-muted'));
  expect(darkColor).not.toBe(lightColor);
});

for (const viewport of [
  { width: 375, height: 667 },
  { width: 1280, height: 800 },
]) {
  test(`die Karte ist bei ${viewport.width}px sichtbar (AC9)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const habitId = await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });
    await seedDoneDays(page, habitId, REF_WEEK);

    await expect(recapCard(page)).toBeVisible();
  });
}
