import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, skewClock } from './helpers';

/**
 * Zählpille statt Segmentring ab 1440px (issue #1180, hebt #1122 auf):
 * dieselbe `computeDailyProgress`-Zahl, jetzt „N von M erledigt" im
 * Zusatz-Slot der Kopfzeile statt eines Segmentrings in der Augenbraue. Läuft
 * im `desktop-wide`-Messplatz (1800 × 1000, playwright.config.ts), wie
 * seitenkopf.wide.spec.ts. Unterhalb von 1440px bleibt der bestehende
 * 34px-Ring unverändert — dafür bürgt uebersicht-progress-ring.spec.ts, AK7
 * unten prüft zusätzlich gezielt, dass die neue Regel dort gar nicht erst
 * greift.
 */

const NOW = '2026-07-15T12:00:00.000Z';
const TODAY_EVENING = '2026-07-15T18:00:00.000Z';

function pill(page: Page) {
  return page.locator('.daily-progress-pill');
}

function compactRing(page: Page) {
  return page.locator('.daily-progress-ring');
}

function greetingGroup(page: Page) {
  return page.locator('.uebersicht__title-cluster');
}

function settingsLink(page: Page) {
  return page.locator('[data-ground="uebersicht"] .app-header--inline .app-header__settings');
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

/** `main.shell__main`'s Innenkante, dieselbe Technik wie seitenkopf.wide.spec.ts. */
async function contentColumnBox(page: Page) {
  const main = page.locator('main.shell__main');
  const [box, padding] = await Promise.all([
    main.boundingBox(),
    main.evaluate((el) => {
      const style = getComputedStyle(el);
      return { left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight) };
    }),
  ]);
  if (!box) throw new Error('main.shell__main hat keine Bounding Box');
  return {
    x: box.x + padding.left,
    width: box.width - padding.left - padding.right,
  };
}

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // Der Ring/die Pille liest nur aus IndexedDB (CLAUDE.md Regel 8), nie über einen Fetch.
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await page.route('https://api.open-meteo.com/**', (route) => route.abort('failed'));
  await registerPasskey(page, null);
  await skewClock(page, NOW);
});

test('AK1: Datum, Begrüßung, Pille und Einstellungen stehen in dieser Reihenfolge, mit demselben vertikalen Mittelpunkt (±4px)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedSixDue(page);

  const date = page.locator('.uebersicht__eyebrow-date');
  const greeting = greetingGroup(page);
  const pillBox = await pill(page).boundingBox();
  const settings = settingsLink(page);

  await expect(date).toBeVisible();
  await expect(greeting).toBeVisible();
  await expect(settings).toBeVisible();

  const [dateBox, greetingBox, settingsBox] = await Promise.all([
    date.boundingBox(),
    greeting.boundingBox(),
    settings.boundingBox(),
  ]);
  expect(dateBox).not.toBeNull();
  expect(greetingBox).not.toBeNull();
  expect(pillBox).not.toBeNull();
  expect(settingsBox).not.toBeNull();

  // Reihenfolge: jede Box beginnt weiter rechts als die vorige endet.
  expect(dateBox!.x + dateBox!.width, 'Datum vor Begrüßung').toBeLessThanOrEqual(greetingBox!.x);
  expect(greetingBox!.x + greetingBox!.width, 'Begrüßung vor Pille').toBeLessThanOrEqual(pillBox!.x);
  expect(pillBox!.x + pillBox!.width, 'Pille vor Einstellungen').toBeLessThanOrEqual(settingsBox!.x);

  const centers = [dateBox!, greetingBox!, pillBox!, settingsBox!].map((box) => box.y + box.height / 2);
  const delta = Math.max(...centers) - Math.min(...centers);
  expect(delta, `vertikale Mitten weichen ${delta}px voneinander ab`).toBeLessThanOrEqual(4);
});

test('AK2: die Begrüßungsgruppe steht mittig in der Inhaltsspalte (±4px)', async ({ page }) => {
  await page.goto('/uebersicht');
  await seedSixDue(page);

  const [content, greetingBox] = await Promise.all([
    contentColumnBox(page),
    greetingGroup(page).boundingBox(),
  ]);
  expect(greetingBox).not.toBeNull();

  const contentCenter = content.x + content.width / 2;
  const greetingCenter = greetingBox!.x + greetingBox!.width / 2;
  expect(
    Math.abs(contentCenter - greetingCenter),
    `Begrüßungsmitte ${greetingCenter} vs. Inhaltsmitte ${contentCenter}`,
  ).toBeLessThanOrEqual(4);
});

test('AK3: die Pille zeigt "N von M erledigt", die Aufschlüsselung bleibt gedämpft daneben', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedSixDue(page);

  const count = page.locator('.daily-progress-pill__count');
  const breakdown = page.locator('.daily-progress-pill__breakdown');
  await expect(count).toHaveText('2 von 6 erledigt');
  await expect(breakdown).toHaveText('Offen: 3 Aufgaben, 1 Routine');

  // Gedämpft heißt: sichtbar blasser als die Pille direkt daneben.
  const [breakdownColor, countColor] = await Promise.all([
    breakdown.evaluate((el) => getComputedStyle(el).color),
    count.evaluate((el) => getComputedStyle(el).color),
  ]);
  expect(breakdownColor).not.toBe(countColor);
});

test('AK3: ohne offene Sachen zeigt die Aufschlüsselung "Alles erledigt" (wortgleich zum bisherigen Zustand)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Erledigt', dueAt: TODAY_EVENING, completedAt: NOW });

  await expect(page.locator('.daily-progress-pill__count')).toHaveText('1 von 1 erledigt');
  await expect(page.locator('.daily-progress-pill__breakdown')).toHaveText('Alles erledigt');
});

test('AK4: die Pille sitzt mittig im freien Feld zwischen Begrüßungsgruppe und Einstellungs-Einstieg (±8px), ohne beides zu überlappen', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedSixDue(page);

  const [greetingBox, pillBox, settingsBox] = await Promise.all([
    greetingGroup(page).boundingBox(),
    pill(page).boundingBox(),
    settingsLink(page).boundingBox(),
  ]);
  expect(greetingBox).not.toBeNull();
  expect(pillBox).not.toBeNull();
  expect(settingsBox).not.toBeNull();

  const freeFieldStart = greetingBox!.x + greetingBox!.width;
  const freeFieldEnd = settingsBox!.x;
  const gapToGreeting = pillBox!.x - freeFieldStart;
  const gapToSettings = freeFieldEnd - (pillBox!.x + pillBox!.width);
  expect(
    Math.abs(gapToGreeting - gapToSettings),
    `Abstand zur Begrüßung ${gapToGreeting}px vs. zu Einstellungen ${gapToSettings}px`,
  ).toBeLessThanOrEqual(8);

  expect(overlaps(greetingBox!, pillBox!), 'Begrüßung und Pille überlappen sich nicht').toBe(false);
  expect(overlaps(pillBox!, settingsBox!), 'Pille und Einstellungen überlappen sich nicht').toBe(false);
});

test('AK7: bei 1280px und 375px bleibt der bestehende 34px-Ring unverändert, die Pille bleibt unsichtbar', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedSixDue(page);

  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(compactRing(page)).toBeVisible();
    await expect(compactRing(page)).toHaveText('2/6');
    await expect(pill(page)).toBeHidden();
  }
});

test('AK8: bei M = 0 rendert die Pille nicht, Begrüßung und Einstellungen bleiben an derselben Stelle (±2px)', async ({
  page,
}) => {
  // M = 0 zuerst: frischer Account, nichts fällig, also weder Ring noch Pille
  // (issue #428 AK4) — kein nachträgliches Löschen nötig.
  await page.goto('/uebersicht');
  await expect(pill(page)).toHaveCount(0);

  const [greetingWithout, settingsWithout] = await Promise.all([
    greetingGroup(page).boundingBox(),
    settingsLink(page).boundingBox(),
  ]);

  await seedSixDue(page);
  await expect(pill(page)).toBeVisible();

  const [greetingWith, settingsWith] = await Promise.all([
    greetingGroup(page).boundingBox(),
    settingsLink(page).boundingBox(),
  ]);

  expect(greetingWith).not.toBeNull();
  expect(greetingWithout).not.toBeNull();
  expect(settingsWith).not.toBeNull();
  expect(settingsWithout).not.toBeNull();

  expect(
    Math.abs(greetingWith!.x - greetingWithout!.x),
    'Begrüßung springt beim Wegfall der Pille',
  ).toBeLessThanOrEqual(2);
  expect(
    Math.abs(settingsWith!.x - settingsWithout!.x),
    'Einstellungen springt beim Wegfall der Pille',
  ).toBeLessThanOrEqual(2);
});
