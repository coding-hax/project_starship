import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, skewClock } from './helpers';

/**
 * Issue #1184 (Phase A) — der Verlauf auf `/routinen` lässt sich seitlich in
 * die Vergangenheit wischen, feste 30 Tage. Phase B (AK8–10, Zeitraum in den
 * Einstellungen) hat eigene Specs.
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

/** Local calendar day as `YYYY-MM-DD`, same rule as `due-today.ts`'s `toDateKey`. */
function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** `count` days before the skewed clock's `NOW`, local calendar. */
function daysAgo(count: number): Date {
  const now = new Date(NOW);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - count);
}

function scrollContainer(page: Page) {
  return page.locator('.habit-history-card__scroll');
}

async function scrollToStart(page: Page): Promise<void> {
  await scrollContainer(page).evaluate((el) => {
    el.scrollLeft = 0;
  });
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // The page must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await registerPasskey(page);
  await skewClock(page, NOW);
});

/* -------------------------------------------------------------------------- */
/* AK1: wischbar, kein Seiten-Überlauf, Einrasten auf Tagesgrenzen            */
/* -------------------------------------------------------------------------- */

test('AK1: das Raster ist waagerecht scrollbar (scroll-snap-type x proximity, Einrasten auf Tagesgrenzen), die Seite selbst hat keinen Überlauf', async ({
  page,
}) => {
  const habitId = await seedHabit(page, { name: 'Wisch-Sonde', createdAt: daysAgo(90).toISOString() });
  await seedHabitLog(page, habitId, TODAY);
  await page.goto('/routinen');

  const scroll = scrollContainer(page);
  await expect(scroll).toHaveCSS('scroll-snap-type', 'x proximity');

  const [scrollWidth, clientWidth] = await scroll.evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(scrollWidth, 'das Raster reicht über den Container hinaus').toBeGreaterThan(clientWidth);

  const daySnap = page.locator('.habit-history-card__cell[data-day-start]').first();
  await expect(daySnap).toHaveCSS('scroll-snap-align', 'start');

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth, `kein waagerechter Seiten-Überlauf (${scheme})`).toBeLessThanOrEqual(
      overflow.clientWidth,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* AK2: Startposition ganz rechts, sofort, ohne smooth                       */
/* -------------------------------------------------------------------------- */

test('AK2: /routinen lädt mit dem Container ganz rechts gescrollt, ohne scroll-behavior: smooth', async ({
  page,
}) => {
  const habitId = await seedHabit(page, { name: 'Start-Sonde', createdAt: daysAgo(90).toISOString() });
  await seedHabitLog(page, habitId, TODAY);
  await page.goto('/routinen');

  const scroll = scrollContainer(page);
  await expect(scroll).not.toHaveCSS('scroll-behavior', 'smooth');

  const [scrollLeft, scrollWidth, clientWidth] = await scroll.evaluate((el) => [
    el.scrollLeft,
    el.scrollWidth,
    el.clientWidth,
  ]);
  expect(Math.abs(scrollLeft - (scrollWidth - clientWidth)), 'Container steht ganz rechts').toBeLessThanOrEqual(1);

  // "heute" ist die letzte Zelle jeder Zeile — ihr rechter Rand liegt auf dem
  // rechten Rand des Containers.
  const lastCell = page.locator('.habit-history-card__cell').last();
  const [cellBox, scrollBox] = await Promise.all([lastCell.boundingBox(), scroll.boundingBox()]);
  expect(cellBox, 'letzte Zelle hat eine Fläche').not.toBeNull();
  expect(scrollBox, 'Container hat eine Fläche').not.toBeNull();
  if (!cellBox || !scrollBox) return;
  expect(cellBox.x + cellBox.width, 'heute steht am rechten Rand').toBeCloseTo(scrollBox.x + scrollBox.width, 0);
});

/* -------------------------------------------------------------------------- */
/* AK3: linker Rand — Anlagetag, älterer Log, archiviert zählt nicht          */
/* -------------------------------------------------------------------------- */

test('AK3: eine vor 90 Tagen angelegte Routine zeigt nach dem Wischen ganz nach links den Anlagetag als ersten sichtbaren Tag', async ({
  page,
}) => {
  const created = daysAgo(90);
  await seedHabit(page, { name: 'Alt-Sonde', createdAt: created.toISOString() });
  await page.goto('/routinen');

  await scrollToStart(page);

  const expectedLabel = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short' }).format(created);
  await expect(page.locator('.habit-history-card__axis span').first()).toHaveText(expectedLabel);
});

test('AK3: ein Log vor dem Anlagedatum verschiebt den linken Rand auf den Tag des Logs', async ({ page }) => {
  const created = daysAgo(90);
  const habitId = await seedHabit(page, { name: 'Log-vor-Anlage-Sonde', createdAt: created.toISOString() });
  const olderLog = daysAgo(120);
  await seedHabitLog(page, habitId, dateKey(olderLog));
  await page.goto('/routinen');

  await scrollToStart(page);

  const expectedLabel = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short' }).format(olderLog);
  await expect(page.locator('.habit-history-card__axis span').first()).toHaveText(expectedLabel);
});

test('AK3: eine archivierte Routine und ihre Logs verschieben den linken Rand nicht', async ({ page }) => {
  await seedHabit(page, { name: 'Aktive-Sonde' }); // default createdAt → epoch, ignored → floor bleibt 30 Tage
  const archived = await seedHabit(page, {
    name: 'Archiv-Sonde',
    createdAt: daysAgo(200).toISOString(),
    archivedAt: daysAgo(1).toISOString(),
  });
  await seedHabitLog(page, archived, dateKey(daysAgo(200)));
  await page.goto('/routinen');

  const scroll = scrollContainer(page);
  const [scrollWidth, clientWidth] = await scroll.evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(Math.abs(scrollWidth - clientWidth), 'Raster bleibt bei 30 Tagen nicht scrollbar').toBeLessThanOrEqual(1);
});

/* -------------------------------------------------------------------------- */
/* AK4: linker Rand innerhalb eines Fensters → nicht scrollbar, 90 Zellen     */
/* -------------------------------------------------------------------------- */

test('AK4: sind alle Routinen heute angelegt und gibt es keine älteren Logs, ist das Raster nicht scrollbar und zeigt 90 Zellen bei 3 Routinen', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Heute-A' });
  await seedHabit(page, { name: 'Heute-B' });
  await seedHabit(page, { name: 'Heute-C' });
  await page.goto('/routinen');

  await expect(page.locator('.habit-history-card__cell')).toHaveCount(90);

  const scroll = scrollContainer(page);
  const [scrollWidth, clientWidth] = await scroll.evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(Math.abs(scrollWidth - clientWidth)).toBeLessThanOrEqual(1);
});

/* -------------------------------------------------------------------------- */
/* AK5: Kopfzahl folgt dem sichtbaren Ausschnitt                             */
/* -------------------------------------------------------------------------- */

test('AK5: die Kopfzahl zeigt 2 im Ruhezustand (heute) und 1 nach dem Wischen ganz nach links, wo der einzige alte Log liegt', async ({
  page,
}) => {
  const a = await seedHabit(page, { name: 'Heute-A' });
  const b = await seedHabit(page, { name: 'Heute-B' });
  const c = await seedHabit(page, { name: 'Alt-C' });
  await seedHabitLog(page, a, TODAY);
  await seedHabitLog(page, b, TODAY);
  await seedHabitLog(page, c, dateKey(daysAgo(60)));
  await page.goto('/routinen');

  await expect(page.locator('.habit-history-card__value')).toHaveText('2');

  await scrollToStart(page);
  await expect(page.locator('.habit-history-card__value')).toHaveText('1');
});

/* -------------------------------------------------------------------------- */
/* AK6: Achse — relative Phrase im Ruhezustand, sonst Datumsbereich + Jahr    */
/* -------------------------------------------------------------------------- */

test('AK6: die Achse zeigt im Ruhezustand "vor 30 Tagen" / "heute"', async ({ page }) => {
  await seedHabit(page, { name: 'Achsen-Ruhe-Sonde' });
  await page.goto('/routinen');

  const axisSpans = page.locator('.habit-history-card__axis span');
  await expect(axisSpans.nth(0)).toHaveText('vor 30 Tagen');
  await expect(axisSpans.nth(1)).toHaveText('heute');
});

test('AK6: nach dem Wischen zeigt die Achse den Datumsbereich, mit Jahr außerhalb des laufenden Jahres', async ({
  page,
}) => {
  await seedHabit(page, { name: 'Jahres-Sonde', createdAt: '2025-12-20T00:00:00.000Z' });
  await page.goto('/routinen');

  await scrollToStart(page);
  await expect(page.locator('.habit-history-card__axis span').first()).toHaveText('20. Dez. 2025');
});

/* -------------------------------------------------------------------------- */
/* AK7: Etikett, role="img", aria-Label wechselt mit dem Ausschnitt          */
/* -------------------------------------------------------------------------- */

test('AK7: das aria-Label wechselt nach dem Wischen von der relativen Phrase zu "N Erledigungen vom … bis …", role="img" bleibt', async ({
  page,
}) => {
  const habitId = await seedHabit(page, { name: 'Label-Sonde', createdAt: daysAgo(90).toISOString() });
  await seedHabitLog(page, habitId, TODAY);
  await page.goto('/routinen');

  await expect(page.locator('.habit-history-card').getByText('Erledigt · 30 Tage')).toBeVisible();

  const grid = page.locator('.habit-history-card__grid');
  await expect(grid).toHaveAttribute('role', 'img');
  await expect(grid).toHaveAttribute('aria-label', /Erledigungen in den letzten 30 Tagen$/);

  await scrollToStart(page);
  await expect(grid).toHaveAttribute('aria-label', /^\d+ Erledigungen vom .+ bis .+$/);
  await expect(grid).toHaveAttribute('role', 'img');

  const emoji = page.locator('.habit-history-card__emoji').first();
  await expect(emoji).toHaveAttribute('aria-hidden', 'true');
});

/* -------------------------------------------------------------------------- */
/* AK11: offline wischbar, Kopfzahl folgt weiterhin dem Ausschnitt           */
/* -------------------------------------------------------------------------- */

test('AK11: offline lässt sich das Raster mit lokal vorhandenen Logs wischen, die Kopfzahl folgt dem Ausschnitt', async ({
  page,
  context,
}) => {
  const a = await seedHabit(page, { name: 'Offline-A' });
  const b = await seedHabit(page, { name: 'Offline-B' });
  const c = await seedHabit(page, { name: 'Offline-Alt-C' });
  await seedHabitLog(page, a, TODAY);
  await seedHabitLog(page, b, TODAY);
  await seedHabitLog(page, c, dateKey(daysAgo(60)));

  await context.setOffline(true);
  await page.goto('/routinen');

  await expect(page.locator('.habit-history-card__value')).toHaveText('2');

  await scrollToStart(page);
  await expect(page.locator('.habit-history-card__value')).toHaveText('1');
});
