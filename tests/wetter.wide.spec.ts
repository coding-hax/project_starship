import { expect, test, type Page } from '@playwright/test';
import { installClockAt, openMeteoForecastBody, registerPasskey, resetAppData } from './helpers';

/**
 * Vierte Desktop-Stufe des Wetterstreifens (issue #1119, Nachfolger von
 * #1117): ab 1440px legt sich jeder Tag als zweispaltiges Raster hin statt
 * gestapelt — Symbol (38×38px) groß links über beide Zeilen, Wochentag +
 * Tagesnummer rechts oben, Höchst- und Tiefstwert rechts unten nebeneinander.
 * Läuft im `desktop-wide`-Messplatz (1800 × 1000, playwright.config.ts), wie
 * seitenkopf.wide.spec.ts. Die gestapelte Form bei 375px bleibt unverändert
 * — AK5 unten prüft gezielt, dass die neue Regel unterhalb von 1440px gar
 * nicht erst greift (weather.spec.ts, mobile-Messplatz, bleibt die eigentliche
 * Grundlage für die gestapelte Form selbst).
 */

const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';
const GARMIN_SYNC_PATTERN = '**/api/garmin-sync';
const SYNC_COUNTERS = { scanned: 0, created: 0, updated: 0, detailsFilled: 0, mapsFilled: 0 };

// Enthält bewusst einstellige Tagesnummern (7, 8, 9) — genau das Beispiel aus
// dem Ticket.
const FORECAST_WEEK = [
  '2026-07-07',
  '2026-07-08',
  '2026-07-09',
  '2026-07-10',
  '2026-07-11',
  '2026-07-12',
  '2026-07-13',
];
const WEEKDAYS = ['Di', 'Mi', 'Do', 'Fr', 'Sa', 'So', 'Mo'];
const NOW = '2026-07-07T09:00:00.000Z';

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // /uebersicht löst beim Laden echte Netzaufrufe aus (Garmin-Sync, Open-Meteo),
  // die ungemockt als Konsolenfehler/Dev-Overlay im DOM landen (wie seitenkopf.wide.spec.ts).
  await page.route(GARMIN_SYNC_PATTERN, (route) => route.fulfill({ json: SYNC_COUNTERS }));
  await page.route(OPEN_METEO_PATTERN, (route) =>
    route.fulfill({
      json: openMeteoForecastBody({
        dates: FORECAST_WEEK,
        tempsMax: FORECAST_WEEK.map(() => 20),
        tempsMin: FORECAST_WEEK.map(() => 10),
      }),
    }),
  );
});

function weatherDays(page: Page) {
  return page.locator('.weather-forecast').getByRole('listitem');
}

test('AK1/AK2/AK3/AK4: bei 1800px liegt jeder Tag als zweispaltiges Raster mit Tagesnummer, der Streifen bleibt ≤100px hoch', async ({
  page,
}) => {
  await installClockAt(page, NOW);
  await registerPasskey(page, '/uebersicht');

  const days = weatherDays(page);
  await expect(days).toHaveCount(7);

  // AK4: der ganze Streifen (Karte inkl. Polsterung) bleibt ≤100px hoch —
  // heute ~120px gestapelt.
  const cardBox = await page.locator('.weather-forecast').boundingBox();
  expect(cardBox).not.toBeNull();
  expect(cardBox!.height, `Streifen ist ${cardBox!.height}px hoch statt ≤100px`).toBeLessThanOrEqual(100);

  for (let i = 0; i < 7; i += 1) {
    const day = days.nth(i);
    const link = day.locator('.weather-forecast__day-link');
    const icon = day.locator('.weather-forecast__icon');
    const weekdayRow = day.locator('.weather-forecast__weekday-row');
    const tempMax = day.locator('.weather-forecast__temp-max');
    const tempMin = day.locator('.weather-forecast__temp-min');
    const daynum = day.locator('.weather-forecast__daynum');

    await expect(day.locator('.weather-forecast__weekday'), `Tag ${i}: Kürzel`).toHaveText(WEEKDAYS[i]);

    // AK1: `.weather-forecast__day-link` ist ein zweispaltiges Raster.
    const grid = await link.evaluate((el) => {
      const style = getComputedStyle(el);
      return { display: style.display, columns: style.gridTemplateColumns.trim().split(/\s+/) };
    });
    expect(grid.display, `Tag ${i}: kein Raster`).toBe('grid');
    expect(grid.columns.length, `Tag ${i}: kein zweispaltiges Raster (${grid.columns.join(' ')})`).toBe(2);
    expect(Math.round(parseFloat(grid.columns[0])), `Tag ${i}: erste Spalte nicht 38px breit`).toBe(38);

    const [iconBox, weekdayBox, tempMaxBox, tempMinBox] = await Promise.all([
      icon.boundingBox(),
      weekdayRow.boundingBox(),
      tempMax.boundingBox(),
      tempMin.boundingBox(),
    ]);
    expect(iconBox, `Tag ${i}: Symbol`).not.toBeNull();
    expect(weekdayBox, `Tag ${i}: Wochentagzeile`).not.toBeNull();
    expect(tempMaxBox, `Tag ${i}: Höchstwert`).not.toBeNull();
    expect(tempMinBox, `Tag ${i}: Tiefstwert`).not.toBeNull();

    // AK1: Symbol 38×38px in Spalte 1, links von Wochentag/Werten, über beide Zeilen.
    expect(Math.round(iconBox!.width), `Tag ${i}: Symbolbreite`).toBe(38);
    expect(Math.round(iconBox!.height), `Tag ${i}: Symbolhöhe`).toBe(38);
    expect(iconBox!.x, `Tag ${i}: Symbol steht nicht links von der Wochentagzeile`).toBeLessThan(
      weekdayBox!.x,
    );
    expect(iconBox!.y, `Tag ${i}: Symbol beginnt nicht über/mit der Wochentagzeile`).toBeLessThanOrEqual(
      weekdayBox!.y + 2,
    );
    expect(
      iconBox!.y + iconBox!.height,
      `Tag ${i}: Symbol reicht nicht bis zum Höchstwert darunter`,
    ).toBeGreaterThanOrEqual(tempMaxBox!.y + tempMaxBox!.height - 2);

    // AK1: Wochentag (Zeile 1) steht über Höchst-/Tiefstwert (Zeile 2).
    expect(weekdayBox!.y, `Tag ${i}: Wochentag steht nicht über dem Höchstwert`).toBeLessThan(
      tempMaxBox!.y,
    );

    // AK1: Höchst- und Tiefstwert stehen nebeneinander, nicht gestapelt.
    expect(
      Math.abs(tempMaxBox!.y - tempMinBox!.y),
      `Tag ${i}: Höchst-/Tiefstwert stehen nicht in derselben Zeile`,
    ).toBeLessThanOrEqual(4);
    expect(tempMaxBox!.x, `Tag ${i}: Höchstwert steht nicht links vom Tiefstwert`).toBeLessThan(
      tempMinBox!.x,
    );

    // AK2: Wochentag beginnt an derselben linken Kante wie der Höchstwert darunter (±1px).
    // Die Basisregel setzt `justify-content: center` auf .weather-forecast__weekday-row —
    // ohne `flex-start` in der Breakpoint-Regel schwämme der Tag nach rechts.
    expect(
      Math.abs(weekdayBox!.x - tempMaxBox!.x),
      `Tag ${i}: Wochentag (${weekdayBox!.x}) und Höchstwert (${tempMaxBox!.x}) teilen keine linke Kante`,
    ).toBeLessThanOrEqual(1);

    // AK3: Tagesnummer steht sichtbar neben dem Wochentag-Kürzel.
    await expect(daynum, `Tag ${i}: Tagesnummer`).toBeVisible();
    await expect(daynum, `Tag ${i}: Tagesnummer-Wert`).toHaveText(
      String(Number(FORECAST_WEEK[i].slice(-2))),
    );
  }

  // AK4: Höchstwert auf --text-section statt der kompakten Sekundärgröße.
  const [tempMaxFontSize, sectionToken] = await Promise.all([
    days.first().locator('.weather-forecast__temp-max').evaluate((el) => getComputedStyle(el).fontSize),
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--text-section').trim()),
  ]);
  expect(tempMaxFontSize, 'Höchstwert-Schriftgröße').toBe(sectionToken);
});

test('AK5: bei 375px bleibt die Zelle gestapelt und die Tagesnummer bleibt unsichtbar', async ({ page }) => {
  await installClockAt(page, NOW);
  await registerPasskey(page, '/uebersicht');
  await page.setViewportSize({ width: 375, height: 812 });

  const days = weatherDays(page);
  await expect(days).toHaveCount(7);

  const firstLink = days.first().locator('.weather-forecast__day-link');
  const layout = await firstLink.evaluate((el) => {
    const style = getComputedStyle(el);
    return { display: style.display, flexDirection: style.flexDirection };
  });
  expect(layout.display, '375px: .weather-forecast__day-link ist bereits ein Raster').toBe('flex');
  expect(layout.flexDirection, '375px: .weather-forecast__day-link ist nicht mehr gestapelt').toBe(
    'column',
  );

  for (let i = 0; i < 7; i += 1) {
    await expect(
      days.nth(i).locator('.weather-forecast__daynum'),
      `Tag ${i}: Tagesnummer sollte bei 375px unsichtbar sein`,
    ).toBeHidden();
  }
});
