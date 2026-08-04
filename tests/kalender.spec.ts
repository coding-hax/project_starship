import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  freezeClock,
  installClockAt,
  registerPasskey,
  resetAppData,
  skewClock,
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
/* #554 (S3): Termin-Editor — Anlegen, Ändern, Löschen, offline, ganztägig    */
/* -------------------------------------------------------------------------- */

const CREATE_LABEL = 'Termin erfassen';
const EDIT_LABEL = 'Termin bearbeiten';

test('ein neu angelegter Termin erscheint sofort in der Timeline (#554 AC1)', async ({ page }) => {
  await page.getByRole('button', { name: CREATE_LABEL }).click();
  await expect(page.getByRole('dialog', { name: CREATE_LABEL })).toBeVisible();

  await page.getByLabel('Titel').fill('Zahnarzttermin');
  // Mittags gefüllt (TZ-robust, siehe Testplan) — Sichtbarkeit ist die Aussage,
  // nicht die exakte Stundenposition (die deckt schon kalender.spec.ts's AC1 ab).
  await page.getByLabel('Von').fill(`${TODAY}T12:00`);
  await page.getByLabel('Bis').fill(`${TODAY}T13:00`);
  await page.getByLabel('Kategorie').selectOption('gesundheit');
  await page.getByRole('button', { name: 'Speichern' }).click();

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

  await eventCard(page, 'Altes Meeting').click();
  await expect(page.getByRole('dialog', { name: EDIT_LABEL })).toBeVisible();
  await expect(page.getByLabel('Titel')).toHaveValue('Altes Meeting');

  await page.getByLabel('Titel').fill('Neues Meeting');
  await page.getByRole('button', { name: 'Speichern' }).click();

  await expect(eventCard(page, 'Neues Meeting')).toBeVisible();
  await expect(eventCard(page, 'Altes Meeting')).toHaveCount(0);
});

test('das Löschen eines Termins zeigt einen Undo-Toast, der ihn zurückholt (#554 AC3)', async ({
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

  await eventCard(page, 'Zu löschen').click();
  const editDialog = page.getByRole('dialog', { name: EDIT_LABEL });
  await expect(editDialog).toBeVisible();
  // Scoped to the dialog, not a bare page-wide query — the card itself is a
  // <button> whose accessible name contains the event's own title, and this
  // test's title happens to contain the substring "löschen" too (Playwright's
  // `name` match is substring, case-insensitive by default).
  await editDialog.getByRole('button', { name: 'Löschen' }).click();

  await expect(eventCard(page, 'Zu löschen')).toHaveCount(0);
  const undoToast = page.getByRole('status').filter({ hasText: 'gelöscht' });
  await expect(undoToast).toBeVisible();

  await undoToast.getByRole('button', { name: 'Rückgängig' }).click();
  await expect(eventCard(page, 'Zu löschen')).toBeVisible();
  await expect(undoToast).toHaveCount(0);
});

test('ein offline angelegter Termin steht sofort lokal und erreicht nach dem Onlinegehen die echte Datenbank (#554 AC4)', async ({
  page,
  context,
}) => {
  await context.setOffline(true);

  await page.getByRole('button', { name: CREATE_LABEL }).click();
  await page.getByLabel('Titel').fill('Im Zug erfasst');
  await page.getByLabel('Von').fill(`${TODAY}T12:00`);
  await page.getByLabel('Bis').fill(`${TODAY}T13:00`);
  await page.getByRole('button', { name: 'Speichern' }).click();

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
