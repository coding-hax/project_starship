import { expect, test, type Locator, type Page } from '@playwright/test';
import { freezeClock, installClockAt, registerPasskey, resetAppData, skewClock } from './helpers';

// installClockAt's default (helpers.ts) is 2026-07-18T12:00:00.000Z — 14:00
// Berlin (CEST, UTC+2), same calendar day as every event seeded below unless
// noted otherwise.
const TODAY = '2026-07-18';
const TOMORROW = '2026-07-19';

async function seedEvent(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'events', op: 'upsert', payload: p }),
    payload,
  );
}

function eventCard(page: Page, title: string) {
  return page.locator('.event-timeline__card').filter({ hasText: title });
}

function nowLine(page: Page) {
  return page.locator('.event-timeline__now-line');
}

async function styleTopPct(locator: Locator): Promise<number> {
  const top = await locator.evaluate((el) => (el as HTMLElement).style.top);
  return parseFloat(top);
}

/** Same probe technique as habits-week-grid.spec.ts's resolveBackgroundToken. */
async function resolveCardColor(
  page: Page,
  cssVar: string,
  property: 'backgroundColor' | 'borderInlineStartColor',
): Promise<string> {
  return page.evaluate(
    ({ cssVar, property }) => {
      const probe = document.createElement('li');
      probe.className = 'event-timeline__card';
      probe.style[property] = `var(${cssVar})`;
      document.body.appendChild(probe);
      const color = getComputedStyle(probe)[property];
      probe.remove();
      return color;
    },
    { cssVar, property },
  );
}

function calendarStrip(page: Page) {
  return page.locator('.calendar-strip');
}

function calendarWeeks(page: Page) {
  return page.locator('.calendar-strip__weeks');
}

function dayButton(page: Page, ariaLabel: string) {
  return page.locator(`button[aria-label="${ariaLabel}"]`);
}

function dayDots(page: Page, ariaLabel: string) {
  return dayButton(page, ariaLabel).locator('.calendar-strip__dot');
}

/**
 * Drives the same Pointer Events CalendarStrip listens to (issue #556) —
 * dispatched directly on the gesture surface, same technique as tasks.spec.ts's
 * swipeRight/swipeLeft. Positive `deltaY` swipes down (opens the month),
 * negative swipes up (closes it back to the week).
 */
async function swipeVertical(locator: Locator, deltaY: number) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('swipeVertical: target has no bounding box');
  const clientX = box.x + box.width / 2;
  const startY = box.y + 10;

  await locator.dispatchEvent('pointerdown', {
    pointerId: 1,
    clientX,
    clientY: startY,
    button: 0,
    bubbles: true,
  });
  await locator.dispatchEvent('pointermove', {
    pointerId: 1,
    clientX,
    clientY: startY + deltaY,
    bubbles: true,
  });
  await locator.dispatchEvent('pointerup', {
    pointerId: 1,
    clientX,
    clientY: startY + deltaY,
    bubbles: true,
  });
}

/** Same probe technique as resolveCardColor, for an arbitrary background-color token. */
async function resolveToken(page: Page, cssVar: string): Promise<string> {
  return page.evaluate((cssVar) => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = `var(${cssVar})`;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }, cssVar);
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // The timeline must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  // Before the first navigation (helpers.ts doc) — registerPasskey below may itself navigate.
  await installClockAt(page);
  await registerPasskey(page);
  await page.goto('/kalender');
  await page.waitForFunction(() => typeof window.__starship?.mutate === 'function', null, {
    polling: 100,
  });
});

/* -------------------------------------------------------------------------- */
/* AC1: Stundenachse + Terminkarten zur richtigen Uhrzeit                     */
/* -------------------------------------------------------------------------- */

test('ein Termin am aktuellen Tag erscheint im richtigen Stundenband der Timeline, mit Titel (AC1)', async ({
  page,
}) => {
  await expect(page.getByText('00:00')).toBeVisible();
  await expect(page.getByText('23:00')).toBeVisible();

  await seedEvent(page, {
    title: 'Zahnarzt',
    allDay: false,
    startsAt: `${TODAY}T07:00:00.000Z`, // 09:00 Berlin
    endsAt: `${TODAY}T08:00:00.000Z`, // 10:00 Berlin
    startDate: null,
    endDate: null,
    category: null,
  });

  const card = eventCard(page, 'Zahnarzt');
  await expect(card).toBeVisible();
  await expect(card).toContainText('09:00');

  // 09:00 Berlin = 540 of 1440 minutes = 37.5% down the 0-24h axis.
  await expect.poll(() => styleTopPct(card)).toBeCloseTo(37.5, 1);
});

/* -------------------------------------------------------------------------- */
/* AC2: Jetzt-Linie                                                          */
/* -------------------------------------------------------------------------- */

test('die Jetzt-Linie sitzt korrekt kurz vor und kurz nach Mitternacht (AC2)', async ({ page }) => {
  // 23:59 Berlin = 21:59 UTC, still 2026-07-18.
  await skewClock(page, `${TODAY}T21:59:00.000Z`);
  await page.reload();
  await expect(nowLine(page)).toBeVisible();
  const lateTop = await styleTopPct(nowLine(page));
  expect(lateTop).toBeGreaterThan(95);

  // 00:01 Berlin the next day = 22:01 UTC on TODAY's date.
  await skewClock(page, `${TODAY}T22:01:00.000Z`);
  await page.reload();
  await expect(nowLine(page)).toBeVisible();
  const earlyTop = await styleTopPct(nowLine(page));
  expect(earlyTop).toBeLessThan(5);
});

test('die Jetzt-Linie rueckt mit der Zeit weiter, ohne dass die Seite neu laedt (AC2)', async ({
  page,
}) => {
  // beforeEach already loaded /kalender at installClockAt's default (14:00
  // Berlin) — far from the midnight edge, no reload needed for this one.
  // Reloading right before freezeClock/fastForward (like the two tests above
  // do) raced the fresh mount's setInterval registration against the fake
  // clock in this specific combination and never fired it — plain continued
  // ticking from the original navigation, proven by journal-lock.spec.ts's
  // auto-lock tests, avoids that.
  const initialTop = await styleTopPct(nowLine(page));

  await freezeClock(page);
  await page.clock.fastForward(90_000);

  await expect.poll(() => styleTopPct(nowLine(page))).toBeGreaterThan(initialTop);
});

test('bei reduzierter Bewegung bewegt sich die Jetzt-Linie ohne Uebergang (AC2, Motion)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();

  const transitionDuration = await nowLine(page).evaluate(
    (el) => getComputedStyle(el).transitionDuration,
  );
  for (const duration of transitionDuration.split(',')) {
    expect(parseFloat(duration)).toBeLessThan(0.001);
  }
});

/* -------------------------------------------------------------------------- */
/* AC3: Kategorie-Farbkante                                                  */
/* -------------------------------------------------------------------------- */

test('eine Terminkarte mit Kategorie traegt die Kategorie-Farbe als Kante, die Flaeche bleibt --surface (AC3)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Teammeeting',
    allDay: false,
    startsAt: `${TODAY}T09:00:00.000Z`,
    endsAt: `${TODAY}T10:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: 'arbeit',
  });

  const card = eventCard(page, 'Teammeeting');
  await expect(card).toBeVisible();

  const expectedEdge = await resolveCardColor(page, '--cat-arbeit', 'borderInlineStartColor');
  const expectedSurface = await resolveCardColor(page, '--surface', 'backgroundColor');
  await expect
    .poll(() => card.evaluate((el) => getComputedStyle(el).borderInlineStartColor))
    .toBe(expectedEdge);
  expect(await card.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(expectedSurface);
});

test('eine Terminkarte ohne Kategorie traegt die Bereichsfarbe (--area-events) als Kante — auch im Dark Mode (AC3)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Spontanes',
    allDay: false,
    startsAt: `${TODAY}T11:00:00.000Z`,
    endsAt: `${TODAY}T12:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });

  const card = eventCard(page, 'Spontanes');
  await expect(card).toBeVisible();

  const expectedLight = await resolveCardColor(page, '--area-events', 'borderInlineStartColor');
  await expect
    .poll(() => card.evaluate((el) => getComputedStyle(el).borderInlineStartColor))
    .toBe(expectedLight);

  await page.emulateMedia({ colorScheme: 'dark' });
  const expectedDark = await resolveCardColor(page, '--area-events', 'borderInlineStartColor');
  await expect
    .poll(() => card.evaluate((el) => getComputedStyle(el).borderInlineStartColor))
    .toBe(expectedDark);
  expect(expectedDark).not.toBe(expectedLight);
});

/* -------------------------------------------------------------------------- */
/* AC4: Wochenstreifen blaettert                                             */
/* -------------------------------------------------------------------------- */

test('der Wochenstreifen blaettert zum naechsten/vorherigen Tag, die Timeline wechselt entsprechend (AC4)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Heute-Termin',
    allDay: false,
    startsAt: `${TODAY}T09:00:00.000Z`,
    endsAt: `${TODAY}T10:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });
  await seedEvent(page, {
    title: 'Morgen-Termin',
    allDay: false,
    startsAt: `${TOMORROW}T09:00:00.000Z`,
    endsAt: `${TOMORROW}T10:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });

  await expect(eventCard(page, 'Heute-Termin')).toBeVisible();
  await expect(eventCard(page, 'Morgen-Termin')).toHaveCount(0);

  await page.getByRole('button', { name: 'Nächster Tag' }).click();
  await expect(eventCard(page, 'Morgen-Termin')).toBeVisible();
  await expect(eventCard(page, 'Heute-Termin')).toHaveCount(0);

  await page.getByRole('button', { name: 'Vorheriger Tag' }).click();
  await expect(eventCard(page, 'Heute-Termin')).toBeVisible();
  await expect(eventCard(page, 'Morgen-Termin')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* S5 (#556): aufklappender Monat — Wischgeste, Punkte, reduced-motion        */
/* -------------------------------------------------------------------------- */

test('ein Abwaerts-Wisch am zugeklappten Wochenstreifen zieht ihn zum vollen Monat auf (S5 AC1)', async ({
  page,
}) => {
  const strip = calendarStrip(page);
  await expect(strip).toHaveAttribute('data-expanded', 'false');

  // 2026-07-22 (Mittwoch) liegt in der Folgewoche, außerhalb der um TODAY
  // selektierten Woche (13.–19.) — im zugeklappten Zustand nicht sichtbar.
  const outsideDay = dayButton(page, 'Mi, 22.');
  await expect(outsideDay).not.toBeVisible();

  await swipeVertical(calendarWeeks(page), 80);

  await expect(strip).toHaveAttribute('data-expanded', 'true');
  await expect(outsideDay).toBeVisible();
});

test('ein Aufwaerts-Wisch am aufgezogenen Monat zieht ihn zum Wochenstreifen zusammen (S5 AC2)', async ({
  page,
}) => {
  const strip = calendarStrip(page);
  await swipeVertical(calendarWeeks(page), 80);
  await expect(strip).toHaveAttribute('data-expanded', 'true');

  await swipeVertical(calendarWeeks(page), -80);
  await expect(strip).toHaveAttribute('data-expanded', 'false');
});

test('Antippen eines Tages im aufgezogenen Monat waehlt ihn und zieht den Streifen zusammen (S5 AC2)', async ({
  page,
}) => {
  const strip = calendarStrip(page);
  await swipeVertical(calendarWeeks(page), 80);
  await expect(strip).toHaveAttribute('data-expanded', 'true');

  const outsideDay = dayButton(page, 'Mi, 22.');
  await outsideDay.click();

  await expect(strip).toHaveAttribute('data-expanded', 'false');
  await expect(outsideDay).toHaveAttribute('aria-pressed', 'true');
  await expect(outsideDay).toBeVisible();
});

test('Tage mit Terminen verschiedener Kategorien zeigen die passenden Punkte, Tage ohne Termin keinen (S5 AC3)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Arbeit-Termin',
    allDay: false,
    startsAt: `${TODAY}T09:00:00.000Z`,
    endsAt: `${TODAY}T10:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: 'arbeit',
  });
  await seedEvent(page, {
    title: 'Sport-Termin',
    allDay: false,
    startsAt: `${TOMORROW}T09:00:00.000Z`,
    endsAt: `${TOMORROW}T10:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: 'sport',
  });

  const todayDots = dayDots(page, 'Sa, 18.');
  await expect(todayDots).toHaveCount(1);
  const expectedArbeit = await resolveToken(page, '--cat-arbeit');
  await expect
    .poll(() => todayDots.first().evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(expectedArbeit);

  const tomorrowDots = dayDots(page, 'So, 19.');
  await expect(tomorrowDots).toHaveCount(1);
  const expectedSport = await resolveToken(page, '--cat-sport');
  await expect
    .poll(() => tomorrowDots.first().evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(expectedSport);

  // 2026-07-13 (Montag) liegt in der gleichen, immer sichtbaren Woche und hat keinen Termin.
  await expect(dayDots(page, 'Mo, 13.')).toHaveCount(0);
});

test('der Kategorie-Punkt kommt aus dem semantischen Token, mit eigenem Wert im Dark Mode (S5 AC3, Dark Mode)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Arbeit-Termin',
    allDay: false,
    startsAt: `${TODAY}T09:00:00.000Z`,
    endsAt: `${TODAY}T10:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: 'arbeit',
  });

  const dot = dayDots(page, 'Sa, 18.').first();
  const expectedLight = await resolveToken(page, '--cat-arbeit');
  await expect.poll(() => dot.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(expectedLight);

  await page.emulateMedia({ colorScheme: 'dark' });
  const expectedDark = await resolveToken(page, '--cat-arbeit');
  await expect.poll(() => dot.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(expectedDark);
  expect(expectedDark).not.toBe(expectedLight);
});

test('der Heute-Button springt auf den heutigen Tag zurueck, auch aus einem anderen Monat navigiert (S5 AC4)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Heute-Termin',
    allDay: false,
    startsAt: `${TODAY}T09:00:00.000Z`,
    endsAt: `${TODAY}T10:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });

  await expect(page.getByRole('button', { name: 'Heute' })).toHaveCount(0);

  const nextDay = page.getByRole('button', { name: 'Nächster Tag' });
  for (let i = 0; i < 20; i += 1) {
    await nextDay.click();
  }
  await expect(eventCard(page, 'Heute-Termin')).toHaveCount(0);

  const todayButton = page.getByRole('button', { name: 'Heute' });
  await expect(todayButton).toBeVisible();
  await todayButton.click();

  await expect(eventCard(page, 'Heute-Termin')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Heute' })).toHaveCount(0);
});

test('bei reduzierter Bewegung klappt der Monat ohne Uebergang direkt auf und zu (S5 AC5, Motion)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await page.waitForFunction(() => typeof window.__starship?.mutate === 'function', null, {
    polling: 100,
  });

  const weekRow = page.locator('.calendar-strip__week-row').first();
  const transitionDuration = await weekRow.evaluate((el) => getComputedStyle(el).transitionDuration);
  for (const duration of transitionDuration.split(',')) {
    expect(parseFloat(duration)).toBeLessThan(0.001);
  }

  const strip = calendarStrip(page);
  await swipeVertical(calendarWeeks(page), 80);
  await expect(strip).toHaveAttribute('data-expanded', 'true');

  await swipeVertical(calendarWeeks(page), -80);
  await expect(strip).toHaveAttribute('data-expanded', 'false');
});

test('Kategorie-Punkte kommen aus IndexedDB, auch nach einem Reload ohne Netzwerk (S5, Offline-Pfad)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Nach-Reload',
    allDay: false,
    startsAt: `${TODAY}T09:00:00.000Z`,
    endsAt: `${TODAY}T10:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: 'gesundheit',
  });

  await page.reload();
  await page.waitForFunction(() => typeof window.__starship?.mutate === 'function', null, {
    polling: 100,
  });

  await expect(dayDots(page, 'Sa, 18.')).toHaveCount(1);
});
