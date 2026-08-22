import { expect, test, type Locator, type Page } from '@playwright/test';
import { addDays, dateKeyDiff } from '@/features/events/event-time';
import { installClockAt, registerPasskey, resetAppData, skewClock, withDb } from './helpers';

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
  return page.locator('.event-agenda__item').filter({ hasText: title });
}

function allDayBar(page: Page, title: string) {
  return page.locator('.event-agenda__all-day-button').filter({ hasText: title });
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
      probe.className = 'event-agenda__item';
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

/** The carousel track calendar-strip.tsx's continuous, buffered scrolling lives on (issue #813). */
function calendarWeeks(page: Page) {
  return page.locator('.calendar-strip__carousel');
}

/** The date key the strip's leading (topmost/leftmost visible) cell/row is
 *  currently on — a day in week view, a week's Monday in month view
 *  (calendar-strip.tsx's `data-anchor-day`, issue #813). Drives the title and
 *  is the most direct way to assert "rolled by exactly N days/weeks" without
 *  depending on implementation-internal scroll pixels. */
function anchorDay(page: Page) {
  return calendarStrip(page).getAttribute('data-anchor-day');
}

/**
 * A day button *inside the interactive band* — scoping to `:not([inert])`
 * matters because the buffered carousel (issue #813) keeps every day/week in
 * the DOM well beyond what's currently scrolled into view (so a swipe never
 * runs out of days to reach); off-screen cells stay in the document but are
 * marked `inert` (and `aria-hidden`), exactly the days this locator excludes.
 */
function dayButton(page: Page, ariaLabel: string) {
  return page.locator(`.calendar-strip__day[aria-label="${ariaLabel}"]:not([inert])`);
}

function dayDots(page: Page, ariaLabel: string) {
  return dayButton(page, ariaLabel).locator('.calendar-strip__dot');
}

/**
 * One row's/cell's own pixel size — a day-cell's width in week view, a
 * week-row's height in month view — measured off an actually rendered cell
 * (`calendar-strip.tsx`'s own `stepFor`, mirrored here) rather than dividing
 * the track's `clientWidth`/`clientHeight` by 7/6. The track's `height`
 * transitions on the Woche/Monat switch (calendar-strip.css), so right after
 * that toggle `clientHeight` can read a mid-transition value for the whole
 * 240ms `--duration-spring-smooth` window — dividing that by 6 produced a
 * flaky per-unit step (issue #813 AK5's multi-row test saw anywhere from 0 to
 * 3 rows' worth of movement depending on how far the transition had gotten).
 * A cell's/row's own size never transitions, only the track's does.
 */
async function trackUnitPx(page: Page): Promise<number> {
  const track = calendarWeeks(page);
  return track.evaluate((el) => {
    const expanded = el.getAttribute('data-expanded') === 'true';
    const sample = el.querySelector<HTMLElement>(
      expanded ? '.calendar-strip__week-row' : '.calendar-strip__cell',
    );
    if (sample) {
      const rect = sample.getBoundingClientRect();
      return expanded ? rect.height : rect.width;
    }
    return expanded ? el.clientHeight / 6 : el.clientWidth / 7;
  });
}

/**
 * Scrolls the calendar-strip carousel by exactly one screen's worth — a week
 * in week view (7 day-columns), a month's worth of rows in month view (6
 * week-rows) — the settle-driven equivalent of a full native swipe-and-release.
 * `dir` `1` advances (a left/up swipe), `-1` goes back (a right/down swipe).
 * Axis-aware: week view scrolls horizontally, month view vertically (issue
 * #813, the second half of this ticket — month view used to share the
 * horizontal axis with week view).
 *
 * Scrolling the track directly, rather than dispatching touch events, is
 * deliberate: the `mobile` project (playwright.config.ts) uses `Desktop
 * Chrome` with a narrow viewport, not a real touch device profile, so it has
 * no `hasTouch` — `page.touchscreen` isn't usable here, and a JS-dispatched
 * `TouchEvent` (tasks.spec.ts's `touchMoveWasBlocked` pattern) never reaches
 * the compositor, so it can't drive real scroll-snap physics either. Setting
 * `scrollLeft`/`scrollTop` is what's actually left to exercise the scroll
 * handler end-to-end; the browser's own snap-and-momentum behaviour is native
 * platform code, not this component's to test.
 */
async function pageStrip(page: Page, dir: 1 | -1): Promise<void> {
  const track = calendarWeeks(page);
  const before = await anchorDay(page);
  const unit = await trackUnitPx(page);
  await track.evaluate(
    (el, { dir, unit }) => {
      const expanded = el.getAttribute('data-expanded') === 'true';
      const delta = dir * (expanded ? 6 : 7) * unit;
      if (expanded) el.scrollTop += delta;
      else el.scrollLeft += delta;
    },
    { dir, unit },
  );
  // A silent buffer rebuild lands asynchronously (a scroll-driven state
  // update) — waiting for the anchor to actually change is proof the strip
  // rolled instead of stopping half-way.
  await expect.poll(() => anchorDay(page)).not.toBe(before);
}

/** Pages the carousel forward `times` times in a row (issue #628 AK1's month-boundary test). */
async function pageStripForward(page: Page, times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await pageStrip(page, 1);
  }
}

/**
 * Taps a day button in the strip, pulling the month open first via the
 * Woche/Monat-Umschalter if that day isn't currently in the interactive band
 * (`dayButton`'s `:not([inert])` scope reports it as not visible then, issue
 * #813) — the tap itself collapses the strip back (issue #629, replaces
 * stepping there via the "Nächster/Vorheriger Tag" buttons).
 */
async function selectStripDay(page: Page, ariaLabel: string): Promise<void> {
  const button = dayButton(page, ariaLabel);
  if (!(await button.isVisible())) {
    await page.getByRole('radio', { name: 'Monat' }).click();
  }
  await button.click();
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
/* AC1: chronologische Agenda-Liste, voll sichtbar (issue #597)               */
/* -------------------------------------------------------------------------- */

test('Termine am aktuellen Tag erscheinen als chronologische Liste, mit Titel und voller Uhrzeit (AC1, AK1, AK2)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Nachmittagstermin',
    allDay: false,
    startsAt: `${TODAY}T12:00:00.000Z`, // 14:00 Berlin
    endsAt: `${TODAY}T13:00:00.000Z`, // 15:00 Berlin
    startDate: null,
    endDate: null,
    category: null,
  });
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
  await expect(card).toContainText('09:00–10:00');

  // Chronological order in the DOM, not insertion order (AK1).
  const titles = await page.locator('.event-agenda__item').allTextContents();
  expect(titles[0]).toContain('Zahnarzt');
  expect(titles[1]).toContain('Nachmittagstermin');
});

/* -------------------------------------------------------------------------- */
/* issue #644: Offline-Notiz                                                  */
/* -------------------------------------------------------------------------- */

test('der Kalender bleibt offline sichtbar, mit einer ruhigen Notiz statt eines Fehlers (issue #644 AC1)', async ({
  page,
  context,
}) => {
  await seedEvent(page, {
    title: 'Bleibt da',
    allDay: false,
    startsAt: `${TODAY}T09:00:00.000Z`,
    endsAt: `${TODAY}T10:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });
  await expect(eventCard(page, 'Bleibt da')).toBeVisible();

  await context.setOffline(true);

  // A calm status note, not a red alert — nothing here uses role="alert".
  await expect(page.getByRole('status')).toContainText('Offline');
  await expect(eventCard(page, 'Bleibt da')).toBeVisible();

  await context.setOffline(false);
});

test('die Offline-Notiz im Kalender verschwindet nach dem Onlinegehen wieder, ohne Neuladen (issue #644 AC2)', async ({
  page,
  context,
}) => {
  await context.setOffline(true);
  await expect(page.getByRole('status')).toContainText('Offline');

  await context.setOffline(false);

  await expect(page.getByRole('status')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* AK1-3 (Issue #638): "Danach nichts mehr geplant." ist kein Zustand mehr    */
/* -------------------------------------------------------------------------- */

test('nach dem letzten Termin des Tages erscheint keine "Danach nichts mehr geplant."-Meldung (AK1)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Einziger Termin',
    allDay: false,
    startsAt: `${TODAY}T09:00:00.000Z`,
    endsAt: `${TODAY}T10:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });

  await expect(eventCard(page, 'Einziger Termin')).toBeVisible();
  await expect(page.locator('.event-agenda__sparse')).toHaveCount(0);
  await expect(page.getByText('Danach nichts mehr geplant.')).toHaveCount(0);
});

test('an einem Tag mit mehreren Terminen erscheint ebenfalls keine "Danach nichts mehr geplant."-Meldung (AK2)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Erster Termin',
    allDay: false,
    startsAt: `${TODAY}T09:00:00.000Z`,
    endsAt: `${TODAY}T10:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });
  await seedEvent(page, {
    title: 'Zweiter Termin',
    allDay: false,
    startsAt: `${TODAY}T11:00:00.000Z`,
    endsAt: `${TODAY}T12:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });

  await expect(eventCard(page, 'Erster Termin')).toBeVisible();
  await expect(eventCard(page, 'Zweiter Termin')).toBeVisible();
  await expect(page.locator('.event-agenda__sparse')).toHaveCount(0);
});

test('ein komplett leerer Tag zeigt den Leerzustand, keine Terminkarten (AK3)', async ({ page }) => {
  await expect(page.locator('.event-agenda__empty')).toHaveText('Keine Termine an diesem Tag.');
  await expect(page.locator('.event-agenda__item')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* AK4: Fokus auf den naechsten anstehenden Termin beim Oeffnen               */
/* -------------------------------------------------------------------------- */

test('am aktuellen Tag steht der naechste noch nicht beendete Termin im Blick, ein bereits beendeter nicht (AK4a)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Schon vorbei',
    allDay: false,
    startsAt: `${TODAY}T07:00:00.000Z`, // 09:00-10:00 Berlin, endet vor der geskripteten Uhrzeit (14:00 Berlin)
    endsAt: `${TODAY}T08:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });
  await seedEvent(page, {
    title: 'Noch bevorstehend',
    allDay: false,
    startsAt: `${TODAY}T14:00:00.000Z`, // 16:00-17:00 Berlin, liegt noch vor uns
    endsAt: `${TODAY}T15:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });
  await page.reload();
  await page.waitForFunction(() => typeof window.__starship?.mutate === 'function', null, {
    polling: 100,
  });

  const upcoming = eventCard(page, 'Noch bevorstehend');
  await expect(upcoming).toHaveAttribute('data-upcoming', 'true');
  await expect(eventCard(page, 'Schon vorbei')).toHaveAttribute('data-upcoming', 'false');

  const box = await upcoming.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeLessThan(812);
});

test('an einem anderen Tag als heute steht der erste Termin des Tages im Blick (AK4b)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Morgen zuerst',
    allDay: false,
    startsAt: `${TOMORROW}T07:00:00.000Z`,
    endsAt: `${TOMORROW}T08:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });
  await seedEvent(page, {
    title: 'Morgen danach',
    allDay: false,
    startsAt: `${TOMORROW}T14:00:00.000Z`,
    endsAt: `${TOMORROW}T15:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });

  await selectStripDay(page, 'So, 19.');

  await expect(eventCard(page, 'Morgen zuerst')).toHaveAttribute('data-upcoming', 'true');
  await expect(eventCard(page, 'Morgen danach')).toHaveAttribute('data-upcoming', 'false');
});

/* -------------------------------------------------------------------------- */
/* AK5: Kennzeichnung ueberlappender Termine                                  */
/* -------------------------------------------------------------------------- */

test('zwei zeitlich ueberlappende Termine tragen beide die Ueberschneidungs-Kennzeichnung (AK5a)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Ueberlappend A',
    allDay: false,
    startsAt: `${TODAY}T09:00:00.000Z`,
    endsAt: `${TODAY}T10:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });
  await seedEvent(page, {
    title: 'Ueberlappend B',
    allDay: false,
    startsAt: `${TODAY}T09:30:00.000Z`,
    endsAt: `${TODAY}T10:30:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });

  await expect(eventCard(page, 'Ueberlappend A')).toHaveAttribute('data-overlap', 'true');
  await expect(eventCard(page, 'Ueberlappend B')).toHaveAttribute('data-overlap', 'true');
  await expect(page.getByText('Überschneidung')).toHaveCount(2);
});

test('zwei zeitlich getrennte Termine tragen keine Ueberschneidungs-Kennzeichnung (AK5b)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Getrennt A',
    allDay: false,
    startsAt: `${TODAY}T09:00:00.000Z`,
    endsAt: `${TODAY}T10:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });
  await seedEvent(page, {
    title: 'Getrennt B',
    allDay: false,
    startsAt: `${TODAY}T11:00:00.000Z`,
    endsAt: `${TODAY}T12:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });

  await expect(eventCard(page, 'Getrennt A')).toHaveAttribute('data-overlap', 'false');
  await expect(eventCard(page, 'Getrennt B')).toHaveAttribute('data-overlap', 'false');
  await expect(page.getByText('Überschneidung')).toHaveCount(0);
});

test('der alte Text "überschneidet sich" kommt in der Agenda nirgends mehr vor (issue #657 AK3)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Ueberlappend A',
    allDay: false,
    startsAt: `${TODAY}T09:00:00.000Z`,
    endsAt: `${TODAY}T10:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });
  await seedEvent(page, {
    title: 'Ueberlappend B',
    allDay: false,
    startsAt: `${TODAY}T09:30:00.000Z`,
    endsAt: `${TODAY}T10:30:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });

  await expect(eventCard(page, 'Ueberlappend A')).toHaveAttribute('data-overlap', 'true');
  await expect(page.getByText('überschneidet sich')).toHaveCount(0);
});

test('das Ueberschneidungs-Label steht in der Uhrzeit-Zeile, rechts von der Uhrzeit, der Titel bleibt darunter (issue #657 AK4)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Ueberlappend A',
    allDay: false,
    startsAt: `${TODAY}T09:00:00.000Z`,
    endsAt: `${TODAY}T10:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });
  await seedEvent(page, {
    title: 'Ueberlappend B',
    allDay: false,
    startsAt: `${TODAY}T09:30:00.000Z`,
    endsAt: `${TODAY}T10:30:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });

  const card = eventCard(page, 'Ueberlappend A');
  // Erst messen, wenn die Enter-Animation vorbei ist — sonst steckt ihr
  // Transform mit in der BoundingBox (Fallen-Hinweis im Ticket).
  await expect(card).toHaveAttribute('data-entering', 'false');

  const timeBox = await card.locator('.event-agenda__item-time').boundingBox();
  const labelBox = await card.locator('.event-agenda__overlap-note').boundingBox();
  const titleBox = await card.locator('.event-agenda__item-title').boundingBox();
  if (!timeBox || !labelBox || !titleBox) throw new Error('AK4: Karte hat keine BoundingBox');

  const timeCenterY = timeBox.y + timeBox.height / 2;
  const labelCenterY = labelBox.y + labelBox.height / 2;
  expect(Math.abs(timeCenterY - labelCenterY)).toBeLessThanOrEqual(2);
  expect(labelBox.x).toBeGreaterThanOrEqual(timeBox.x + timeBox.width);
  expect(titleBox.y).toBeGreaterThanOrEqual(timeBox.y + timeBox.height);
});

test('bei langem Titel bleibt die ueberlappende Karte innerhalb der Bildschirmbreite, iPhone 12 mini (issue #657 AK5)', async ({
  page,
}) => {
  const longTitle = 'Ein sehr sehr langer Terminname der eigentlich nicht in eine Zeile passen sollte';
  await seedEvent(page, {
    title: longTitle,
    allDay: false,
    startsAt: `${TODAY}T09:00:00.000Z`,
    endsAt: `${TODAY}T10:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });
  await seedEvent(page, {
    title: 'Ueberlappend B',
    allDay: false,
    startsAt: `${TODAY}T09:30:00.000Z`,
    endsAt: `${TODAY}T10:30:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });

  const card = eventCard(page, longTitle);
  await expect(card).toHaveAttribute('data-overlap', 'true');
  await expect(card).toHaveAttribute('data-entering', 'false');

  const viewport = page.viewportSize();
  const cardBox = await card.boundingBox();
  if (!viewport || !cardBox) throw new Error('AK5: kein Viewport oder keine BoundingBox');
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(viewport.width);

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);
});

/* -------------------------------------------------------------------------- */
/* AK7: mit der spaerlich-Meldung (Issue #638) ist auch ihre Trennlinie weg   */
/* -------------------------------------------------------------------------- */

test('die Trennlinie vor der ehemaligen spaerlich-Meldung existiert nicht mehr (AK7, Issue #638)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Fuer die Trennlinie',
    allDay: false,
    startsAt: `${TODAY}T09:00:00.000Z`,
    endsAt: `${TODAY}T10:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });

  await expect(eventCard(page, 'Fuer die Trennlinie')).toBeVisible();
  await expect(page.locator('.event-agenda__sparse')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* AK9: prefers-reduced-motion                                                */
/* -------------------------------------------------------------------------- */

test('bei reduzierter Bewegung erscheint ein neuer Termin ohne Bewegungs-Uebergang (AK9, Motion)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });

  // A baseline item first establishes the list as non-empty (use-list-presence.ts:
  // the first-ever snapshot always seeds as 'present', never 'entering', so a
  // page that starts genuinely empty can't prove the enter animation) — same
  // two-step pattern list-motion.spec.ts uses for tasks/habits.
  await seedEvent(page, {
    title: 'Bestehender Termin',
    allDay: false,
    startsAt: `${TODAY}T07:00:00.000Z`,
    endsAt: `${TODAY}T08:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });
  await expect(eventCard(page, 'Bestehender Termin')).toHaveAttribute('data-entering', 'false');

  await seedEvent(page, {
    title: 'Reduzierte Bewegung',
    allDay: false,
    startsAt: `${TODAY}T09:00:00.000Z`,
    endsAt: `${TODAY}T10:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });

  const card = eventCard(page, 'Reduzierte Bewegung');
  await expect(card).toHaveAttribute('data-entering', 'true');
  const duration = await card.evaluate((el) => getComputedStyle(el).animationDuration);
  for (const d of duration.split(',')) {
    expect(parseFloat(d)).toBeLessThan(0.001);
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

  await selectStripDay(page, 'So, 19.');
  await expect(eventCard(page, 'Morgen-Termin')).toBeVisible();
  await expect(eventCard(page, 'Heute-Termin')).toHaveCount(0);

  await selectStripDay(page, 'Sa, 18.');
  await expect(eventCard(page, 'Heute-Termin')).toBeVisible();
  await expect(eventCard(page, 'Morgen-Termin')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* issue #805 (Ansatz C): Galerie-Paging statt Scrub — natives scroll-snap    */
/* ersetzt #629/#662/#764/#802's Pointer-Scrub                                */
/* -------------------------------------------------------------------------- */

test('Rollen bewegt nur die Vorschau — hin und zurueck zeigt die Auswahl unveraendert (issue #784 AK1, #813)', async ({
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
  await expect(eventCard(page, 'Heute-Termin')).toBeVisible();

  await pageStrip(page, 1);
  // Die Vorschau ist eine Woche weiter, die Auswahl (18.) faellt aus dem
  // sichtbaren Fenster — der Tag existiert weiter (die Auswahl selbst
  // aendert sich nie durchs Rollen), ist aber inert und damit ausserhalb der
  // dayButton-Scope (issue #813). Die Agenda darunter bleibt unberuehrt.
  await expect(dayButton(page, 'Sa, 18.')).toHaveCount(0);
  await expect(eventCard(page, 'Heute-Termin')).toBeVisible();

  await pageStrip(page, -1);
  await expect(dayButton(page, 'Sa, 18.')).toHaveAttribute('aria-pressed', 'true');
  await expect(eventCard(page, 'Heute-Termin')).toBeVisible();
});

test('ein Wisch rollt das Fenster tageweise — kein Sprung auf eine ganze Woche (issue #813, AK1/AK5)', async ({
  page,
}) => {
  const track = calendarWeeks(page);
  const before = await anchorDay(page);
  expect(before).toBe(TODAY);

  // Drei Tage, keine ganze Woche — der Anker darf trotzdem sofort mitgehen.
  await track.evaluate((el) => {
    el.scrollLeft += (el.clientWidth / 7) * 3;
  });
  await expect.poll(() => anchorDay(page)).toBe(addDays(TODAY, 3));
});

test('zwei aufeinanderfolgende Wische rollen zwei Wochen weiter, nicht nur eine (issue #813)', async ({
  page,
}) => {
  const title = calendarStrip(page).locator('.calendar-strip__title');

  await pageStrip(page, 1);
  await pageStrip(page, 1);

  // 18.07. + 14 Tage = 01.08. — der zweite Wisch darf nicht wirkungslos
  // bleiben, nur weil der Puffer zwischendurch unsichtbar neu verankert wurde.
  await expect(dayButton(page, 'Sa, 1.')).toBeVisible();
  await expect(title).toHaveText('August 2026');
});

test('der Streifen erfasst nur waagerechte Gesten, senkrecht bleibt dem Seiten-Scroll ueberlassen (issue #813, ersetzt S5 AK-A)', async ({
  page,
}) => {
  await expect(calendarWeeks(page)).toHaveCSS('touch-action', 'pan-x');
});

test('ein gerolltes Fenster bleibt stehen, kein Zurueckschnappen zur alten Auswahl (issue #784, AK3)', async ({
  page,
}) => {
  await pageStrip(page, 1);

  await expect(dayButton(page, 'Sa, 25.')).toBeVisible();
  await expect(dayButton(page, 'Sa, 18.')).toHaveCount(0);
  await expect(anchorDay(page)).resolves.toBe('2026-07-25');
});

test('eine Auswahl ausserhalb des Fensters ist ein sauberer Zustand — Tages-Pfeile arbeiten weiter darauf (issue #784, AK5)', async ({
  page,
}) => {
  await pageStrip(page, 1);
  await expect(dayButton(page, 'Sa, 18.')).toHaveCount(0);

  await page.getByRole('button', { name: 'Nächster Tag' }).click();

  // Der Pfeil setzt Auswahl UND Anker neu — der Tag nach der (unsichtbaren)
  // Auswahl ist sofort wieder sichtbar und ausgewaehlt, kein zweiter Schritt noetig.
  await expect(dayButton(page, 'So, 19.')).toHaveAttribute('aria-pressed', 'true');
});

test('der Heute-Knopf setzt Auswahl und Anker zurueck, auch nach einem Wisch ins Leere (issue #784, AK6)', async ({
  page,
}) => {
  await pageStrip(page, 1);
  const todayChip = page.getByRole('button', { name: 'Heute' });
  // Die Auswahl steht immer noch auf heute, nur das Fenster zeigt es nicht
  // mehr — der Knopf ist deshalb aktiv, nicht entfernt (AK6).
  await expect(todayChip).toBeVisible();
  await expect(todayChip).toBeEnabled();

  await todayChip.click();

  await expect(page.getByRole('button', { name: 'Heute' })).toHaveCount(0);
  await expect(dayButton(page, 'Sa, 18.')).toHaveAttribute('aria-pressed', 'true');
});

test('nur die sichtbaren Tage der Woche sind interaktiv, der Puffer bleibt inert und fuer Screenreader verborgen (issue #813)', async ({
  page,
}) => {
  const interactive = page.locator('.calendar-strip__day:not([inert])');
  await expect(interactive).toHaveCount(7);
  await expect(dayButton(page, 'Sa, 18.')).toBeVisible();

  // Eine Woche voraus liegt bereits im (unsichtbaren) Puffer, nicht mehr im
  // sichtbaren Fenster.
  const buffered = page.locator('.calendar-strip__day[aria-label="Sa, 25."]');
  await expect(buffered).toHaveCount(1);
  await expect(buffered).toHaveJSProperty('inert', true);
  await expect(buffered).toHaveAttribute('aria-hidden', 'true');
});

test('ein einzelner, ununterbrochener Wisch weit ueber den Rand landet trotzdem exakt richtig, der Puffer rueckt erst danach nach (issue #820)', async ({
  page,
}) => {
  const track = calendarWeeks(page);
  const firstCell = track.locator('.calendar-strip__cell').first().locator('.calendar-strip__day');
  const firstDayBefore = await firstCell.getAttribute('aria-label');
  const unit = await trackUnitPx(page);

  // 12 Tage in einem Zug (statt zwei einzeln gewischten Wochen wie oben) —
  // deutlich ueber MARGIN_DAYS (10) hinaus, aber noch innerhalb des Puffers
  // (RADIUS_DAYS 21), damit die Fuehrungszelle sofort korrekt mitgeht.
  await track.evaluate((el, unit) => {
    el.scrollLeft += unit * 12;
  }, unit);

  await expect.poll(() => anchorDay(page)).toBe(addDays(TODAY, 12));
  await expect(dayButton(page, 'Do, 30.')).toBeVisible();

  // Der Nachbau selbst (neue Fuehrungszelle am linken Pufferrand) darf
  // trotzdem stattfinden — nur eben erst nach dem Scroll-Ende, nicht schon
  // waehrend des Wischs (issue #820).
  await expect.poll(() => firstCell.getAttribute('aria-label')).not.toBe(firstDayBefore);
});

/* -------------------------------------------------------------------------- */
/* issue #813: Monat rollt jetzt senkrecht, wochenweise (kehrt #805 um)       */
/* -------------------------------------------------------------------------- */

test('im Monat rollt ein Wisch einzelne Wochen, kein Sprung auf einen ganzen Monat (issue #813, kehrt #805 um)', async ({
  page,
}) => {
  const strip = calendarStrip(page);
  await page.getByRole('radio', { name: 'Monat' }).click();
  await expect(strip).toHaveAttribute('data-expanded', 'true');
  const before = await anchorDay(page);
  expect(before).toBe('2026-07-13'); // Montag der Woche des 18.07.

  const track = calendarWeeks(page);
  const unit = await trackUnitPx(page);
  await track.evaluate(
    (el, unit) => {
      el.scrollTop += unit; // genau eine Wochenzeile
    },
    unit,
  );

  await expect.poll(() => anchorDay(page)).toBe(addDays(before as string, 7));
});

test('ein weiter Wisch im Monat rollt mehrere Wochen weiter, nicht auf einen Monatssprung begrenzt (issue #813)', async ({
  page,
}) => {
  const strip = calendarStrip(page);
  await page.getByRole('radio', { name: 'Monat' }).click();
  const before = await anchorDay(page);

  const track = calendarWeeks(page);
  const unit = await trackUnitPx(page);
  await track.evaluate(
    (el, unit) => {
      el.scrollTop += unit * 3; // drei Wochenzeilen
    },
    unit,
  );

  await expect.poll(() => anchorDay(page)).toBe(addDays(before as string, 21));
  await expect(strip).toHaveAttribute('data-expanded', 'true');
});

test('im Monat zeigt ein Wisch zurueck die Auswahl wieder, ein Wisch vor bewegt nur die Vorschau (issue #784 AK1, #813)', async ({
  page,
}) => {
  await page.getByRole('radio', { name: 'Monat' }).click();

  await pageStrip(page, 1);
  await expect(dayButton(page, 'Sa, 18.')).toHaveCount(0);

  await pageStrip(page, -1);
  await expect(dayButton(page, 'Sa, 18.')).toHaveAttribute('aria-pressed', 'true');
});

test('der Streifen erfasst im Monat nur senkrechte Gesten, waagerecht bleibt dem Seiten-Scroll ueberlassen (issue #813, ersetzt #764)', async ({
  page,
}) => {
  await page.getByRole('radio', { name: 'Monat' }).click();
  const track = calendarWeeks(page);
  await expect(track).toHaveCSS('touch-action', 'pan-y');

  // overflow-x: hidden im Monat — ein waagerechter Scrollversuch bleibt wirkungslos.
  await track.evaluate((el) => {
    el.scrollLeft = 1000;
  });
  await expect(track.evaluate((el) => el.scrollLeft)).resolves.toBe(0);
});

test('im Monat landet ein einzelner, ununterbrochener Wisch ueber mehrere Randdurchgaenge hinweg trotzdem exakt richtig (issue #820)', async ({
  page,
}) => {
  await page.getByRole('radio', { name: 'Monat' }).click();
  const before = await anchorDay(page);

  const track = calendarWeeks(page);
  const firstRow = track.locator('.calendar-strip__week-row').first().locator('.calendar-strip__day').first();
  const firstDayBefore = await firstRow.getAttribute('aria-label');
  const unit = await trackUnitPx(page);

  // Sechs Wochenzeilen in einem Zug — deutlich ueber MARGIN_WEEKS (8) hinaus,
  // aber noch innerhalb des Puffers (RADIUS_WEEKS 14).
  await track.evaluate(
    (el, unit) => {
      el.scrollTop += unit * 6;
    },
    unit,
  );

  await expect.poll(() => anchorDay(page)).toBe(addDays(before as string, 42));

  // Der Nachbau selbst (neue Fuehrungszeile am oberen Pufferrand) darf
  // trotzdem stattfinden — nur eben erst nach dem Scroll-Ende, nicht schon
  // waehrend des Wischs (issue #820, gleiche Logik wie in der Woche).
  await expect.poll(() => firstRow.getAttribute('aria-label')).not.toBe(firstDayBefore);
});

test('der Puffer baut auch weiter, wenn der native "scrollend"-Event nie feuert (issue #822)', async ({
  page,
}) => {
  await page.getByRole('radio', { name: 'Monat' }).click();

  // Simuliert eine Engine, bei der `scrollend` fuer einen scroll-snap-Container
  // ausbleibt (issue #822s vermuteter Grund fuer den begrenzten Bereich): ein
  // Capture-Phase-Listener auf einem Vorfahren stoppt das Ereignis, bevor es
  // den Carousel-eigenen Listener je erreicht. Haenge der Nachbau allein an
  // `scrollend`, bliebe der Streifen jetzt dauerhaft am Rand des anfaenglichen
  // RADIUS_WEEKS-Puffers stehen.
  await calendarStrip(page).evaluate((el) => {
    el.addEventListener('scrollend', (event) => event.stopPropagation(), { capture: true });
  });

  const before = await anchorDay(page);
  await pageStripForward(page, 8);
  const after = await anchorDay(page);

  // Acht volle Bildschirme (48 Wochenzeilen) liegen weit jenseits eines
  // einzelnen Pufferradius (RADIUS_WEEKS 14 Wochen) — ohne Nachbau waere der
  // Streifen laengst am urspruenglichen Rand haengengeblieben.
  expect(dateKeyDiff(before as string, after as string)).toBeGreaterThan(14 * 7);
});

test('ein Maus-Zug ueber Tages-Knoepfe scrollt den Streifen nicht und waehlt keinen anderen Tag (AK4, issue #805)', async ({
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

  const track = calendarWeeks(page);
  const scrollLeftBefore = await track.evaluate((el) => el.scrollLeft);

  const target = dayButton(page, 'Sa, 18.');
  const box = await target.boundingBox();
  if (!box) throw new Error('AK4: Tages-Knopf hat keine BoundingBox');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  // Eine Maus scrollt einen Scroll-Snap-Container nicht (anders als ein
  // echter Touch-Wisch) — und der Browser synthetisiert `click` nur, wenn
  // mousedown und mouseup auf demselben Element landen (UI-Events-Spec); ein
  // Zug auf den Nachbar-Knopf loest deshalb gar keinen Klick aus, ohne dass
  // diese Komponente das eigens verhindern muss (issue #805, ersetzt die
  // alte movedRef/click-capture-Absicherung).
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - 60, startY, { steps: 5 });
  await page.mouse.up();

  await expect(track.evaluate((el) => el.scrollLeft)).resolves.toBe(scrollLeftBefore);
  await expect(dayButton(page, 'Sa, 18.')).toHaveAttribute('aria-pressed', 'true');
  await expect(eventCard(page, 'Heute-Termin')).toBeVisible();
});

test('Antippen eines Tages im aufgezogenen Monat waehlt ihn, der Monat bleibt offen und die Agenda zeigt den Tag (issue #765)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Monatstag-Termin',
    allDay: false,
    startsAt: '2026-07-22T09:00:00.000Z',
    endsAt: '2026-07-22T10:00:00.000Z',
    startDate: null,
    endDate: null,
    category: null,
  });

  const strip = calendarStrip(page);
  await page.getByRole('radio', { name: 'Monat' }).click();
  await expect(strip).toHaveAttribute('data-expanded', 'true');

  const outsideDay = dayButton(page, 'Mi, 22.');
  await outsideDay.click();

  await expect(strip).toHaveAttribute('data-expanded', 'true');
  await expect(outsideDay).toHaveAttribute('aria-pressed', 'true');
  await expect(outsideDay).toBeVisible();
  await expect(eventCard(page, 'Monatstag-Termin')).toBeVisible();
});

test('in der Wochenansicht traegt jede Zelle ihr eigenes Wochentagskuerzel, die feste Kopfzeile fehlt dort (issue #813, AK2)', async ({
  page,
}) => {
  await expect(page.locator('.calendar-strip__weekday-header')).toHaveCount(0);
  await expect(dayButton(page, 'Sa, 18.').locator('.calendar-strip__weekday')).toHaveText('Sa');
  await expect(dayButton(page, 'So, 19.').locator('.calendar-strip__weekday')).toHaveText('So');
});

test('im Monat bleibt die Mo-So-Kopfzeile sichtbar und ausserhalb des Scrollers, Spalte fuer Spalte derselbe Wochentag (issue #813, AK4)', async ({
  page,
}) => {
  await page.getByRole('radio', { name: 'Monat' }).click();
  const header = page.locator('.calendar-strip__weekday-header');
  await expect(header).toBeVisible();
  await expect(header.locator('li')).toHaveText(['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']);
  // Kein Kind des Scrollers — rollt also nicht mit dem Streifen mit.
  await expect(calendarWeeks(page).locator('.calendar-strip__weekday-header')).toHaveCount(0);
});

test('das Dimmen ausserhalb des Monats folgt dem rollenden Anker-Monat, nicht dem urspruenglichen (issue #813)', async ({
  page,
}) => {
  await page.getByRole('radio', { name: 'Monat' }).click();
  const augustMonday = dayButton(page, 'Mo, 3.');
  await expect(augustMonday).toBeVisible();
  await expect(augustMonday).toHaveAttribute('data-outside-month', '');

  const track = calendarWeeks(page);
  const unit = await trackUnitPx(page);
  await track.evaluate(
    (el, unit) => {
      el.scrollTop += unit * 3; // drei Wochen: 13.07. -> 03.08.
    },
    unit,
  );

  await expect.poll(() => anchorDay(page)).toBe('2026-08-03');
  await expect(augustMonday).not.toHaveAttribute('data-outside-month', '');
});

test('Kopf und Umschalter behalten Position und Hoehe beim Wechsel zwischen Woche und Monat (issue #813, AK8)', async ({
  page,
}) => {
  const title = calendarStrip(page).locator('.calendar-strip__title');
  const header = page.locator('.calendar-view__header');
  const titleBoxBefore = await title.boundingBox();
  const headerYBefore = (await header.boundingBox())?.y;

  await page.getByRole('radio', { name: 'Monat' }).click();

  const titleBoxAfter = await title.boundingBox();
  const headerYAfter = (await header.boundingBox())?.y;
  expect(titleBoxAfter?.x).toBe(titleBoxBefore?.x);
  expect(titleBoxAfter?.y).toBe(titleBoxBefore?.y);
  expect(headerYAfter).toBe(headerYBefore);
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

test('der Ruecksprung-Chip springt auf den heutigen Tag zurueck, auch aus einem anderen Monat navigiert (S5 AC4)', async ({
  page,
}) => {
  // #578 behoben, Kartenanzeige durch AC1/AC3 + Regressionstest unten abgedeckt.
  await expect(page.getByRole('button', { name: 'Heute' })).toHaveCount(0);

  const nextDay = page.getByRole('button', { name: 'Nächster Tag' });
  for (let i = 0; i < 20; i += 1) {
    await nextDay.click();
  }

  const todayChip = page.getByRole('button', { name: 'Heute' });
  await expect(todayChip).toBeVisible();
  await todayChip.click();

  await expect(page.getByRole('button', { name: 'Heute' })).toHaveCount(0);
  await expect(dayButton(page, 'Sa, 18.')).toHaveAttribute('aria-pressed', 'true');
});

/* -------------------------------------------------------------------------- */
/* #628: Kopf ohne Spruenge — Monatstitel, Umschalter, Ruecksprung-Chip (S1)  */
/* -------------------------------------------------------------------------- */

test('der Kopf zeigt Monat und Jahr des gewaehlten Tages, auch nach einer Monatsgrenze (AK1)', async ({ page }) => {
  const title = calendarStrip(page).locator('.calendar-strip__title');
  await expect(title).toHaveText('Juli 2026');

  await pageStripForward(page, 2);

  await expect(title).toHaveText('August 2026');
});

test('der Woche/Monat-Umschalter klappt den Streifen auf und zu, Segmente tragen den Auswahlzustand (AK2)', async ({
  page,
}) => {
  const strip = calendarStrip(page);
  const woche = page.getByRole('radio', { name: 'Woche' });
  const monat = page.getByRole('radio', { name: 'Monat' });
  await expect(strip).toHaveAttribute('data-expanded', 'false');
  await expect(woche).toHaveAttribute('aria-checked', 'true');
  await expect(monat).toHaveAttribute('aria-checked', 'false');

  await monat.click();
  await expect(strip).toHaveAttribute('data-expanded', 'true');
  await expect(monat).toHaveAttribute('aria-checked', 'true');
  await expect(woche).toHaveAttribute('aria-checked', 'false');

  await woche.click();
  await expect(strip).toHaveAttribute('data-expanded', 'false');
  await expect(woche).toHaveAttribute('aria-checked', 'true');
  await expect(monat).toHaveAttribute('aria-checked', 'false');
});

test('Titel und Umschalter behalten Position und Hoehe, wenn ein anderer Tag gewaehlt wird (AK5)', async ({
  page,
}) => {
  const title = calendarStrip(page).locator('.calendar-strip__title');
  const switcher = page.getByRole('radiogroup', { name: 'Ansicht' });
  const header = page.locator('.calendar-view__header');

  const titleBoxBefore = await title.boundingBox();
  const switcherBoxBefore = await switcher.boundingBox();
  const headerHeightBefore = (await header.boundingBox())?.height;

  await dayButton(page, 'So, 19.').click();

  const titleBoxAfter = await title.boundingBox();
  const switcherBoxAfter = await switcher.boundingBox();
  const headerHeightAfter = (await header.boundingBox())?.height;

  expect(titleBoxAfter?.x).toBe(titleBoxBefore?.x);
  expect(titleBoxAfter?.y).toBe(titleBoxBefore?.y);
  expect(switcherBoxAfter?.x).toBe(switcherBoxBefore?.x);
  expect(switcherBoxAfter?.y).toBe(switcherBoxBefore?.y);
  expect(headerHeightAfter).toBe(headerHeightBefore);
});

test('der Ruecksprung-Chip erscheint ohne ein Nachbar-Element zu verschieben, waehlt heute und verschwindet dann (AK6)', async ({
  page,
}) => {
  await expect(page.getByRole('button', { name: 'Heute' })).toHaveCount(0);

  const title = calendarStrip(page).locator('.calendar-strip__title');
  const titleBoxBefore = await title.boundingBox();

  await dayButton(page, 'So, 19.').click();

  const chip = page.getByRole('button', { name: 'Heute' });
  await expect(chip).toBeVisible();
  const titleBoxAfter = await title.boundingBox();
  expect(titleBoxAfter?.x).toBe(titleBoxBefore?.x);
  expect(titleBoxAfter?.y).toBe(titleBoxBefore?.y);

  await chip.click();
  await expect(page.getByRole('button', { name: 'Heute' })).toHaveCount(0);
  await expect(dayButton(page, 'Sa, 18.')).toHaveAttribute('aria-pressed', 'true');
});

test('bei reduzierter Bewegung blendet der Ruecksprung-Chip ohne Uebergang ein (AK6, Motion)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await page.waitForFunction(() => typeof window.__starship?.mutate === 'function', null, {
    polling: 100,
  });

  await dayButton(page, 'So, 19.').click();
  const chip = page.getByRole('button', { name: 'Heute' });
  await expect(chip).toBeVisible();
  const transitionDuration = await chip.evaluate((el) => getComputedStyle(el).transitionDuration);
  for (const duration of transitionDuration.split(',')) {
    expect(parseFloat(duration)).toBeLessThan(0.001);
  }
});

test('der Ruecksprung-Chip nutzt semantische Farb-Tokens, mit eigenem Wert im Dark Mode (AK6, Dark Mode)', async ({
  page,
}) => {
  await dayButton(page, 'So, 19.').click();
  const chip = page.getByRole('button', { name: 'Heute' });

  const expectedLight = await resolveToken(page, '--area-events');
  await expect.poll(() => chip.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(expectedLight);

  await page.emulateMedia({ colorScheme: 'dark' });
  const expectedDark = await resolveToken(page, '--area-events');
  await expect.poll(() => chip.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(expectedDark);
  expect(expectedDark).not.toBe(expectedLight);
});

test('bei reduzierter Bewegung klappt der Monat ohne Uebergang direkt auf und zu (S5 AC5, Motion)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await page.waitForFunction(() => typeof window.__starship?.mutate === 'function', null, {
    polling: 100,
  });

  const track = calendarWeeks(page);
  const transitionDuration = await track.evaluate((el) => getComputedStyle(el).transitionDuration);
  for (const duration of transitionDuration.split(',')) {
    expect(parseFloat(duration)).toBeLessThan(0.001);
  }

  const strip = calendarStrip(page);
  await page.getByRole('radio', { name: 'Monat' }).click();
  await expect(strip).toHaveAttribute('data-expanded', 'true');

  await page.getByRole('radio', { name: 'Woche' }).click();
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

/* -------------------------------------------------------------------------- */
/* #630 (S4): Desktop-Werkzeugleiste ‹ › Heute ab 768 px, Anordnung B         */
/* -------------------------------------------------------------------------- */

test('ab 1280 px zeigt der Kopf eine Werkzeugleiste mit ‹, › und Heute statt des Chips, blaettert nur die Vorschau (issue #784, AK7)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  const today = page.getByRole('button', { name: 'Heute' });
  const prevWeek = page.getByRole('button', { name: 'Vorige Woche' });
  const nextWeek = page.getByRole('button', { name: 'Nächste Woche' });
  const title = calendarStrip(page).locator('.calendar-strip__title');

  // Heute ist ausgewaehlt: "Heute" steht als Knopf da, disabled statt entfernt.
  await expect(today).toHaveCount(1);
  await expect(today).toBeVisible();
  await expect(today).toBeDisabled();
  await expect(prevWeek).toBeVisible();
  await expect(nextWeek).toBeVisible();

  // `>` blaettert nur die Vorschau eine Woche weiter (Sa 18. -> Sa 25.) — die
  // Auswahl (heute) bleibt stehen und faellt damit aus dem Fenster (AK7).
  await nextWeek.click();
  await expect(dayButton(page, 'Sa, 25.')).toBeVisible();
  await expect(dayButton(page, 'Sa, 18.')).toHaveCount(0);
  await expect(title).toHaveText('Juli 2026');
  await expect(today).toBeEnabled();

  // In der Monatsansicht blaettert `>` einen Monat, weiterhin nur die Vorschau.
  await page.getByRole('radio', { name: 'Monat' }).click();
  const nextMonth = page.getByRole('button', { name: 'Nächster Monat' });
  await expect(nextMonth).toBeVisible();
  await nextMonth.click();
  await expect(title).toHaveText('August 2026');
});

test('bei 375 px fehlen ‹, › und der Heute-Knopf der Werkzeugleiste, nur der Ruecksprung-Chip bleibt (AK10)', async ({
  page,
}) => {
  await expect(page.getByRole('button', { name: 'Vorige Woche' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Nächste Woche' })).toHaveCount(0);
  // Heute ist ausgewaehlt: der Chip selbst ist ebenfalls nicht da (S1, #628 AK6).
  await expect(page.getByRole('button', { name: 'Heute' })).toHaveCount(0);

  await dayButton(page, 'So, 19.').click();
  await expect(page.getByRole('button', { name: 'Heute' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Vorige Woche' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Nächste Woche' })).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* #554 (S3): Termin-Editor — Anlegen, Ändern, Löschen, offline, ganztägig    */
/* -------------------------------------------------------------------------- */

const CREATE_LABEL = 'Termin erfassen';
const EDIT_LABEL = 'Termin bearbeiten';

/**
 * Issue #806: ein Kartentipp öffnet jetzt erst das schreibgeschützte
 * Detail-Sheet, nicht mehr direkt den Editor — dieser Helfer tippt die Karte
 * an und dann „Bearbeiten", sodass jeder bestehende Bearbeiten-Testpfad beim
 * selben Endzustand (Editor offen) landet. `exact` ist Pflicht: ohne sie
 * matcht die Karte selbst mit ("11:00–12:00 Zu bearbeiten" enthält
 * "Bearbeiten" als Teilstring) und der Klick wird zum Strict-Mode-Fehler.
 */
async function openEventEditor(page: Page, card: Locator): Promise<void> {
  await card.click();
  await page.getByRole('button', { name: 'Bearbeiten', exact: true }).click();
}

/**
 * Issue #712: Von/Bis/Ganztägig, Wiederholung und Kategorie sit behind a chip
 * now — its panel must be open before a field inside it is touched. Scoped by
 * role (not `getByLabel`), since a chip's own accessible name and its open
 * panel's control can share the same text ("Kategorie", "Wiederholung") —
 * `getByLabel` doesn't filter by role and would match both.
 */
function wannChip(scope: Page | Locator): Locator {
  return scope.getByRole('button', { name: /^Wann/ });
}

function wiederholungChip(scope: Page | Locator): Locator {
  return scope.getByRole('button', { name: /Wiederholung/ });
}

function kategorieChip(scope: Page | Locator): Locator {
  return scope.getByRole('button', { name: /Kategorie/ });
}

test('ein neu angelegter Termin erscheint sofort in der Timeline (#554 AC1)', async ({ page }) => {
  await page.getByRole('button', { name: CREATE_LABEL }).click();
  await expect(page.getByRole('dialog', { name: CREATE_LABEL })).toBeVisible();

  await page.getByLabel('Titel').fill('Zahnarzttermin');
  // Mittags gefüllt (TZ-robust, siehe Testplan) — Sichtbarkeit ist die Aussage,
  // nicht die exakte Stundenposition (die deckt schon kalender.spec.ts's AC1 ab).
  await wannChip(page).click();
  await page.getByLabel('Von').fill(`${TODAY}T12:00`);
  await page.getByLabel('Bis').fill(`${TODAY}T13:00`);
  await kategorieChip(page).click();
  await page.getByRole('combobox', { name: 'Kategorie' }).selectOption('gesundheit');
  await page.getByRole('button', { name: 'Anlegen' }).click();

  await expect(page.getByRole('dialog', { name: CREATE_LABEL })).toBeHidden();
  await expect(eventCard(page, 'Zahnarzttermin')).toBeVisible();
});

test('das Ändern eines Termins spiegelt sich sofort in der Timeline (#554 AC2)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Altes Meeting',
    allDay: false,
    startsAt: `${TODAY}T11:00:00.000Z`,
    endsAt: `${TODAY}T12:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });

  await openEventEditor(page, eventCard(page, 'Altes Meeting'));
  await expect(page.getByRole('dialog', { name: EDIT_LABEL })).toBeVisible();
  await expect(page.getByLabel('Titel')).toHaveValue('Altes Meeting');

  await page.getByLabel('Titel').fill('Neues Meeting');
  await page.getByRole('button', { name: 'Sichern' }).click();

  await expect(eventCard(page, 'Neues Meeting')).toBeVisible();
  await expect(eventCard(page, 'Altes Meeting')).toHaveCount(0);
});

test('das Löschen eines Termins bleibt ohne Rückgängig bestehen, der Server landet mit Tombstone (#554 AC3)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Zu löschen',
    allDay: false,
    startsAt: `${TODAY}T11:00:00.000Z`,
    endsAt: `${TODAY}T12:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });

  await openEventEditor(page, eventCard(page, 'Zu löschen'));
  const editDialog = page.getByRole('dialog', { name: EDIT_LABEL });
  await expect(editDialog).toBeVisible();
  // Scoped to the dialog, not a bare page-wide query — the card itself is a
  // <button> whose accessible name contains the event's own title, and this
  // test's title happens to contain the substring "löschen" too (Playwright's
  // `name` match is substring, case-insensitive by default).
  await editDialog.getByRole('button', { name: 'Löschen' }).click();

  await expect(eventCard(page, 'Zu löschen')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeHidden();

  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT deleted_at FROM events WHERE title = $1', ['Zu löschen']),
  );
  expect(row.rows[0].deleted_at).not.toBeNull();
});

test('ein offline angelegter Termin steht sofort lokal und erreicht nach dem Onlinegehen die echte Datenbank (#554 AC4)', async ({
  page,
  context,
}) => {
  await context.setOffline(true);

  await page.getByRole('button', { name: CREATE_LABEL }).click();
  await page.getByLabel('Titel').fill('Im Zug erfasst');
  await wannChip(page).click();
  await page.getByLabel('Von').fill(`${TODAY}T12:00`);
  await page.getByLabel('Bis').fill(`${TODAY}T13:00`);
  await page.getByRole('button', { name: 'Anlegen' }).click();

  await expect(eventCard(page, 'Im Zug erfasst')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  // beforeEach cuts the sync endpoints so the timeline can only ever come from
  // IndexedDB — lift that here to let the queued mutation actually reach Postgres.
  await page.unroute('**/api/sync/**');
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT title FROM events WHERE title = $1', ['Im Zug erfasst']),
  );
  expect(row.rowCount).toBe(1);
});

test('der ganztägig-Umschalter wechselt zwischen Uhrzeit- und reinem Datumsfeld, ohne die Zeitmodelle zu vermischen (#554 AC5)', async ({
  page,
}) => {
  await page.getByRole('button', { name: CREATE_LABEL }).click();
  await expect(page.getByRole('dialog', { name: CREATE_LABEL })).toBeVisible();
  await wannChip(page).click();

  await expect(page.getByLabel('Von')).toHaveAttribute('type', 'datetime-local');

  await page.getByRole('switch', { name: 'Ganztägig' }).click();
  await expect(page.getByLabel('Von')).toHaveAttribute('type', 'date');

  await page.getByRole('switch', { name: 'Ganztägig' }).click();
  await expect(page.getByLabel('Von')).toHaveAttribute('type', 'datetime-local');
});

test('bei reduzierter Bewegung öffnet der Termin-Editor nur mit einem Opacity-Übergang (#554, Motion)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: CREATE_LABEL }).click();

  const dialog = page.getByRole('dialog', { name: CREATE_LABEL });
  await expect(dialog).toBeVisible();
  const transitionProperty = await dialog.evaluate(
    (el) => getComputedStyle(el.firstElementChild as Element).transitionProperty,
  );
  expect(transitionProperty).toBe('opacity');
});

/* -------------------------------------------------------------------------- */
/* #555 (S4): All-Day-Band — ganztägige/mehrtägige Termine                    */
/* -------------------------------------------------------------------------- */

test('ein ganztägiger Termin erscheint im eigenen Band ueber der Stundenachse, nicht als Stundenblock (#555 AC1)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Feiertag',
    allDay: true,
    startsAt: null,
    endsAt: null,
    startDate: TODAY,
    endDate: TODAY,
    category: null,
  });

  await expect(allDayBar(page, 'Feiertag')).toBeVisible();
  await expect(eventCard(page, 'Feiertag')).toHaveCount(0);
});

test('ein 3-tägiger, ganztägiger Termin steht beim Blaettern an jedem der drei Tage im Band (#555 AC2)', async ({
  page,
}) => {
  const thirdDay = '2026-07-20';
  await seedEvent(page, {
    title: 'Konferenz',
    allDay: true,
    startsAt: null,
    endsAt: null,
    startDate: TODAY,
    endDate: thirdDay,
    category: null,
  });

  await expect(allDayBar(page, 'Konferenz')).toBeVisible();

  await selectStripDay(page, 'So, 19.');
  await expect(allDayBar(page, 'Konferenz')).toBeVisible();

  await selectStripDay(page, 'Mo, 20.');
  await expect(allDayBar(page, 'Konferenz')).toBeVisible();

  await selectStripDay(page, 'Di, 21.');
  await expect(allDayBar(page, 'Konferenz')).toHaveCount(0);
});

test('ein mehrtägiger Termin ueber einen Monatswechsel bleibt an der Monatsgrenze korrekt, mit Fortsetzungshinweis statt abgeschnittenem Balken (#555 AC3)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Urlaub',
    allDay: true,
    startsAt: null,
    endsAt: null,
    startDate: '2026-07-30',
    endDate: '2026-08-02',
    category: null,
  });

  // Mid-range, on the far side of the month boundary from where the event started.
  await skewClock(page, '2026-08-01T12:00:00.000Z');
  await page.reload();

  const bar = allDayBar(page, 'Urlaub');
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute('data-continues-before', 'true');
  await expect(bar).toHaveAttribute('data-continues-after', 'true');

  await selectStripDay(page, 'Fr, 31.');
  await expect(bar).toHaveAttribute('data-continues-before', 'true');
  await expect(bar).toHaveAttribute('data-continues-after', 'true');
});

test('eine Ganztags-Leiste mit Kategorie traegt die Kategorie-Farbe als Kante, die Flaeche bleibt --surface — auch im Dark Mode (#555 AC1, Dark Mode)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Betriebsausflug',
    allDay: true,
    startsAt: null,
    endsAt: null,
    startDate: TODAY,
    endDate: TODAY,
    category: 'arbeit',
  });

  const bar = allDayBar(page, 'Betriebsausflug');
  await expect(bar).toBeVisible();

  const expectedEdge = await resolveCardColor(page, '--cat-arbeit', 'borderInlineStartColor');
  const expectedSurface = await resolveCardColor(page, '--surface', 'backgroundColor');
  await expect
    .poll(() => bar.evaluate((el) => getComputedStyle(el).borderInlineStartColor))
    .toBe(expectedEdge);
  expect(await bar.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(expectedSurface);

  await page.emulateMedia({ colorScheme: 'dark' });
  const expectedDark = await resolveCardColor(page, '--cat-arbeit', 'borderInlineStartColor');
  await expect
    .poll(() => bar.evaluate((el) => getComputedStyle(el).borderInlineStartColor))
    .toBe(expectedDark);
});

test('ein Termin ausserhalb seines Datumsbereichs steht nicht im Band (#555 AC2)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Nur gestern',
    allDay: true,
    startsAt: null,
    endsAt: null,
    startDate: '2026-07-17',
    endDate: '2026-07-17',
    category: null,
  });

  await expect(allDayBar(page, 'Nur gestern')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* #557 (S6): Serientermine + Ausnahmen                                       */
/* -------------------------------------------------------------------------- */

test('eine woechentliche Serie landet ueber einen Monatswechsel hinweg am richtigen Wochentag, mit der richtigen Uhrzeit (AC1)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Wochenmeeting',
    allDay: false,
    startsAt: '2026-07-13T07:00:00.000Z', // 09:00 Berlin
    endsAt: '2026-07-13T08:00:00.000Z',
    startDate: null,
    endDate: null,
    category: null,
    // No byWeekday — defaults to the anchor's own weekday (event-time.ts doc).
    recurrence: { freq: 'weekly', interval: 1 },
  });

  // Three weeks later, crossing the July/August boundary.
  await skewClock(page, '2026-08-03T10:00:00.000Z');
  await page.reload();

  const card = eventCard(page, 'Wochenmeeting');
  await expect(card).toBeVisible();
  await expect(card).toContainText('09:00');
});

test('eine woechentliche Serie behaelt ihre lokale Uhrzeit ueber die Sommerzeit-Umstellung hinweg (AC2)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'DST-Meeting',
    allDay: false,
    startsAt: '2026-03-23T08:00:00.000Z', // 09:00 Berlin (CET, UTC+1)
    endsAt: '2026-03-23T09:00:00.000Z',
    startDate: null,
    endDate: null,
    category: null,
    recurrence: { freq: 'weekly', interval: 1 },
  });

  // One week later — spans the 2026-03-29 changeover into CEST (UTC+2).
  await skewClock(page, '2026-03-30T10:00:00.000Z');
  await page.reload();

  const card = eventCard(page, 'DST-Meeting');
  await expect(card).toBeVisible();
  await expect(card).toContainText('09:00');
});

test('eine woechentliche Serie ist im Editor anlegbar und erscheint eine Woche spaeter wieder (Wiederholungs-UI)', async ({
  page,
}) => {
  await page.getByRole('button', { name: CREATE_LABEL }).click();
  await page.getByLabel('Titel').fill('Yoga');
  await wannChip(page).click();
  await page.getByLabel('Von').fill(`${TODAY}T18:00`);
  await page.getByLabel('Bis').fill(`${TODAY}T19:00`);
  await wiederholungChip(page).click();
  await page.getByRole('combobox', { name: 'Wiederholung', exact: true }).selectOption('weekly');
  await page.getByRole('button', { name: 'Anlegen' }).click();

  await expect(eventCard(page, 'Yoga')).toBeVisible();

  // Navigiert zur naechsten Woche (Antippen, nicht Ziehen — ein Zug bewegt
  // seit #784 nur noch die Vorschau, nicht mehr die Auswahl).
  await selectStripDay(page, 'Sa, 25.');
  await expect(eventCard(page, 'Yoga')).toBeVisible();
});

test('das Intervall-Feld und die Wochentage erscheinen nur, wenn eine Wiederholung gewaehlt ist', async ({
  page,
}) => {
  await page.getByRole('button', { name: CREATE_LABEL }).click();
  await wiederholungChip(page).click();
  await expect(page.getByLabel('Intervall')).toHaveCount(0);

  await page.getByRole('combobox', { name: 'Wiederholung', exact: true }).selectOption('weekly');
  await expect(page.getByLabel('Intervall')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Mo' })).toBeVisible();

  await page.getByRole('combobox', { name: 'Wiederholung', exact: true }).selectOption('daily');
  await expect(page.getByRole('checkbox', { name: 'Mo' })).toHaveCount(0);

  await page.getByRole('combobox', { name: 'Wiederholung', exact: true }).selectOption('');
  await expect(page.getByLabel('Intervall')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* AC3–AC5: Ausnahmen fuer Serientermine ("nur dieser"/"alle folgenden")      */
/* -------------------------------------------------------------------------- */

async function seedWeeklySeries(page: Page): Promise<void> {
  await seedEvent(page, {
    title: 'Yoga',
    allDay: false,
    startsAt: `${TODAY}T16:00:00.000Z`, // 18:00 Berlin (CEST, UTC+2)
    endsAt: `${TODAY}T17:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
    recurrence: { freq: 'weekly', interval: 1 },
  });
}

test('„nur dieser" verschiebt nur dieses eine Vorkommen, die uebrigen bleiben unveraendert (AC3)', async ({
  page,
}) => {
  await seedWeeklySeries(page);

  await openEventEditor(page, eventCard(page, 'Yoga'));
  await expect(page.getByRole('dialog', { name: EDIT_LABEL })).toBeVisible();
  await wannChip(page).click();
  // `datetime-local` is read back in the *browser's* local time (CI runs UTC,
  // no timezoneId override) — fill the UTC clock time that reads 19:00–20:00
  // once the card renders it back in Berlin time (CEST, UTC+2).
  await page.getByLabel('Von').fill(`${TODAY}T17:00`);
  await page.getByLabel('Bis').fill(`${TODAY}T18:00`);
  await page.getByRole('button', { name: 'Sichern' }).click();

  const scopeDialog = page.getByRole('dialog', { name: 'Änderung übernehmen für' });
  await expect(scopeDialog).toBeVisible();
  await scopeDialog.getByRole('button', { name: 'Nur dieser' }).click();

  await expect(eventCard(page, 'Yoga')).toContainText('19:00');

  // A week later, the series' own occurrence still runs at the original time.
  // Navigiert per Antippen (nicht Ziehen — #784) zur naechsten Woche.
  await selectStripDay(page, 'Sa, 25.');
  await expect(eventCard(page, 'Yoga')).toContainText('18:00');
});

/** Same synthetic-Pointer-Events technique as tasks.spec.ts's swipeRight/swipeLeft,
 * straight down instead (issue #757). */
async function pullDown(locator: Locator, distancePx: number) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('pullDown: target has no bounding box');
  const clientX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

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
    clientY: startY + distancePx,
    bubbles: true,
  });
  await locator.dispatchEvent('pointerup', {
    pointerId: 1,
    clientX,
    clientY: startY + distancePx,
    bubbles: true,
  });
}

test('Runterziehen schließt auch die Serien-Abfrage, die keine eigene Kopfzeile hat (issue #757)', async ({
  page,
}) => {
  await seedWeeklySeries(page);

  await openEventEditor(page, eventCard(page, 'Yoga'));
  await expect(page.getByRole('dialog', { name: EDIT_LABEL })).toBeVisible();
  await wannChip(page).click();
  await page.getByLabel('Von').fill(`${TODAY}T17:00`);
  await page.getByLabel('Bis').fill(`${TODAY}T18:00`);
  await page.getByRole('button', { name: 'Sichern' }).click();

  const scopeDialog = page.getByRole('dialog', { name: 'Änderung übernehmen für' });
  await expect(scopeDialog).toBeVisible();
  // This sheet never passes `header` (recurrence-scope-sheet.tsx) — no grip, so
  // the pull has to work from the question text itself, proving the fix isn't
  // scoped to sheets with the shared header.
  await pullDown(scopeDialog.locator('.recurrence-scope-sheet__question'), 160);

  await expect(scopeDialog).toBeHidden();
  // Dismissed, not "Nur dieser" — the same as Abbrechen, the edit was never applied.
  await expect(eventCard(page, 'Yoga')).toContainText('18:00');
});

test('ein ausgefallenes Vorkommen verschwindet nur an diesem Tag aus der Timeline (AC4)', async ({
  page,
}) => {
  await seedWeeklySeries(page);

  await openEventEditor(page, eventCard(page, 'Yoga'));
  const editDialog = page.getByRole('dialog', { name: EDIT_LABEL });
  await expect(editDialog).toBeVisible();
  await editDialog.getByRole('button', { name: 'Löschen' }).click();

  const scopeDialog = page.getByRole('dialog', { name: 'Termin löschen — für welche Vorkommen?' });
  await expect(scopeDialog).toBeVisible();
  await scopeDialog.getByRole('button', { name: 'Nur dieser' }).click();

  await expect(eventCard(page, 'Yoga')).toHaveCount(0);

  // The next occurrence a week later is untouched. Navigiert per Antippen
  // (nicht Ziehen — #784) zur naechsten Woche.
  await selectStripDay(page, 'Sa, 25.');
  await expect(eventCard(page, 'Yoga')).toBeVisible();
});

test('„alle folgenden" aendert dieses und alle spaeteren Vorkommen, keine frueheren (AC5)', async ({
  page,
}) => {
  await seedWeeklySeries(page);

  // Edit the second occurrence (a week later), not the series' own first one.
  // Navigiert per Antippen (nicht Ziehen — #784) zur naechsten Woche.
  await selectStripDay(page, 'Sa, 25.');
  await openEventEditor(page, eventCard(page, 'Yoga'));
  await expect(page.getByRole('dialog', { name: EDIT_LABEL })).toBeVisible();
  await wannChip(page).click();
  // Same UTC-vs-Berlin offset as the "nur dieser" test above.
  await page.getByLabel('Von').fill('2026-07-25T17:00');
  await page.getByLabel('Bis').fill('2026-07-25T18:00');
  await page.getByRole('button', { name: 'Sichern' }).click();

  const scopeDialog = page.getByRole('dialog', { name: 'Änderung übernehmen für' });
  await expect(scopeDialog).toBeVisible();
  await scopeDialog.getByRole('button', { name: 'Alle folgenden' }).click();

  await expect(eventCard(page, 'Yoga')).toContainText('19:00');

  // A further week on, the change still applies.
  await selectStripDay(page, 'Sa, 1.');
  await expect(eventCard(page, 'Yoga')).toContainText('19:00');

  // Back on the series' own first occurrence, the original time survives —
  // "Heute" re-selects it directly (nicht Ziehen — #784), the series was
  // seeded on TODAY.
  await page.getByRole('button', { name: 'Heute' }).click();
  await expect(eventCard(page, 'Yoga')).toContainText('18:00');
});

/* -------------------------------------------------------------------------- */
/* #712: Termin-Sheet auf Zeile und Chips                                     */
/* -------------------------------------------------------------------------- */

test('AK1: das Create-Sheet zeigt Titelzeile plus drei Chips, Von steht erst nach dem Öffnen des Wann-Chips im DOM', async ({
  page,
}) => {
  await page.getByRole('button', { name: CREATE_LABEL }).click();
  const dialog = page.getByRole('dialog', { name: CREATE_LABEL });
  await expect(dialog).toBeVisible();

  await expect(dialog.getByLabel('Titel')).toBeVisible();
  await expect(wannChip(dialog)).toBeVisible();
  await expect(wiederholungChip(dialog)).toBeVisible();
  await expect(kategorieChip(dialog)).toBeVisible();
  await expect(dialog.getByLabel('Von')).toHaveCount(0);

  await wannChip(dialog).click();
  await expect(dialog.getByLabel('Von')).toBeVisible();
});

test('AK2: der Wann-Chip öffnet Ganztägig-Schalter sowie Von und Bis als Pflichtfelder', async ({
  page,
}) => {
  await page.getByRole('button', { name: CREATE_LABEL }).click();
  await wannChip(page).click();

  await expect(page.getByRole('switch', { name: 'Ganztägig' })).toBeVisible();
  await expect(page.getByLabel('Von')).toHaveAttribute('required', '');
  await expect(page.getByLabel('Bis')).toHaveAttribute('required', '');

  // Ganztägig umschalten wechselt weiterhin das Zeitmodell — required bleibt.
  await page.getByRole('switch', { name: 'Ganztägig' }).click();
  await expect(page.getByLabel('Von')).toHaveAttribute('type', 'date');
  await expect(page.getByLabel('Von')).toHaveAttribute('required', '');
  await expect(page.getByLabel('Bis')).toHaveAttribute('required', '');
});

test('AK3b: eine Serie mit Ende „Am ⟨Datum⟩" behält beim Wiederöffnen das gewählte Enddatum (Achtung: beide RRULE-Enden bleiben erreichbar)', async ({
  page,
}) => {
  await page.getByRole('button', { name: CREATE_LABEL }).click();
  await page.getByLabel('Titel').fill('Bis Monatsende');
  await wannChip(page).click();
  await page.getByLabel('Von').fill(`${TODAY}T09:00`);
  await page.getByLabel('Bis').fill(`${TODAY}T10:00`);
  await wiederholungChip(page).click();
  await page.getByRole('combobox', { name: 'Wiederholung', exact: true }).selectOption('daily');
  await page.getByLabel('Endet am').fill('2026-08-01');
  await page.getByRole('button', { name: 'Anlegen' }).click();

  await openEventEditor(page, eventCard(page, 'Bis Monatsende'));
  await expect(page.getByRole('dialog', { name: EDIT_LABEL })).toBeVisible();
  await wiederholungChip(page).click();

  // Reihenfolge der drei Radios im DOM: Nie / Am / Nach — stabiler als ihr
  // accessible name, der beim "Nach"-Radio das genestete Zahlenfeld einschließt.
  const endRadios = page.locator('input[name="recurrence-end"]');
  await expect(endRadios.nth(1)).toBeChecked();
  await expect(endRadios.nth(2)).not.toBeChecked();
  await expect(page.getByLabel('Endet am')).toHaveValue('2026-08-01');
});

test('AK3c: eine Serie mit Ende „Nach ⟨N⟩ ×" behält beim Wiederöffnen die gewählte Anzahl, Endet-am bleibt leer', async ({
  page,
}) => {
  await page.getByRole('button', { name: CREATE_LABEL }).click();
  await page.getByLabel('Titel').fill('Fünf Mal');
  await wannChip(page).click();
  await page.getByLabel('Von').fill(`${TODAY}T09:00`);
  await page.getByLabel('Bis').fill(`${TODAY}T10:00`);
  await wiederholungChip(page).click();
  await page.getByRole('combobox', { name: 'Wiederholung', exact: true }).selectOption('daily');
  await page.getByLabel('Anzahl Wiederholungen').fill('5');
  await page.getByRole('button', { name: 'Anlegen' }).click();

  await openEventEditor(page, eventCard(page, 'Fünf Mal'));
  await expect(page.getByRole('dialog', { name: EDIT_LABEL })).toBeVisible();
  await wiederholungChip(page).click();

  const endRadios = page.locator('input[name="recurrence-end"]');
  await expect(endRadios.nth(2)).toBeChecked();
  await expect(endRadios.nth(1)).not.toBeChecked();
  await expect(page.getByLabel('Anzahl Wiederholungen')).toHaveValue('5');
  await expect(page.getByLabel('Endet am')).toHaveValue('');
});

test('AK4: Löschen erscheint als Textknopf im Fuß nur im Bearbeiten-, nicht im Anlegen-Modus', async ({
  page,
}) => {
  await page.getByRole('button', { name: CREATE_LABEL }).click();
  const createDialog = page.getByRole('dialog', { name: CREATE_LABEL });
  await expect(createDialog).toBeVisible();
  await expect(createDialog.getByRole('button', { name: 'Löschen' })).toHaveCount(0);
  await createDialog.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(createDialog).toBeHidden();

  await seedEvent(page, {
    title: 'Zu bearbeiten',
    allDay: false,
    startsAt: `${TODAY}T11:00:00.000Z`,
    endsAt: `${TODAY}T12:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });
  await openEventEditor(page, eventCard(page, 'Zu bearbeiten'));
  const editDialog = page.getByRole('dialog', { name: EDIT_LABEL });
  await expect(editDialog).toBeVisible();
  await expect(editDialog.getByRole('button', { name: 'Löschen' })).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* #806: Detail-Sheet vor dem Editor — kein ungewollter Tastatur-Popup        */
/* -------------------------------------------------------------------------- */

test('AK1: ein Kartentipp auf einen getimten Termin öffnet das Detail-Sheet, nicht den Editor — kein Feld hat Fokus (#806)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Zahnarzttermin',
    allDay: false,
    startsAt: `${TODAY}T11:00:00.000Z`,
    endsAt: `${TODAY}T12:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });

  await eventCard(page, 'Zahnarzttermin').click();

  await expect(page.getByRole('dialog', { name: 'Zahnarzttermin' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: EDIT_LABEL })).toHaveCount(0);
  // Nicht toHaveCount(0): der Editor bleibt unabhängig vom Öffnen-Zustand
  // gemountet, sein Titelfeld steckt nur hinter einem geschlossenen <dialog>
  // (display: none) — anders als getByRole ignoriert getByLabel das.
  await expect(page.getByLabel('Titel')).not.toBeVisible();
});

test('AK1: ein Tipp auf einen ganztägigen (eigenen) Termin öffnet ebenfalls das Detail-Sheet, nicht den Editor (#806)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Feiertag',
    allDay: true,
    startsAt: null,
    endsAt: null,
    startDate: TODAY,
    endDate: TODAY,
    category: null,
  });

  await allDayBar(page, 'Feiertag').click();

  await expect(page.getByRole('dialog', { name: 'Feiertag' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: EDIT_LABEL })).toHaveCount(0);
  // Nicht toHaveCount(0), siehe getimter Fall oben — getByLabel ignoriert
  // das display:none des geschlossenen Editor-<dialog>.
  await expect(page.getByLabel('Titel')).not.toBeVisible();
});

test('AK2: das Detail-Sheet zeigt Titel, Zeit und Kategorie; „Bearbeiten" schließt es und öffnet den Editor vorbefüllt (#806)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Zahnarzttermin',
    allDay: false,
    startsAt: `${TODAY}T11:00:00.000Z`, // 13:00 Berlin (CEST, UTC+2)
    endsAt: `${TODAY}T12:00:00.000Z`, // 14:00 Berlin
    startDate: null,
    endDate: null,
    category: 'gesundheit',
  });

  await eventCard(page, 'Zahnarzttermin').click();
  const detailDialog = page.getByRole('dialog', { name: 'Zahnarzttermin' });
  await expect(detailDialog).toContainText('Zahnarzttermin');
  await expect(detailDialog).toContainText('13:00–14:00');
  await expect(detailDialog).toContainText('Gesundheit');

  await detailDialog.getByRole('button', { name: 'Bearbeiten' }).click();

  await expect(detailDialog).toBeHidden();
  const editDialog = page.getByRole('dialog', { name: EDIT_LABEL });
  await expect(editDialog).toBeVisible();
  await expect(page.getByLabel('Titel')).toHaveValue('Zahnarzttermin');
});

test('AK3: nach „Bearbeiten" liegt der Fokus nicht auf dem Titelfeld — keine Tastatur beim Start des Bearbeitens (#806)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Zahnarzttermin',
    allDay: false,
    startsAt: `${TODAY}T11:00:00.000Z`,
    endsAt: `${TODAY}T12:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });

  await openEventEditor(page, eventCard(page, 'Zahnarzttermin'));
  await expect(page.getByRole('dialog', { name: EDIT_LABEL })).toBeVisible();
  await expect(page.getByLabel('Titel')).not.toBeFocused();
});

test('AK4: der „Bearbeiten"-Knopf existiert nur solange das Detail-Sheet offen ist (#806)', async ({ page }) => {
  await seedEvent(page, {
    title: 'Zahnarzttermin',
    allDay: false,
    startsAt: `${TODAY}T11:00:00.000Z`,
    endsAt: `${TODAY}T12:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });

  await expect(page.getByRole('button', { name: 'Bearbeiten' })).toHaveCount(0);

  await eventCard(page, 'Zahnarzttermin').click();
  const detailDialog = page.getByRole('dialog', { name: 'Zahnarzttermin' });
  await expect(detailDialog).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bearbeiten' })).toBeVisible();

  await detailDialog.getByRole('button', { name: 'Schließen' }).click();
  await expect(detailDialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Bearbeiten' })).toHaveCount(0);
});

test('AK6: der FAB „Termin erfassen" öffnet den Editor weiterhin direkt mit Fokus im Titelfeld (#806)', async ({
  page,
}) => {
  await page.getByRole('button', { name: CREATE_LABEL }).click();
  await expect(page.getByRole('dialog', { name: CREATE_LABEL })).toBeVisible();
  await expect(page.getByLabel('Titel')).toBeFocused();
});

/* -------------------------------------------------------------------------- */
/* #578 (Fund): useListPresence-Array stabilisiert                            */
/* -------------------------------------------------------------------------- */

test('mehrfaches Tag-fuer-Tag-Navigieren mit Termin am angezeigten Tag loest keine Endlosschleife aus (Fund #578)', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  await seedEvent(page, {
    title: 'Dauertermin',
    allDay: false,
    startsAt: `${TODAY}T09:00:00.000Z`,
    endsAt: `${TODAY}T10:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });
  await expect(eventCard(page, 'Dauertermin')).toBeVisible();

  for (let i = 0; i < 6; i += 1) {
    await selectStripDay(page, 'So, 19.');
    await selectStripDay(page, 'Sa, 18.');
  }

  await expect(eventCard(page, 'Dauertermin')).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

/* -------------------------------------------------------------------------- */
/* Fund #579: SSR/Client-Hydration-Mismatch bei "today"                       */
/* -------------------------------------------------------------------------- */

test('kein Hydration-Mismatch beim Laden von /kalender, obwohl nur die Browser-Uhr gefaelscht ist (Fund #579)', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  // beforeEach's goto happened before the listeners above were registered —
  // reload for a fresh SSR+hydration cycle with the fake clock still installed.
  await page.reload();

  await expect(page.getByRole('button', { name: 'Heute' })).toHaveCount(0);
  await expect(dayButton(page, 'Sa, 18.')).toBeVisible();

  expect(consoleErrors.filter((text) => /hydrat|did.?n.?t match/i.test(text))).toEqual([]);
});

/* -------------------------------------------------------------------------- */
/* #611: Tageswechsel tauscht die Liste hart — keine Termine von gestern       */
/* -------------------------------------------------------------------------- */

interface AgendaRowSnapshot {
  text: string;
  entering: string | null;
  leaving: string | null;
}

/**
 * Clicks a day-navigation button *inside* the page and reads the agenda back in
 * the very next animation frame — the first frame the browser paints after the
 * day changed, i.e. exactly what the user sees (#611 AC1/AC2). Nothing here is
 * retried on purpose: a Playwright locator would happily wait out the 240 ms
 * exit animation, which is the bug rather than something to wait for.
 *
 * One frame is the earliest honest place to look: React 19 flushes a discrete
 * event's updates in a microtask, not synchronously inside `click()`, so
 * reading straight after the call would report the pre-click DOM even with the
 * bug fixed.
 */
async function agendaAfterDaySwitch(
  page: Page,
  navLabel: string,
): Promise<{ items: AgendaRowSnapshot[]; allDay: AgendaRowSnapshot[] }> {
  return page.evaluate(async (label) => {
    const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!button) throw new Error(`agendaAfterDaySwitch: no button labelled "${label}"`);
    button.click();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    const snapshot = (selector: string) =>
      Array.from(document.querySelectorAll(selector)).map((element) => ({
        text: element.textContent ?? '',
        entering: element.getAttribute('data-entering'),
        leaving: element.getAttribute('data-leaving'),
      }));
    return {
      items: snapshot('.event-agenda__item'),
      allDay: snapshot('.event-agenda__all-day-item'),
    };
  }, navLabel);
}

test('beim Tageswechsel steht kein Termin des vorherigen Tages mehr in der Agenda, schon im ersten Frame (#611 AC1, AC3)', async ({
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

  const forward = await agendaAfterDaySwitch(page, 'So, 19.');
  expect(forward.items.map((row) => row.text)).toHaveLength(1);
  expect(forward.items[0].text).toContain('Morgen-Termin');
  expect(forward.items.filter((row) => row.leaving === 'true')).toEqual([]);
  expect(forward.items.filter((row) => row.entering === 'true')).toEqual([]);

  // …and back again: the same swap in the other direction, not a one-way fix.
  const backward = await agendaAfterDaySwitch(page, 'Sa, 18.');
  expect(backward.items.map((row) => row.text)).toHaveLength(1);
  expect(backward.items[0].text).toContain('Heute-Termin');
  expect(backward.items.filter((row) => row.leaving === 'true')).toEqual([]);
});

test('beim Tageswechsel raeumt auch das Ganztags-Band den vorherigen Tag sofort (#611 AC2, AC3)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Heute ganztags',
    allDay: true,
    startsAt: null,
    endsAt: null,
    startDate: TODAY,
    endDate: TODAY,
    category: null,
  });
  await seedEvent(page, {
    title: 'Morgen ganztags',
    allDay: true,
    startsAt: null,
    endsAt: null,
    startDate: TOMORROW,
    endDate: TOMORROW,
    category: null,
  });
  await expect(allDayBar(page, 'Heute ganztags')).toBeVisible();

  const forward = await agendaAfterDaySwitch(page, 'So, 19.');
  expect(forward.allDay.map((row) => row.text)).toHaveLength(1);
  expect(forward.allDay[0].text).toContain('Morgen ganztags');
  expect(forward.allDay.filter((row) => row.leaving === 'true')).toEqual([]);
  expect(forward.allDay.filter((row) => row.entering === 'true')).toEqual([]);
});

test('am angezeigten Tag animieren Zu- und Abgaenge weiterhin (#611 AC4, Regression #430)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Bleibt erstmal',
    allDay: false,
    startsAt: `${TODAY}T09:00:00.000Z`,
    endsAt: `${TODAY}T10:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });
  await expect(eventCard(page, 'Bleibt erstmal')).toBeVisible();

  // Freezes the enter/exit animations mid-flight so their states can be
  // asserted without racing a 190/240 ms window — the animation still starts,
  // it just never reaches animationend, which is what would clear the flag.
  await page.addStyleTag({
    content: '.list-motion-item { animation-play-state: paused !important; }',
  });

  await seedEvent(page, {
    title: 'Kommt dazu',
    allDay: false,
    startsAt: `${TODAY}T11:00:00.000Z`,
    endsAt: `${TODAY}T12:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });
  const entering = page.locator('.event-agenda__item[data-entering="true"]');
  await expect(entering).toHaveCount(1);
  await expect(entering).toContainText('Kommt dazu');

  await openEventEditor(page, eventCard(page, 'Bleibt erstmal'));
  const editDialog = page.getByRole('dialog', { name: EDIT_LABEL });
  await expect(editDialog).toBeVisible();
  await editDialog.getByRole('button', { name: 'Löschen' }).click();

  const leaving = page.locator('.event-agenda__item[data-leaving="true"]');
  await expect(leaving).toHaveCount(1);
  await expect(leaving).toContainText('Bleibt erstmal');
});

/* -------------------------------------------------------------------------- */
/* #612: die Punkte im Band lesen die expandierten Vorkommen                  */
/* -------------------------------------------------------------------------- */

/**
 * Vorher las `categoriesForDay` die Roh-Zeilen aus `events` und verglich nur
 * `startsAt` — eine Serie bekam ihren Punkt darum ausschließlich am Ankertag,
 * ein abgesagtes Vorkommen behielt ihn, und ein ganztägiger Termin (ohne
 * `startsAt`) hatte nie einen. TODAY (2026-07-18) ist ein Samstag; die
 * Folgevorkommen liegen auf 'Sa, 25.' und 'Sa, 1.' (August), beide noch im
 * Juliraster der aufgezogenen Ansicht.
 */
/**
 * Wie `eventCard`, aber ohne das gerade abziehende Exemplar. Springt man in
 * einem Klick von einem Vorkommen direkt zum nächsten, hält `useListPresence`
 * die alte Karte bis zum Ende ihrer Exit-Animation im DOM — beide tragen
 * denselben Titel, und `eventCard` verletzt dann Playwrights Strict Mode.
 * (Die bestehenden S6-Tests laufen über Tage ohne Vorkommen und treffen das
 * nicht.)
 */
function settledEventCard(page: Page, title: string) {
  return page
    .locator('.event-agenda__item:not([data-leaving="true"])')
    .filter({ hasText: title });
}

async function seedWeeklyDotSeries(page: Page): Promise<void> {
  await seedEvent(page, {
    title: 'Yoga',
    allDay: false,
    startsAt: `${TODAY}T16:00:00.000Z`, // 18:00 Berlin (CEST, UTC+2)
    endsAt: `${TODAY}T17:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: 'arbeit',
    recurrence: { freq: 'weekly', interval: 1 },
  });
}

test('eine woechentliche Serie setzt an jedem Vorkommen einen Punkt, nicht nur am Ankertag (#612 AC1)', async ({
  page,
}) => {
  await seedWeeklyDotSeries(page);
  await page.getByRole('radio', { name: 'Monat' }).click();

  await expect(dayDots(page, 'Sa, 18.')).toHaveCount(1);
  await expect(dayDots(page, 'Sa, 25.')).toHaveCount(1);
  // Über den Monatswechsel hinweg — 2026-08-01 liegt in der letzten Rasterzeile.
  await expect(dayDots(page, 'Sa, 1.')).toHaveCount(1);

  // Die Tage dazwischen gehören nicht zur Serie.
  await expect(dayDots(page, 'So, 19.')).toHaveCount(0);
  await expect(dayDots(page, 'Mo, 20.')).toHaveCount(0);
});

test('die Serien-Punkte ueberleben einen Reload ohne Netzwerk, kommen also aus IndexedDB (#612 AC1, Offline-Pfad)', async ({
  page,
}) => {
  await seedWeeklyDotSeries(page);
  await expect(dayDots(page, 'Sa, 18.')).toHaveCount(1);

  // beforeEach kappt /api/sync/** — nach dem Reload können die Punkte nur aus
  // IndexedDB stammen, die Expansion läuft also rein lokal (gleiche Technik wie
  // der S5-Offline-Test weiter oben).
  await page.reload();
  await page.waitForFunction(() => typeof window.__starship?.mutate === 'function', null, {
    polling: 100,
  });
  await page.getByRole('radio', { name: 'Monat' }).click();

  await expect(dayDots(page, 'Sa, 25.')).toHaveCount(1);
});

test('ein ausgefallenes Vorkommen verliert seinen Punkt, die uebrigen behalten ihn (#612 AC2)', async ({
  page,
}) => {
  await seedWeeklyDotSeries(page);
  await expect(dayDots(page, 'Sa, 18.')).toHaveCount(1);

  await openEventEditor(page, eventCard(page, 'Yoga'));
  const editDialog = page.getByRole('dialog', { name: EDIT_LABEL });
  await expect(editDialog).toBeVisible();
  await editDialog.getByRole('button', { name: 'Löschen' }).click();

  const scopeDialog = page.getByRole('dialog', { name: 'Termin löschen — für welche Vorkommen?' });
  await expect(scopeDialog).toBeVisible();
  await scopeDialog.getByRole('button', { name: 'Nur dieser' }).click();

  await expect(eventCard(page, 'Yoga')).toHaveCount(0);
  await expect(dayDots(page, 'Sa, 18.')).toHaveCount(0);

  // Nur dieses eine Vorkommen ist weg — die Serie punktet weiter.
  await page.getByRole('radio', { name: 'Monat' }).click();
  await expect(dayDots(page, 'Sa, 25.')).toHaveCount(1);
});

test('ein ganztaegiger Termin bekommt einen Punkt, ein mehrtaegiger an jedem Tag seiner Spanne (#612 AC3)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Feiertag',
    allDay: true,
    startsAt: null,
    endsAt: null,
    startDate: TODAY,
    endDate: TODAY,
    category: 'privat',
  });

  const dots = dayDots(page, 'Sa, 18.');
  await expect(dots).toHaveCount(1);
  const expectedPrivat = await resolveToken(page, '--cat-privat');
  await expect
    .poll(() => dots.first().evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(expectedPrivat);

  await seedEvent(page, {
    title: 'Kurzurlaub',
    allDay: true,
    startsAt: null,
    endsAt: null,
    startDate: '2026-07-19',
    endDate: '2026-07-21',
    category: 'familie',
  });

  await expect(dayDots(page, 'So, 19.')).toHaveCount(1);

  // Mo/Di/Mi liegen in der naechsten Wochen-Seite des Karussells, nicht mehr
  // in der zentrierten (issue #805, dayButton scoped auf :not([inert])) —
  // erst die Monatsansicht zeigt sie auf derselben, zentrierten Seite.
  await page.getByRole('radio', { name: 'Monat' }).click();
  await expect(dayDots(page, 'Mo, 20.')).toHaveCount(1);
  await expect(dayDots(page, 'Di, 21.')).toHaveCount(1);
  await expect(dayDots(page, 'Mi, 22.')).toHaveCount(0);
});

test('Punkt und Tagesansicht stimmen ueberein: ein Punkt genau dann, wenn der Tag einen Termin zeigt (#612 AC4)', async ({
  page,
}) => {
  await seedWeeklyDotSeries(page);

  // Das Vorkommen eine Woche weiter: Punkt im Band UND Karte in der Tagesansicht.
  await page.getByRole('radio', { name: 'Monat' }).click();
  await dayButton(page, 'Sa, 25.').click();
  await expect(dayDots(page, 'Sa, 25.')).toHaveCount(1);
  await expect(settledEventCard(page, 'Yoga')).toBeVisible();

  // Ein Tag ohne Vorkommen: weder Punkt noch Karte.
  await dayButton(page, 'So, 26.').click();
  await expect(dayDots(page, 'So, 26.')).toHaveCount(0);
  await expect(settledEventCard(page, 'Yoga')).toHaveCount(0);
});

test('ein Punkt je Kategorie, nicht je Vorkommen — auch wenn Serie und Einzeltermin auf denselben Tag fallen (#612 AC5)', async ({
  page,
}) => {
  await seedWeeklyDotSeries(page); // arbeit, wöchentlich ab Sa 18.
  await seedEvent(page, {
    title: 'Zweites Arbeitsding',
    allDay: false,
    startsAt: '2026-07-25T09:00:00.000Z',
    endsAt: '2026-07-25T10:00:00.000Z',
    startDate: null,
    endDate: null,
    category: 'arbeit',
  });
  await seedEvent(page, {
    title: 'Laufrunde',
    allDay: false,
    startsAt: '2026-07-25T11:00:00.000Z',
    endsAt: '2026-07-25T12:00:00.000Z',
    startDate: null,
    endDate: null,
    category: 'sport',
  });

  await page.getByRole('radio', { name: 'Monat' }).click();

  // Drei Termine, zwei Kategorien — und 'arbeit' steht in CATEGORY_ORDER vor 'sport'.
  const dots = dayDots(page, 'Sa, 25.');
  await expect(dots).toHaveCount(2);
  const expectedArbeit = await resolveToken(page, '--cat-arbeit');
  const expectedSport = await resolveToken(page, '--cat-sport');
  await expect
    .poll(() => dots.nth(0).evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(expectedArbeit);
  await expect
    .poll(() => dots.nth(1).evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(expectedSport);
});

/* -------------------------------------------------------------------------- */
/* ICS-Abo, schreibgeschützt (issue #560, ADR-0022)                           */
/* -------------------------------------------------------------------------- */

const ICS_URL = 'https://example.com/feiertage.ics';

function icsDateKey(dateKey: string): string {
  return dateKey.replace(/-/g, '');
}

function icsFixture(events: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR'].join('\r\n');
}

function singleDayIcsEvent(uid: string, summary: string, dateKey: string): string[] {
  return ['BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`, `DTSTART;VALUE=DATE:${icsDateKey(dateKey)}`, 'END:VEVENT'];
}

function seriesIcsEvent(uid: string, summary: string, startDateKey: string, rrule: string): string[] {
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    `DTSTART;VALUE=DATE:${icsDateKey(startDateKey)}`,
    `RRULE:${rrule}`,
    'END:VEVENT',
  ];
}

/** Fulfils every request to the SSRF-guarded proxy route with `body`, counting how often it was actually called. */
async function mockIcsFeed(page: Page, body: string): Promise<() => number> {
  let calls = 0;
  await page.route('**/api/ics**', (route) => {
    calls += 1;
    return route.fulfill({ status: 200, contentType: 'text/calendar', body });
  });
  return () => calls;
}

async function addIcsSubscription(page: Page, url: string, name: string): Promise<void> {
  await page.evaluate(({ url, name }) => window.__starship.addIcsSubscription(url, name), { url, name });
}

async function refreshIcsSubscriptions(page: Page): Promise<void> {
  await page.evaluate(() => window.__starship.refreshIcsSubscriptions());
}

test('ein abonnierter ganztägiger Termin erscheint schreibgeschützt und optisch abgesetzt im All-Day-Band (AK1)', async ({
  page,
}) => {
  await mockIcsFeed(page, icsFixture(singleDayIcsEvent('holiday-1', 'Nationalfeiertag', TODAY)));
  await addIcsSubscription(page, ICS_URL, 'Feiertage');
  await refreshIcsSubscriptions(page);

  const bar = allDayBar(page, 'Nationalfeiertag');
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute('data-origin', 'subscribed');
  // Editierbare Termine sind <button>, abonnierte <div> — die technische Basis
  // von AK2 (kein Editor-Zugriff).
  expect(await bar.evaluate((el) => el.tagName)).toBe('DIV');
});

test('ein Tap auf einen abonnierten Termin öffnet keinen Editor (AK2)', async ({ page }) => {
  await mockIcsFeed(page, icsFixture(singleDayIcsEvent('holiday-1', 'Nationalfeiertag', TODAY)));
  await addIcsSubscription(page, ICS_URL, 'Feiertage');
  await refreshIcsSubscriptions(page);

  await allDayBar(page, 'Nationalfeiertag').click();
  await expect(page.getByRole('dialog', { name: EDIT_LABEL })).toBeHidden();
});

test('ein Abo mit interner Zieladresse wird vom Proxy abgelehnt, kein Termin erscheint (AK3, SSRF)', async ({
  page,
}) => {
  // Kein page.route-Mock hier — die echte, SSRF-abgesicherte Node-Route
  // (src/app/api/ics/route.ts) muss selbst ablehnen, nicht ein Test-Double.
  await addIcsSubscription(page, 'https://127.0.0.1/feiertage.ics', 'Intern');
  await refreshIcsSubscriptions(page);

  await expect(page.locator('.event-agenda__all-day-button')).toHaveCount(0);

  await page.goto('/einstellungen');
  await expect(page.locator('.ics-subscriptions-panel__error')).toHaveText(
    'Zieladresse ist nicht öffentlich erreichbar.',
  );
});

test('eine Serie in der fremden ICS-Datei erscheint als expandierte Einzeltermine, nicht als eigene Serie (AK4)', async ({
  page,
}) => {
  await mockIcsFeed(page, icsFixture(seriesIcsEvent('daily-1', 'Aktionstag', TODAY, 'FREQ=DAILY;COUNT=3')));
  await addIcsSubscription(page, ICS_URL, 'Aktionstage');
  await refreshIcsSubscriptions(page);

  await expect(allDayBar(page, 'Aktionstag')).toBeVisible();

  await page.getByRole('button', { name: 'Nächster Tag' }).click();
  await expect(allDayBar(page, 'Aktionstag')).toBeVisible();

  await page.getByRole('button', { name: 'Nächster Tag' }).click();
  await expect(allDayBar(page, 'Aktionstag')).toBeVisible();

  // COUNT=3: der vierte Tag hat kein Vorkommen mehr — expandiert, nicht endlos.
  await page.getByRole('button', { name: 'Nächster Tag' }).click();
  await expect(allDayBar(page, 'Aktionstag')).toHaveCount(0);

  // Jedes einzelne Vorkommen bleibt schreibgeschützt, nicht nur das erste.
  await page.getByRole('button', { name: 'Vorheriger Tag' }).click();
  await allDayBar(page, 'Aktionstag').click();
  await expect(page.getByRole('dialog', { name: EDIT_LABEL })).toBeHidden();
});

test('abonnierte Termine rendern offline aus dem Cache, ohne eigenen Netzaufruf (DoD: Offline-Pfad)', async ({
  page,
}) => {
  // ADR-0009: abonnierte Termine werden nie synchronisiert — die DoD-Formel
  // "offline → online → serverseitig angekommen" ist hier N/A. Geprüft wird
  // stattdessen "rendert offline aus dem Cache, kein Netzaufruf" (derselbe
  // Aufbau wie weather-day.spec.ts's Offline-Test).
  const callCount = await mockIcsFeed(page, icsFixture(singleDayIcsEvent('holiday-1', 'Nationalfeiertag', TODAY)));
  await addIcsSubscription(page, ICS_URL, 'Feiertage');
  await refreshIcsSubscriptions(page);
  await expect(allDayBar(page, 'Nationalfeiertag')).toBeVisible();
  expect(callCount()).toBe(1);

  await page.unroute('**/api/ics**');
  await page.route('**/api/ics**', (route) => route.abort('failed'));
  const requestUrls: string[] = [];
  page.on('request', (request) => requestUrls.push(request.url()));

  await page.reload();

  await expect(allDayBar(page, 'Nationalfeiertag')).toBeVisible();
  expect(requestUrls.some((url) => url.includes('/api/ics'))).toBe(false);
});

/* -------------------------------------------------------------------------- */
/* issue #660: Kategoriefarben selbst wählen                                  */
/* -------------------------------------------------------------------------- */

/** Same path the settings panel's `setColor` takes (use-category-colors.ts). */
async function setCategoryColor(page: Page, category: string, color: string): Promise<void> {
  await page.evaluate(
    ({ category, color }) =>
      window.__starship.mutate({ table: 'category_colors', op: 'upsert', payload: { category, color } }),
    { category, color },
  );
}

test('eine geänderte Kategoriefarbe schlägt sofort auf die Terminkarte durch, ohne Reload (issue #660 AK4)', async ({
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
  const defaultEdge = await resolveCardColor(page, '--cat-arbeit', 'borderInlineStartColor');
  await expect
    .poll(() => card.evaluate((el) => getComputedStyle(el).borderInlineStartColor))
    .toBe(defaultEdge);

  await setCategoryColor(page, 'arbeit', '--swatch-sky');

  const expectedEdge = await resolveCardColor(page, '--swatch-sky', 'borderInlineStartColor');
  await expect
    .poll(() => card.evaluate((el) => getComputedStyle(el).borderInlineStartColor))
    .toBe(expectedEdge);
  expect(expectedEdge).not.toBe(defaultEdge);
});

test('ein frisches Gerät ohne gespeicherte Kategoriefarbe setzt nichts auf <html> und zeigt weiterhin den heutigen --cat-*-Wert (issue #660 AK5)', async ({
  page,
}) => {
  await seedEvent(page, {
    title: 'Laufrunde',
    allDay: false,
    startsAt: `${TODAY}T09:00:00.000Z`,
    endsAt: `${TODAY}T10:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: 'sport',
  });

  const card = eventCard(page, 'Laufrunde');
  const expectedEdge = await resolveCardColor(page, '--cat-sport', 'borderInlineStartColor');
  await expect
    .poll(() => card.evaluate((el) => getComputedStyle(el).borderInlineStartColor))
    .toBe(expectedEdge);

  // CategoryColorsBoot is mounted (layout.tsx) but resetAppData left no
  // category_colors rows — it must never have called setProperty for 'sport'.
  const inlineOverride = await page.evaluate(() =>
    document.documentElement.style.getPropertyValue('--cat-sport'),
  );
  expect(inlineOverride).toBe('');
});

test('eine Kategoriefarbe gilt im Dark Mode mit dem dunklen Wert des gewählten Tokens, nicht dem hellen (issue #660 AK7)', async ({
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

  await setCategoryColor(page, 'arbeit', '--swatch-sky');

  const card = eventCard(page, 'Teammeeting');
  const expectedLight = await resolveCardColor(page, '--swatch-sky', 'borderInlineStartColor');
  await expect
    .poll(() => card.evaluate((el) => getComputedStyle(el).borderInlineStartColor))
    .toBe(expectedLight);

  await page.emulateMedia({ colorScheme: 'dark' });
  const expectedDark = await resolveCardColor(page, '--swatch-sky', 'borderInlineStartColor');
  await expect
    .poll(() => card.evaluate((el) => getComputedStyle(el).borderInlineStartColor))
    .toBe(expectedDark);
  expect(expectedDark).not.toBe(expectedLight);
});
