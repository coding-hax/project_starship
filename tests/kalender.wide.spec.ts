import { expect, test, type Locator, type Page } from '@playwright/test';
import { installClockAt, registerPasskey, resetAppData } from './helpers';

/**
 * Dritte Desktop-Stufe (issue #1123, ADR-0030): ab 1440px wird das
 * Monatsraster die Hauptfläche der Route — breite, linke Spalte statt der
 * schmalen 20rem-Spalte aus der zweiten Stufe (kalender.desktop.spec.ts,
 * issue #1021), Termin-Chips statt der Punktreihe. Läuft im
 * `desktop-wide`-Messplatz (1800 × 1000, playwright.config.ts), wie
 * seitenkopf.wide.spec.ts. Die zweite Stufe (768–1439px) und Mobile
 * (375×812) bleiben unverändert — dafür bürgen kalender.desktop.spec.ts und
 * kalender.spec.ts (AK6).
 */

const TODAY = '2026-07-18';
const WEEKDAY_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

async function seedEvent(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'events', op: 'upsert', payload: p }),
    payload,
  );
}

/** Mirrors kalender.spec.ts's own `ariaLabelFor`. */
function ariaLabelFor(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const weekday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
  return `${WEEKDAY_LABELS[weekday]}, ${Number(dateKey.slice(-2))}.`;
}

/** Mirrors kalender.spec.ts's own `monthGridDay`/`monthGridWeeks` scope —
 *  `:not([inert])` excludes the buffered off-screen weeks (issue #1064). */
function monthGridWeeks(page: Page) {
  return page.locator('.month-grid__week:not([inert])');
}

function monthGridDay(page: Page, ariaLabel: string) {
  return monthGridWeeks(page).locator(`.month-grid__day[aria-label="${ariaLabel}"]`);
}

function monthGridBand(page: Page, title: string) {
  return monthGridWeeks(page).locator('.month-grid__band').filter({ hasText: title });
}

async function bandGridColumn(band: Locator): Promise<string> {
  return band.evaluate((el) => {
    const style = getComputedStyle(el);
    return `${style.gridColumnStart}/${style.gridColumnEnd}`;
  });
}

/** Same probe technique as kalender.spec.ts's own `resolveMix` — lets a test
 *  assert the browser's exact resolution of the chip's category mix without
 *  hand-computing the OKLab arithmetic. */
async function resolveMix(page: Page, color: string, percent: number, base: string): Promise<string> {
  return page.evaluate(
    ({ color, percent, base }) => {
      const probe = document.createElement('span');
      probe.style.backgroundColor = `color-mix(in oklab, ${color} ${percent}%, ${base})`;
      document.body.appendChild(probe);
      const resolved = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return resolved;
    },
    { color, percent, base },
  );
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  await installClockAt(page);
  await registerPasskey(page, '/kalender');
  await page.waitForFunction(() => typeof window.__starship?.mutate === 'function', null, {
    polling: 100,
  });
  await page.getByRole('radio', { name: 'Monat' }).click();
});

/* -------------------------------------------------------------------------- */
/* AK1: Monatsraster links breit, Agenda rechts höchstens 400px               */
/* -------------------------------------------------------------------------- */

test('das Monatsraster steht links als breite Spalte, die Agenda rechts daneben bei höchstens 400px (issue #1123 AK1)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Breitraster-Termin',
    allDay: false,
    startsAt: `${TODAY}T09:00:00.000Z`,
    endsAt: `${TODAY}T10:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });

  const grid = page.locator('.month-grid');
  const agenda = page.locator('.event-agenda');
  await expect(grid).toBeVisible();
  await expect(agenda).toBeVisible();

  const [gridBox, agendaBox] = await Promise.all([grid.boundingBox(), agenda.boundingBox()]);
  if (!gridBox || !agendaBox) throw new Error('AK1: Raster oder Agenda ohne BoundingBox');

  // Nebeneinander, das Raster links.
  expect(gridBox.x).toBeLessThan(agendaBox.x);
  expect(gridBox.x + gridBox.width).toBeLessThanOrEqual(agendaBox.x + 1);
  // Höchstens 400px für die Agenda-Spalte.
  expect(agendaBox.width).toBeLessThanOrEqual(401);
  // Das Raster ist die breite Spalte, nicht die schmale — die Umkehr der
  // zweiten Stufe (issue #1021: dort war es die Agenda, die den Raum bekam).
  expect(gridBox.width).toBeGreaterThan(agendaBox.width);
});

/* -------------------------------------------------------------------------- */
/* AK2: Zellgröße, Zahl oben links, bis zu drei Chips + „+N"                  */
/* -------------------------------------------------------------------------- */

test('die Tageszelle ist mindestens 96px hoch, Zahl oben links, bis zu drei Termine als Chips in Kategoriefarbe, der Rest als „+N" (issue #1123 AK2)', async ({
  page,
}) => {
  const categories: [string, string | null][] = [
    ['Arbeit-Chip', 'arbeit'],
    ['Sport-Chip', 'sport'],
    ['Gesundheit-Chip', 'gesundheit'],
    ['Privat-Chip', 'privat'],
  ];
  for (const [index, [title, category]] of categories.entries()) {
    const hour = String(9 + index).padStart(2, '0');
    const nextHour = String(10 + index).padStart(2, '0');
    await seedEvent(page, {
      title,
      allDay: false,
      startsAt: `${TODAY}T${hour}:00:00.000Z`,
      endsAt: `${TODAY}T${nextHour}:00:00.000Z`,
      startDate: null,
      endDate: null,
      category,
    });
  }

  const daySizePx = await page.locator('.month-grid').evaluate((el) =>
    parseFloat(getComputedStyle(el).getPropertyValue('--month-grid-day-size')),
  );
  expect(daySizePx).toBeGreaterThanOrEqual(96);

  const cell = monthGridDay(page, ariaLabelFor(TODAY));
  await expect(cell).toBeVisible();

  // Zahl oben links: ihre linke Kante sitzt nahe der Zellkante, nicht in der
  // Zellmitte (der zentrierte Stand der zweiten Stufe/Mobile).
  const [cellBox, numberBox] = await Promise.all([
    cell.boundingBox(),
    cell.locator('span').first().boundingBox(),
  ]);
  if (!cellBox || !numberBox) throw new Error('AK2: Zelle oder Zahl ohne BoundingBox');
  expect(numberBox.x).toBeLessThan(cellBox.x + cellBox.width / 3);

  const chips = cell.locator('.month-grid__chip:not(.month-grid__chip--overflow)');
  await expect(chips).toHaveCount(3);
  await expect(chips.nth(0)).toHaveText('Arbeit-Chip');
  await expect(chips.nth(1)).toHaveText('Sport-Chip');
  await expect(chips.nth(2)).toHaveText('Gesundheit-Chip');

  const overflow = cell.locator('.month-grid__chip--overflow');
  await expect(overflow).toHaveText('+1');

  const expectedBg = await resolveMix(page, 'var(--cat-arbeit)', 85, 'var(--text-base)');
  await expect(chips.nth(0)).toHaveCSS('background-color', expectedBg);
});

/* -------------------------------------------------------------------------- */
/* AK3: Punkte stehen ab 1440px nicht mehr — Chips ersetzen sie               */
/* -------------------------------------------------------------------------- */

test('die Punkte (.month-grid__dots) stehen ab 1440px nicht mehr — Chips ersetzen sie (issue #1123 AK3)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Punkt-oder-Chip',
    allDay: false,
    startsAt: `${TODAY}T09:00:00.000Z`,
    endsAt: `${TODAY}T10:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: 'arbeit',
  });

  const cell = monthGridDay(page, ariaLabelFor(TODAY));
  await expect(cell.locator('.month-grid__chip')).toBeVisible();
  await expect(cell.locator('.month-grid__dots')).not.toBeVisible();
  await expect(cell.locator('.month-grid__dot')).not.toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* AK4: mehrtägiges Ganztägig-Band läuft unverändert über seine Spalten       */
/* -------------------------------------------------------------------------- */

test('ein mehrtägiger ganztägiger Termin läuft weiterhin als durchgehendes Band über die betroffenen Spalten (issue #1123 AK4, vgl. #1043 AK9/#1061)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Breitraster-Kurztrip',
    allDay: true,
    startsAt: null,
    endsAt: null,
    startDate: '2026-07-14', // Dienstag
    endDate: '2026-07-16', // Donnerstag
    category: 'familie',
  });

  const band = monthGridBand(page, 'Breitraster-Kurztrip');
  await expect(band).toBeVisible();
  await expect(band.locator('.month-grid__band-title')).toHaveText('Breitraster-Kurztrip');
  expect(await bandGridColumn(band)).toBe('2/5'); // Di=Spalte 2 .. Do=Spalte 4
});

/* -------------------------------------------------------------------------- */
/* AK5: Agenda klebt oben an der Tagesüberschrift                             */
/* -------------------------------------------------------------------------- */

test('die Agenda klebt oben an der Tagesüberschrift, statt um die halbe Rasterhöhe nach unten zu rutschen (issue #1123 AK5)', async ({
  page,
}) => {
  // Bewusst kein Termin an TODAY: die Agenda bleibt so kurz wie möglich,
  // während das Raster (sechs 128px-Wochenzeilen) deutlich höher bleibt als
  // Tagesüberschrift + Agenda zusammen — genau der Fall, in dem Chromium ohne
  // `grid-template-rows` die Überhöhe zur Hälfte auf beide Zeilen verteilt
  // hätte (calendar-view.css).
  const dayHeading = page.locator('.calendar-view__day-heading');
  const agenda = page.locator('.event-agenda');
  await expect(dayHeading).toBeVisible();
  await expect(agenda).toBeVisible();

  const [headingBox, agendaBox] = await Promise.all([
    dayHeading.boundingBox(),
    agenda.boundingBox(),
  ]);
  if (!headingBox || !agendaBox) throw new Error('AK5: Tagesüberschrift oder Agenda ohne BoundingBox');

  const gap = agendaBox.y - (headingBox.y + headingBox.height);
  // Der normale Abstand aus calendar-view.css (`--space-3`/`--space-2`) bleibt
  // im einstelligen bis niedrigen zweistelligen Pixelbereich — ein Rutsch um
  // die halbe Rasterhöhe wäre um ein Vielfaches größer.
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThan(40);
});

/* -------------------------------------------------------------------------- */
/* AK6 (Nicht-Regression): siehe kalender.desktop.spec.ts (1280px) und        */
/* kalender.spec.ts (375px, mobile-Messplatz) — dort unverändert.             */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* issue #1124: die Wochenansicht wird ab 1440px sieben Tagesspalten,         */
/* der gewählte Tag darunter ausführlich.                                    */
/* -------------------------------------------------------------------------- */

function todayStripCell(page: Page) {
  return page.locator('.calendar-strip__day[data-today]');
}

/* -------------------------------------------------------------------------- */
/* AK1: sieben ≥300px hohe Spalten mit Terminen als Chips                     */
/* -------------------------------------------------------------------------- */

test('die Wochenansicht wird ab 1440px zu sieben Spalten, die Termine des Tages als Chips (Uhrzeit über Titel, Kategoriekante) (issue #1124 AK1)', async ({
  page,
}) => {
  await page.getByRole('radio', { name: 'Woche' }).click();
  await seedEvent(page, {
    title: 'Spalten-Termin',
    allDay: false,
    startsAt: `${TODAY}T09:00:00.000Z`,
    endsAt: `${TODAY}T10:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: 'arbeit',
  });

  const days = page.locator('.calendar-strip__day:not([inert])');
  await expect(days).toHaveCount(7);
  for (let index = 0; index < 7; index += 1) {
    const box = await days.nth(index).boundingBox();
    if (!box) throw new Error(`AK1: Spalte ${index} ohne BoundingBox`);
    expect(box.height).toBeGreaterThanOrEqual(300);
  }

  const todayCell = todayStripCell(page);
  const chip = todayCell.locator('.calendar-strip__chip').filter({ hasText: 'Spalten-Termin' });
  await expect(chip).toBeVisible();

  const [timeBox, titleBox] = await Promise.all([
    chip.locator('.calendar-strip__chip-time').boundingBox(),
    chip.locator('.calendar-strip__chip-title').boundingBox(),
  ]);
  if (!timeBox || !titleBox) throw new Error('AK1: Chip-Zeit oder -Titel ohne BoundingBox');
  await expect(chip.locator('.calendar-strip__chip-time')).toHaveText('09:00');
  expect(timeBox.y).toBeLessThan(titleBox.y);

  const expectedEdge = await resolveMix(page, 'var(--cat-arbeit)', 85, 'var(--text-base)');
  expect(await chip.evaluate((el) => getComputedStyle(el).borderInlineStartColor)).toBe(expectedEdge);

  await expect(todayCell.locator('.calendar-strip__dots')).not.toBeVisible();
  await expect(todayCell.locator('.calendar-strip__dot')).not.toBeVisible();
});
