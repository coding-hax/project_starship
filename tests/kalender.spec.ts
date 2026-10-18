import { expect, test, type Locator, type Page } from '@playwright/test';
import { weekDaysFor } from '@/features/events/event-time';
import {
  addIcsSubscription,
  icsFixture,
  installClockAt,
  mockIcsFeed,
  refreshIcsSubscriptions,
  registerPasskey,
  resetAppData,
  singleDayIcsEvent,
  withDb,
} from './helpers';

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

function calendarStrip(page: Page) {
  return page.locator('.calendar-strip');
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

/** The month card in the body (issue #958) — the month view's only calendar
 *  surface; a continuously scrolling, buffered track of week rows since issue
 *  #1064 (it was a three-month snap carousel under #1009/#1039). */
function monthGrid(page: Page) {
  return page.locator('.month-grid');
}

/**
 * A day button *inside the card's visible band* — scoping to
 * `.month-grid__week:not([inert])` matters because the buffered track (issue
 * #1064) keeps a year of week rows either side of the anchor in the DOM, so
 * scrolling never runs out of weeks. The rows outside the visible band stay
 * in the document but are `inert` + `aria-hidden`, and without the scope a
 * label like "Mo, 3." would match once per month across the whole buffer and
 * trip Playwright's strict mode.
 */
function monthGridDay(page: Page, ariaLabel: string) {
  return page.locator(`.month-grid__week:not([inert]) .month-grid__day[aria-label="${ariaLabel}"]`);
}

/** The month card's continuously scrolling track of week rows (issue #1064,
 *  replacing #1009/#1039's three snap pages) — unlike `calendarWeeks`, which
 *  stays horizontal. */
function monthGridTrack(page: Page) {
  return page.locator('.month-grid__track');
}

/**
 * Scrolls the track so the week starting on `monday` becomes its topmost row.
 * Reads the row's own `offsetTop` rather than multiplying a row height: rows
 * differ in height, a week carrying all-day bands is taller (issue #1043,
 * AK9).
 */
async function scrollMonthGridTo(page: Page, monday: string): Promise<void> {
  await monthGridTrack(page).evaluate((el, key) => {
    const row = el.querySelector<HTMLElement>(`.month-grid__week[data-week="${key}"]`);
    if (!row) throw new Error(`Wochenzeile ${key} liegt nicht im Puffer`);
    // Abstand der Zeile zur Spuroberkante auf die aktuelle Position addieren.
    // `row.offsetTop` waere falsch: es zaehlt ab dem naechsten *positionierten*
    // Vorfahren, und das ist nicht die Spur — der Wert truege die Strecke der
    // Karte die Seite hinunter mit sich und scrollte rund vier Zeilen zu weit.
    el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top;
  }, monday);
}

/**
 * Scrolls the month card on by exactly one month — the free-scrolling
 * successor of the page swipe #1009/#1039 had, kept under the same name so
 * the tests that only care about "a month further on" read unchanged (issue
 * #1064 removed the pages themselves). Puts the week holding the target
 * month's 15th in the middle of the visible band, which is the row
 * month-grid.tsx reads the focused month off, then waits for
 * `data-focus-month` to follow.
 */
async function pageMonth(page: Page, dir: 1 | -1): Promise<void> {
  const before = await monthGrid(page).getAttribute('data-focus-month');
  const [year, month] = (before ?? '').split('-').map(Number);
  const firstOfTarget = new Date(Date.UTC(year, month - 1 + dir, 1)).toISOString().slice(0, 10);
  // Die Woche mit dem Monatsersten nach oben — derselbe Ausschnitt, den die
  // alte Monatsseite zeigte (sechs Wochen ab dem Monatsanfang, inklusive der
  // gedaempften Randtage des Folgemonats), und die Mitte davon liegt immer im
  // Zielmonat, woran month-grid.tsx den Fokusmonat ablieszt.
  await scrollMonthGridTo(page, weekDaysFor(firstOfTarget)[0]);
  await expect
    .poll(() => monthGrid(page).getAttribute('data-focus-month'))
    .toBe(firstOfTarget.slice(0, 7));
}

/**
 * Taps a day button in the strip if it's currently in the interactive band
 * (`dayButton`'s `:not([inert])` scope reports it as not visible otherwise,
 * issue #813); if it isn't, picks the day off the month card instead (issue
 * #958 Stufe B removed the strip's own month carousel, so a day outside the
 * visible week no longer has a `.calendar-strip__day` at all) and switches
 * back to Woche afterwards, mirroring the old carousel's auto-collapse
 * (issue #629).
 */
async function selectStripDay(page: Page, ariaLabel: string): Promise<void> {
  const button = dayButton(page, ariaLabel);
  if (await button.isVisible()) {
    await button.click();
    return;
  }
  await page.getByRole('radio', { name: 'Monat' }).click();
  await monthGridDay(page, ariaLabel).click();
  await page.getByRole('radio', { name: 'Woche' }).click();
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // The timeline must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  // Before the first navigation (helpers.ts doc) — registerPasskey below may itself navigate.
  await installClockAt(page);
  await registerPasskey(page, '/kalender');
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
  await expect(card.locator('.event-agenda__item-time')).toHaveText('09:00');
  // Die Endzeit steht nicht mehr in der Kopfzeile, sondern als Dauer in der
  // Zweitzeile (AK2) — ohne Kategorie steht dort nur die Dauer.
  await expect(card.locator('.event-agenda__item-subline')).toHaveText('1 Std');
  await expect(card).not.toContainText('09:00–10:00');

  // Chronological order in the DOM, not insertion order (AK1).
  const titles = await page.locator('.event-agenda__item').allTextContents();
  expect(titles[0]).toContain('Zahnarzt');
  expect(titles[1]).toContain('Nachmittagstermin');
});

/* -------------------------------------------------------------------------- */
/* AC4: Wochenstreifen blaettert                                             */
/* -------------------------------------------------------------------------- */

test('ein Tipp auf einen Tag im Wochenstreifen waehlt ihn, die Timeline wechselt entsprechend, ohne den Streifen zu verschieben (issue #1009, AK3)', async ({
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

  const anchorBefore = await anchorDay(page);

  await expect(eventCard(page, 'Heute-Termin')).toBeVisible();
  await expect(eventCard(page, 'Morgen-Termin')).toHaveCount(0);

  await selectStripDay(page, 'So, 19.');
  await expect(eventCard(page, 'Morgen-Termin')).toBeVisible();
  await expect(eventCard(page, 'Heute-Termin')).toHaveCount(0);
  // Der Tipp waehlt nur aus — die sieben sichtbaren Tage bleiben exakt
  // dieselben, der Anker (die fuehrende Zelle) ruehrt sich nicht.
  await expect(anchorDay(page)).resolves.toBe(anchorBefore);
  await expect(dayButton(page, 'Sa, 18.')).toBeVisible();

  await selectStripDay(page, 'Sa, 18.');
  await expect(eventCard(page, 'Heute-Termin')).toBeVisible();
  await expect(eventCard(page, 'Morgen-Termin')).toHaveCount(0);
  await expect(anchorDay(page)).resolves.toBe(anchorBefore);
});

/* -------------------------------------------------------------------------- */
/* issue #813: der Wochenstreifen bleibt reiner Wochenstreifen (Stufe B/#958) */
/* -------------------------------------------------------------------------- */

// Die sechs vertikalen Monats-Karussell-Tests, die hier bis #958 standen
// (senkrechtes Wochen-Wisch-Rollen, Achsensperre, Randdurchgang-Puffer,
// scrollend-Fallback), sind mit dem Rueckbau des Streifen-Karussells im
// Monat (Stufe B, 904c9fe) ersatzlos gegenstandslos: der Streifen rendert im
// Monat nicht mehr, die neue Monats-Karte (.month-grid) ist statisch und
// nicht wischbar. Ihr Verhalten ist durch die Karten-Tests weiter unten
// (AK1/AK2/AK3/AK5/AK7/AK8 + Monatsnav) abgedeckt — siehe Fortschrittskommentar
// an #958 fuer die Einzelbegruendung je Test.

test('Antippen eines Tages in der Monats-Karte waehlt ihn, die Karte bleibt sichtbar und die Agenda zeigt den Tag (issue #765/#958)', async ({
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

  await page.getByRole('radio', { name: 'Monat' }).click();
  await expect(monthGrid(page)).toBeVisible();

  const day = monthGridDay(page, 'Mi, 22.');
  await day.click();

  await expect(monthGrid(page)).toBeVisible();
  await expect(day).toHaveAttribute('aria-pressed', 'true');
  await expect(eventCard(page, 'Monatstag-Termin')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* #628: Kopf ohne Spruenge — Monatstitel, Umschalter                        */
/* -------------------------------------------------------------------------- */

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

test('AK7: ein offline angelegter ganztaegiger Termin steht sofort lokal im Band und erreicht nach dem Onlinegehen die echte Datenbank', async ({
  page,
  context,
}) => {
  await context.setOffline(true);

  await page.getByRole('button', { name: CREATE_LABEL }).click();
  await page.getByLabel('Titel').fill('Ganztags im Zug erfasst');
  await wannChip(page).click();
  await page.getByRole('switch', { name: 'Ganztägig' }).click();
  await page.getByLabel('Von').fill(TODAY);
  await page.getByLabel('Bis').fill(TODAY);
  await page.getByRole('button', { name: 'Anlegen' }).click();

  await expect(allDayBar(page, 'Ganztags im Zug erfasst')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  // beforeEach cuts the sync endpoints so the timeline can only ever come from
  // IndexedDB — lift that here to let the queued mutation actually reach Postgres.
  await page.unroute('**/api/sync/**');
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT title FROM events WHERE title = $1', ['Ganztags im Zug erfasst']),
  );
  expect(row.rowCount).toBe(1);
});

/* -------------------------------------------------------------------------- */
/* #557 (S6): Serientermine + Ausnahmen                                       */
/* -------------------------------------------------------------------------- */

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

test('„nur dieser" schreibt die Ausnahme in event_exceptions, die online in Postgres ankommt', async ({
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

  // "Nur dieser" schreibt in `event_exceptions`, nicht `events` — der einzige
  // Schreibweg in diese Tabelle. Beleg, dass die Ausnahme online ankommt.
  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query(
      `SELECT ee.cancelled FROM event_exceptions ee
       JOIN events e ON e.id = ee.event_id
       WHERE e.title = $1`,
      ['Yoga'],
    ),
  );
  expect(row.rows[0].cancelled).toBe(true);
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

  // `splitSeries` inserts a new `events` row for the tail, so this occurrence's
  // id changes — the old (18:00) card is still mid-exit-animation right after
  // the click, `settledEventCard` (see its doc comment) is needed here or
  // `eventCard` hits the same title on both and violates Strict Mode.
  await expect(settledEventCard(page, 'Yoga')).toContainText('19:00');

  // A further week on, the change still applies.
  await selectStripDay(page, 'Sa, 1.');
  await expect(eventCard(page, 'Yoga')).toContainText('19:00');

  // Back on the series' own first occurrence, the original time survives —
  // ohne "Heute"-Knopf (#1009) geht der weite Sprung zurueck ueber die
  // Monats-Karte: einen Monat zurueckwischen (August -> Juli), dann den Tag
  // antippen. Die Serie wurde auf TODAY gesat.
  await page.getByRole('radio', { name: 'Monat' }).click();
  await pageMonth(page, -1);
  await monthGridDay(page, 'Sa, 18.').click();
  await page.getByRole('radio', { name: 'Woche' }).click();
  await expect(eventCard(page, 'Yoga')).toContainText('18:00');
});

/* -------------------------------------------------------------------------- */
/* #712: Termin-Sheet auf Zeile und Chips                                     */
/* -------------------------------------------------------------------------- */

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

/**
 * Wie `eventCard`, aber ohne das gerade abziehende Exemplar. Springt man in
 * einem Klick von einem Vorkommen direkt zum nächsten, hält `useListPresence`
 * die alte Karte bis zum Ende ihrer Exit-Animation im DOM — beide tragen
 * denselben Titel, und `eventCard` verletzt dann Playwrights Strict Mode.
 * (Die S6-Tests für "nur dieser"/"ausfallen lassen" laufen über
 * `event_exceptions`-Overrides mit gleichbleibender Occurrence-id und treffen
 * das nicht. "Alle folgenden" (AC5) schon — `splitSeries` legt für den
 * abgespaltenen Teil eine neue `events`-Zeile an, die Occurrence-id wechselt
 * also mit.)
 */
function settledEventCard(page: Page, title: string) {
  return page
    .locator('.event-agenda__item:not([data-leaving="true"])')
    .filter({ hasText: title });
}

/* -------------------------------------------------------------------------- */
/* ICS-Abo, schreibgeschützt (issue #560, ADR-0022)                           */
/* -------------------------------------------------------------------------- */

const ICS_URL = 'https://example.com/feiertage.ics';

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
