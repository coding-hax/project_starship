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

/* -------------------------------------------------------------------------- */
/* Tagesdetail (issue #1128): zweispaltiges Raster, Kategorie im Kopf,        */
/* Wertachse an beiden Kurven                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Fünfte Desktop-Stufe dieser Datei, diesmal der Tagesdetailseite statt des
 * Streifens oben (issue #1128, Nachfolger von #1117): ab 1440px steht die
 * Verlaufskarte breit links über beide Zeilen, Niederschlag und Werte rechts
 * untereinander; die Kategorie (z. B. „Regen") rückt aus einer eigenen
 * Unterzeile in den Kopf, Haarstrich-getrennt von den Temperaturen; beide
 * Kurven bekommen eine Wertachse links, deren `viewBox` auf die tatsächlich
 * gerenderte Kartenbreite bemessen ist statt hochskaliert zu werden (AK4).
 * Läuft im selben `desktop-wide`-Messplatz wie der Streifen-Test oben. Die
 * gestapelte Form bei 1280px/375px bleibt unverändert — AK6 prüft das gezielt
 * (weather-day.spec.ts, mobile-Messplatz, bleibt die eigentliche Grundlage für
 * die gestapelte Form selbst).
 */

const DAY_DETAIL_WEEK = [
  '2026-07-20',
  '2026-07-21',
  '2026-07-22',
  '2026-07-23',
  '2026-07-24',
  '2026-07-25',
  '2026-07-26',
];
const DAY_DETAIL_NOW = '2026-07-20T09:00:00.000Z';
// Tag 3 (2026-07-23) regnet den ganzen Tag — AK5 braucht eine echte
// 100-%-Spitze, um zu prüfen, dass ihr Achsenlabel nicht beschnitten wird.
const DAY_DETAIL_WEATHER_CODES = DAY_DETAIL_WEEK.map((_, i) => (i === 3 ? 61 : 0));
const DAY_DETAIL_PRECIPITATION_MAX = DAY_DETAIL_WEEK.map((_, i) => (i === 3 ? 100 : 0));
const DAY_DETAIL_TEMPS_MAX = [22, 24, 19, 15, 26, 12, 30];
const DAY_DETAIL_TEMPS_MIN = [12, 14, 9, 5, 16, 2, 20];

async function mockDayDetailForecast(page: Page) {
  await page.route(OPEN_METEO_PATTERN, (route) =>
    route.fulfill({
      json: openMeteoForecastBody({
        dates: DAY_DETAIL_WEEK,
        tempsMax: DAY_DETAIL_TEMPS_MAX,
        tempsMin: DAY_DETAIL_TEMPS_MIN,
        weatherCodes: DAY_DETAIL_WEATHER_CODES,
        precipitationProbabilityMax: DAY_DETAIL_PRECIPITATION_MAX,
      }),
    }),
  );
}

/** Wärmt den IndexedDB-Cache über den Streifen auf /uebersicht — die
 * Detailseite hat keinen eigenen Netzaufruf (issue #156 AC „kein eigener
 * Netzaufruf"), dieselbe Machart wie weather-day.spec.ts's eigene
 * warmForecastCache. */
async function warmForecastCache(page: Page) {
  await page.goto('/uebersicht');
  await expect(weatherDays(page)).toHaveCount(7);
}

test('AK1: bei 1800px steht die Verlaufskarte breit links über beide Zeilen, Niederschlag und Werte stehen rechts untereinander (issue #1128)', async ({
  page,
}) => {
  await installClockAt(page, DAY_DETAIL_NOW);
  await mockDayDetailForecast(page);
  await registerPasskey(page, '/uebersicht');
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  const gridDisplay = await page.locator('.weather-day').evaluate((el) => getComputedStyle(el).display);
  expect(gridDisplay, '.weather-day ist kein Raster').toBe('grid');

  const chartCard = page.locator('.weather-day__card', { hasText: 'Tagesverlauf' });
  const precipCard = page.locator('.weather-day__card', { hasText: 'Niederschlag' });
  const valuesCard = page.locator('.weather-day__values');

  const [chartBox, precipBox, valuesBox] = await Promise.all([
    chartCard.boundingBox(),
    precipCard.boundingBox(),
    valuesCard.boundingBox(),
  ]);
  expect(chartBox, 'Verlaufskarte').not.toBeNull();
  expect(precipBox, 'Niederschlagskarte').not.toBeNull();
  expect(valuesBox, 'Werte-Karte').not.toBeNull();

  expect(chartBox!.x, 'Verlaufskarte steht nicht links von Niederschlag/Werten').toBeLessThan(
    precipBox!.x,
  );
  expect(
    Math.abs(chartBox!.y - precipBox!.y),
    'Verlaufskarte beginnt nicht in derselben Zeile wie Niederschlag',
  ).toBeLessThanOrEqual(4);
  expect(
    Math.abs(precipBox!.x - valuesBox!.x),
    'Niederschlag und Werte teilen keine linke Kante',
  ).toBeLessThanOrEqual(1);
  expect(precipBox!.y, 'Niederschlag steht nicht über den Werten').toBeLessThan(valuesBox!.y);
});

test('AK2: bei 1800px stehen Symbol, Höchst-/Tiefstwert und Kategorie in einer Zeile mit Haarstrichen, Figur rechts, keine eigene Kategoriezeile mehr (issue #1128)', async ({
  page,
}) => {
  await installClockAt(page, DAY_DETAIL_NOW);
  await mockDayDetailForecast(page);
  await registerPasskey(page, '/uebersicht');
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  const icon = page.locator('.weather-day__title-cluster .weather-day__icon');
  const temps = page.locator('.weather-day__title-cluster .weather-day__temps');
  const category = page.locator('.weather-day__category');
  const face = page.locator('.weather-day__title-cluster .face');

  await expect(category, 'Kategorie').toBeVisible();
  await expect(category).toHaveText('Regen');
  await expect(
    page.locator('.page-head__subline'),
    'eigene Kategoriezeile darf ab 1440px nicht mehr existieren',
  ).toHaveCount(0);

  const [iconBox, tempsBox, categoryBox, faceBox] = await Promise.all([
    icon.boundingBox(),
    temps.boundingBox(),
    category.boundingBox(),
    face.boundingBox(),
  ]);
  expect(iconBox, 'Symbol').not.toBeNull();
  expect(tempsBox, 'Höchst-/Tiefstwert').not.toBeNull();
  expect(categoryBox, 'Kategorie').not.toBeNull();
  expect(faceBox, 'Figur').not.toBeNull();

  const centers = [iconBox!, tempsBox!, categoryBox!, faceBox!].map((box) => box.y + box.height / 2);
  const delta = Math.max(...centers) - Math.min(...centers);
  expect(delta, `vertikale Mitten weichen ${delta}px voneinander ab`).toBeLessThanOrEqual(4);

  expect(iconBox!.x, 'Symbol steht nicht links von Höchst-/Tiefstwert').toBeLessThan(tempsBox!.x);
  expect(tempsBox!.x, 'Höchst-/Tiefstwert steht nicht links von der Kategorie').toBeLessThan(
    categoryBox!.x,
  );
  expect(categoryBox!.x, 'Kategorie steht nicht links von der Figur').toBeLessThan(faceBox!.x);

  const [tempsHairline, categoryHairline] = await Promise.all([
    temps.evaluate((el) => parseFloat(getComputedStyle(el).borderInlineStartWidth)),
    category.evaluate((el) => parseFloat(getComputedStyle(el).borderInlineStartWidth)),
  ]);
  expect(tempsHairline, 'Haarstrich vor Höchst-/Tiefstwert fehlt').toBeGreaterThan(0);
  expect(categoryHairline, 'Haarstrich vor Kategorie fehlt').toBeGreaterThan(0);
});

test('AK3/AK4: die Temperaturkurve hat bei 1800px eine Wertachse links und füllt die Kartenbreite, die viewBox ist auf die gemessene Breite bemessen statt hochskaliert (issue #1128)', async ({
  page,
}) => {
  await installClockAt(page, DAY_DETAIL_NOW);
  await mockDayDetailForecast(page);
  await registerPasskey(page, '/uebersicht');
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  const svg = page.locator('.weather-day__chart');
  const [viewBoxAttr, renderedWidth] = await Promise.all([
    svg.getAttribute('viewBox'),
    svg.evaluate((el) => el.getBoundingClientRect().width),
  ]);
  expect(viewBoxAttr).not.toBeNull();
  const [, , viewBoxWidth] = viewBoxAttr!.split(' ').map(Number);

  // AK3: die Kurve füllt die (deutlich breitere) Kartenspalte statt des
  // 420px-Telefon-Deckels.
  expect(viewBoxWidth, 'viewBox ist nicht breiter als die Telefon-Fläche').toBeGreaterThan(320);
  expect(renderedWidth, 'SVG rendert nicht breiter als der Telefon-Deckel').toBeGreaterThan(420);

  // AK4: viewBox-Breite == gerenderte px-Breite (Skalierungsfaktor 1, ±2px für
  // Rundung), statt einer festen viewBox, die hochskaliert würde.
  expect(
    Math.abs(viewBoxWidth - renderedWidth),
    `viewBox (${viewBoxWidth}) weicht von der gerenderten Breite (${renderedWidth}) ab`,
  ).toBeLessThanOrEqual(2);

  // AK3: Gradbeschriftung + waagerechte Hilfslinien.
  await expect(page.locator('.weather-day__chart .weather-day__chart-grid').first()).toBeVisible();
  const ylabels = await page.locator('.weather-day__chart .weather-day__chart-ylabel').allTextContents();
  expect(ylabels.length, 'keine Gradbeschriftung').toBeGreaterThan(0);
  for (const label of ylabels) {
    expect(label.endsWith('°'), `Label "${label}" ist keine Gradangabe`).toBe(true);
  }

  // AK4-Gegenprobe: dieselbe gerenderte Schriftgröße wie bei 375px — sie wächst
  // nicht mit der Kartenbreite mit.
  const wideTickFontSize = await page
    .locator('.weather-day__chart .weather-day__chart-tick')
    .first()
    .evaluate((el) => getComputedStyle(el).fontSize);
  await page.setViewportSize({ width: 375, height: 812 });
  const narrowTickFontSize = await page
    .locator('.weather-day__chart .weather-day__chart-tick')
    .first()
    .evaluate((el) => getComputedStyle(el).fontSize);
  expect(wideTickFontSize, 'Schriftgröße wächst mit der Kartenbreite mit').toBe(narrowTickFontSize);
});

test('AK5: die Niederschlagskurve hat bei 1800px eine Prozent-Wertachse, „100 %" wird nicht beschnitten (issue #1128)', async ({
  page,
}) => {
  await installClockAt(page, DAY_DETAIL_NOW);
  await mockDayDetailForecast(page);
  await registerPasskey(page, '/uebersicht');
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  const svg = page.locator('.weather-day__precipitation-chart');
  const ylabels = await svg.locator('.weather-day__chart-ylabel').allTextContents();
  expect(ylabels).toEqual(['0 %', '50 %', '100 %']);

  const label100 = svg.locator('.weather-day__chart-ylabel', { hasText: '100 %' });
  const [labelBox, svgBox] = await Promise.all([label100.boundingBox(), svg.boundingBox()]);
  expect(labelBox, '„100 %"-Label').not.toBeNull();
  expect(svgBox, 'Niederschlags-SVG').not.toBeNull();
  expect(labelBox!.y, '„100 %" wird oben beschnitten').toBeGreaterThanOrEqual(svgBox!.y - 0.5);
});

test('AK6: bei 1280px und 375px bleiben Kopf, Kartenreihenfolge und Kurvengröße der Tagesdetailseite wie heute (issue #1128)', async ({
  page,
}) => {
  await installClockAt(page, DAY_DETAIL_NOW);
  await mockDayDetailForecast(page);
  await registerPasskey(page, '/uebersicht');
  await warmForecastCache(page);
  await page.goto('/wetter/2026-07-23');

  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);

    const display = await page.locator('.weather-day').evaluate((el) => getComputedStyle(el).display);
    expect(display, `${viewport.width}px: .weather-day ist bereits ein Raster`).not.toBe('grid');

    await expect(
      page.locator('.page-head__subline'),
      `${viewport.width}px: Kategorie-Unterzeile fehlt`,
    ).toHaveText('Regen');
    await expect(
      page.locator('.weather-day__category'),
      `${viewport.width}px: Kategorie steht schon inline im Kopf`,
    ).toHaveCount(0);

    const axis = page.locator('.weather-day__chart .weather-day__chart-axis');
    await expect(axis, `${viewport.width}px: Achse`).toHaveAttribute('x1', '0');
    await expect(axis, `${viewport.width}px: Achse`).toHaveAttribute('x2', '320');
    await expect(
      page.locator('.weather-day__chart .weather-day__chart-grid'),
      `${viewport.width}px: Wertachse sollte fehlen`,
    ).toHaveCount(0);
    await expect(
      page.locator('.weather-day__precipitation-chart .weather-day__chart-grid'),
      `${viewport.width}px: Wertachse sollte fehlen`,
    ).toHaveCount(0);

    const chartMaxWidth = await page
      .locator('.weather-day__chart')
      .evaluate((el) => getComputedStyle(el).maxWidth);
    expect(chartMaxWidth, `${viewport.width}px: 420px-Deckel fehlt`).toBe('420px');
  }
});
