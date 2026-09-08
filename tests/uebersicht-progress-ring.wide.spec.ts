import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, skewClock } from './helpers';

/**
 * Größerer Geschwister-Ring ab 1440px (issue #1122, Nachfolger von #1117):
 * dieselbe `computeDailyProgress`-Zahl, nur als Segmentring mit
 * Klartext-Aufschlüsselung statt der kompakten „N/M"-Zahl. Läuft im
 * `desktop-wide`-Messplatz (1800 × 1000, playwright.config.ts), wie
 * seitenkopf.wide.spec.ts. Unterhalb von 1440px bleibt der bestehende
 * 34px-Ring unverändert — dafür bürgt uebersicht-progress-ring.spec.ts, AK6
 * unten prüft zusätzlich gezielt, dass die neue Regel dort gar nicht erst
 * greift.
 */

const NOW = '2026-07-15T12:00:00.000Z';
const TODAY_EVENING = '2026-07-15T18:00:00.000Z';

function wideRing(page: Page) {
  return page.locator('.daily-progress-ring-wide');
}

function compactRing(page: Page) {
  return page.locator('.daily-progress-ring');
}

async function seedTask(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: p }),
    payload,
  );
}

async function seedHabit(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'habits', op: 'upsert', payload: p }),
    payload,
  );
}

async function seedHabitLog(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'habit_logs', op: 'upsert', payload: p }),
    payload,
  );
}

/** 4 heute fällige Aufgaben (1 erledigt) + 2 Tages-Routinen (1 abgehakt) ->
 * done=2, total=6, offen: 3 Aufgaben + 1 Routine. */
async function seedSixDue(page: Page): Promise<void> {
  await seedTask(page, { title: 'Erledigt', dueAt: TODAY_EVENING, completedAt: NOW });
  await seedTask(page, { title: 'Offen 1', dueAt: TODAY_EVENING });
  await seedTask(page, { title: 'Offen 2', dueAt: TODAY_EVENING });
  await seedTask(page, { title: 'Offen 3', dueAt: TODAY_EVENING });
  const doneHabitId = await seedHabit(page, {
    name: 'Wasser trinken',
    schedule: 'daily',
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId: doneHabitId, logDate: '2026-07-15', done: true });
  await seedHabit(page, { name: 'Joggen', schedule: 'daily', color: null, archivedAt: null });
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // Der Ring liest nur aus IndexedDB (CLAUDE.md Regel 8), nie über einen Fetch.
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await page.route('https://api.open-meteo.com/**', (route) => route.abort('failed'));
  await registerPasskey(page, null);
  await skewClock(page, NOW);
});

test('AK1: der Ring besteht aus N Segmenten, erledigte in --on-ground, offene gedämpft', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedSixDue(page);

  const segments = wideRing(page).locator('.daily-progress-ring-wide__segment');
  await expect(segments).toHaveCount(6);
  await expect(wideRing(page).locator('.daily-progress-ring-wide__segment--done')).toHaveCount(2);
  await expect(wideRing(page).locator('.daily-progress-ring-wide__segment--open')).toHaveCount(4);

  const doneColor = await segments.nth(0).evaluate((el) => getComputedStyle(el).stroke);
  const openColor = await segments.nth(5).evaluate((el) => getComputedStyle(el).stroke);
  expect(doneColor).not.toBe(openColor);
});

test('AK2: die Mitte zeigt die erledigte Anzahl groß in --font-display, darunter "von N"', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedSixDue(page);

  const count = wideRing(page).locator('.daily-progress-ring-wide__count');
  const of = wideRing(page).locator('.daily-progress-ring-wide__of');
  await expect(count).toHaveText('2');
  await expect(of).toHaveText('von 6');

  const [countFontSize, titleToken, countFontFamily] = await Promise.all([
    count.evaluate((el) => getComputedStyle(el).fontSize),
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--text-title').trim(),
    ),
    count.evaluate((el) => getComputedStyle(el).fontFamily),
  ]);
  expect(countFontSize).toBe(titleToken);
  // `ui-rounded` ist der erste, unverwechselbare Baustein des Rundschrift-Rezepts
  // (--font-display, issue #859/ADR-0027) — stabiler als ein Stringvergleich
  // zweier unabhängig serialisierter CSS-Werte.
  expect(countFontFamily.toLowerCase()).toContain('ui-rounded');
});

test('AK3: rechts daneben steht "Heute erledigt" und die gedämpfte Aufschlüsselung', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedSixDue(page);

  await expect(wideRing(page).getByText('Heute erledigt')).toBeVisible();
  const breakdown = wideRing(page).locator('.daily-progress-ring-wide__breakdown');
  await expect(breakdown).toHaveText('Offen: 3 Aufgaben, 1 Routine');

  // Gedämpft heißt: sichtbar blasser als das Label direkt daneben.
  const label = wideRing(page).locator('.daily-progress-ring-wide__label');
  const [breakdownColor, labelColor] = await Promise.all([
    breakdown.evaluate((el) => getComputedStyle(el).color),
    label.evaluate((el) => getComputedStyle(el).color),
  ]);
  expect(breakdownColor).not.toBe(labelColor);
});

test('AK4: die Lücken zwischen den Segmenten bleiben sichtbar, stroke-linecap ist butt', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedSixDue(page);

  const segments = wideRing(page).locator('.daily-progress-ring-wide__segment');
  await expect(segments).toHaveCount(6);
  const linecaps = await segments.evaluateAll((els) =>
    els.map((el) => getComputedStyle(el).strokeLinecap),
  );
  expect(linecaps.every((cap) => cap === 'butt')).toBe(true);
});

test('AK5: ab mehr als 24 fälligen Sachen fällt der Ring auf den Vollring zurück', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  for (let i = 0; i < 25; i++) {
    await seedTask(page, { title: `Aufgabe ${i}`, dueAt: TODAY_EVENING });
  }

  await expect(wideRing(page).locator('.daily-progress-ring-wide__segment')).toHaveCount(0);
  await expect(wideRing(page).locator('.daily-progress-ring-wide__arc')).toHaveCount(1);
  await expect(wideRing(page).locator('.daily-progress-ring-wide__count')).toHaveText('0');
  await expect(wideRing(page).locator('.daily-progress-ring-wide__of')).toHaveText('von 25');
});

test('AK6: bei 1280px und 375px bleibt der bestehende 34px-Ring unverändert, der Wide-Ring bleibt unsichtbar', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedSixDue(page);

  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(compactRing(page)).toBeVisible();
    await expect(compactRing(page)).toHaveText('2/6');
    await expect(wideRing(page)).toBeHidden();
  }
});

test('AK7: unter prefers-reduced-motion animiert nichts', async ({ page }) => {
  await page.goto('/uebersicht');
  await seedSixDue(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();

  const segment = wideRing(page).locator('.daily-progress-ring-wide__segment').first();
  const count = wideRing(page).locator('.daily-progress-ring-wide__count');

  for (const locator of [segment, count]) {
    const [transitionDuration, animationName] = await locator.evaluate((el) => {
      const style = getComputedStyle(el);
      return [style.transitionDuration, style.animationName];
    });
    expect(parseFloat(transitionDuration)).toBeLessThan(0.001);
    expect(animationName).toBe('none');
  }
});
