import { expect, test, type Page } from '@playwright/test';
import {
  addIcsSubscription,
  freezeClock,
  icsFixture,
  mockIcsFeed,
  refreshIcsSubscriptions,
  registerPasskey,
  resetAppData,
  singleDayIcsEvent,
  skewClock,
} from './helpers';

/** Fixes "now" so due-today vs. overdue vs. future is deterministic (issue #87). */
const NOW = '2026-07-18T12:00:00.000Z';
const YESTERDAY_MORNING = '2026-07-17T09:00:00.000Z';
const YESTERDAY_EVENING = '2026-07-17T18:00:00.000Z';
const TODAY_EVENING = '2026-07-18T18:00:00.000Z';
const TOMORROW_MORNING = '2026-07-19T09:00:00.000Z';
/** Innerhalb des 7-Tage-Fensters (heute + 2), aber weder heute noch morgen (issue #762). */
const WITHIN_WEEK = '2026-07-20T09:00:00.000Z';
/** Außerhalb des 7-Tage-Fensters (heute + 9) — der 25.07. (heute + 7) ist die erste
 *  ausgeschlossene Kalendertag-Grenze, dieses Datum liegt sicher jenseits davon. */
const BEYOND_WEEK = '2026-07-27T09:00:00.000Z';
const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';

function dueTaskItems(page: Page) {
  // Own `aria-label` "Aufgaben der nächsten 7 Tage" (issue #979 AK3), matched
  // here by the "Aufgaben" substring (issue #157). A group's outer `<li>`
  // renders `role="presentation"` (task-list.tsx, issue #866), so it never
  // counts as a `listitem` here — only the task rows nested inside it do.
  return page.getByRole('list', { name: 'Aufgaben' }).getByRole('listitem');
}

/** A group's title (issue #866) — "Überfällig"/"Heute"/"7 Tage". */
function groupTitles(page: Page) {
  return page.locator('.task-list__group-title');
}

async function seedTask(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: p }),
    payload,
  );
}

async function seedEvent(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'events', op: 'upsert', payload: p }),
    payload,
  );
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // The list must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  // Default: abort, like weather.spec.ts (the real API is never reachable from a
  // spec). registerPasskey below already lands on /uebersicht, which fires the first
  // forecast fetch — without this, that request would hit the real network and
  // cache real data before a per-test mock ever gets a chance to register.
  await page.route(OPEN_METEO_PATTERN, (route) => route.abort('failed'));
  await registerPasskey(page);
  await skewClock(page, NOW);
});

test('/uebersicht zeigt die Woche-Ansicht — überfällig, heute und die 6 folgenden Tage, in Karten gebündelt (issue #87 AC1, erweitert auf die Woche durch issue #762, drei feste Bucket-Karten seit issue #866)', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  await seedTask(page, { title: 'Überfällig', dueAt: YESTERDAY_MORNING });
  await seedTask(page, { title: 'Heute fällig', dueAt: TODAY_EVENING });
  await seedTask(page, { title: 'Diese Woche fällig', dueAt: WITHIN_WEEK });
  await seedTask(page, { title: 'Außerhalb der Woche', dueAt: BEYOND_WEEK });
  await seedTask(page, { title: 'Ohne Fälligkeit' });
  await seedTask(page, {
    title: 'Heute erledigt',
    dueAt: YESTERDAY_MORNING,
    completedAt: NOW,
  });
  await seedTask(page, {
    title: 'Gestern erledigt',
    dueAt: YESTERDAY_MORNING,
    completedAt: YESTERDAY_EVENING,
  });
  // Anders als die alte, auf "heute oder früher" begrenzte Regel (issue #228 AC4):
  // `weekWindowNodes`s AK7-Regel (issue #705) gilt jetzt auch hier — innerhalb des
  // Fensters fällig und heute erledigt reicht, das Fälligkeitsdatum selbst darf in
  // der Zukunft liegen.
  await seedTask(page, {
    title: 'Morgen fällig, heute erledigt',
    dueAt: TOMORROW_MORNING,
    completedAt: NOW,
  });

  await expect(page.getByText('Überfällig').first()).toBeVisible();
  await expect(page.getByText('Heute fällig')).toBeVisible();
  await expect(page.getByText('Diese Woche fällig')).toBeVisible();
  // Checked off today, so it stays for the rest of the day (issue #228 AC1).
  // exact: true — 'Morgen fällig, heute erledigt' below is a substring match otherwise.
  // Scoped to the task list — the Wide-Segmentring's side label (issue #1122)
  // renders the same text "Heute erledigt", just hidden via display:none below
  // 1440px. It stays in the DOM, so an unscoped getByText resolves to both.
  await expect(
    dueTaskItems(page).getByText('Heute erledigt', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Morgen fällig, heute erledigt')).toBeVisible();
  await expect(dueTaskItems(page)).toHaveCount(5);
  await expect(page.getByText('Außerhalb der Woche')).toHaveCount(0);
  // Undatiert steht nicht in der Liste — nur in der ausklappbaren Karte (issue #762).
  await expect(dueTaskItems(page).filter({ hasText: 'Ohne Fälligkeit' })).toHaveCount(0);
  await expect(page.getByText('Gestern erledigt')).toHaveCount(0);

  // Karten: Überfällig zuerst, dann Heute/7 Tage (issue #762, drei feste
  // Buckets statt einer Marke je Tag seit issue #866).
  const titles = groupTitles(page);
  await expect(titles.first()).toHaveText('Überfällig');
  await expect(titles.last()).toHaveText('7 Tage');
});

/* -------------------------------------------------------------------------- */
/* issue #974 (T3 von #971): "Nächster Termin" im Blatt-Aufbau — die Uhrzeit  */
/* trägt die Zeile. Ersetzt den #559-Aufbau (Countdown oben, Zeitraum unten). */
/* -------------------------------------------------------------------------- */

test('AK6: der Countdown über der Startzeit aktualisiert sich mit der Zeit, ohne dass die Seite neu lädt (issue #974/#1183, vormals #559 AC4)', async ({
  page,
}) => {
  // Must be installed before this goto — useNow's setInterval is registered on
  // whatever clock is active at mount time, so the beforeEach's skewClock (only
  // setFixedTime, timers stay real, see its own doc comment) would leave it
  // uncontrolled and fastForward below would never reach it (same gotcha as
  // toast.spec.ts's AC4 auto-dismiss test).
  await page.clock.install({ time: new Date(NOW) });
  await page.goto('/uebersicht');
  await seedEvent(page, {
    title: 'Zahnarzt',
    allDay: false,
    startsAt: '2026-07-18T12:40:00.000Z',
    endsAt: '2026-07-18T13:10:00.000Z',
    startDate: null,
    endDate: null,
    category: null,
  });

  const countdown = page.locator('.events-overview__next-countdown');
  await expect(countdown).toHaveText('in 40 Min');

  await freezeClock(page);
  await page.clock.fastForward(10 * 60 * 1000);

  await expect(countdown).toHaveText('in 30 Min');
});

/* -------------------------------------------------------------------------- */
/* issue #1091: "Nächster Termin" schaut über den heutigen Tag hinaus —       */
/* Serien, abonnierte ICS-Termine und ganztägige Termine zählen jetzt mit.    */
/* -------------------------------------------------------------------------- */

test('AK2 (issue #1091): eine wöchentliche Serie zählt mit, eine abgesagte Instanz wird übersprungen', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const seriesId = await seedEvent(page, {
    title: 'Yoga',
    allDay: false,
    startsAt: '2026-07-11T08:00:00.000Z', // Sa 11.07., 10:00 Berlin — Anker in der Vergangenheit.
    endsAt: '2026-07-11T09:00:00.000Z',
    startDate: null,
    endDate: null,
    category: null,
    recurrence: { freq: 'weekly', interval: 1 },
  });

  const next = page.locator('.events-overview__next');
  // Die eigene Instanz vom 18.07. (10-11 Uhr Berlin) ist bei NOW (14 Uhr) schon
  // vorbei — die nächste liegt eine Woche später, am 25.07.
  await expect(next).toContainText('Yoga');
  await expect(next.locator('.events-overview__next-range')).toContainText('25.07.');

  await page.evaluate(
    (eventId) =>
      window.__starship.mutate({
        table: 'event_exceptions',
        op: 'upsert',
        payload: {
          eventId,
          originalDate: '2026-07-25',
          cancelled: true,
          overrideStartsAt: null,
          overrideEndsAt: null,
          overrideStartDate: null,
          overrideEndDate: null,
        },
      }),
    seriesId,
  );

  await expect(next.locator('.events-overview__next-range')).toContainText('01.08.');
});

test('AK3 (issue #1091): ein abonnierter ICS-Termin zählt mit', async ({ page }) => {
  await page.goto('/uebersicht');
  await mockIcsFeed(page, icsFixture(singleDayIcsEvent('holiday-1', 'Nationalfeiertag', '2026-07-20')));
  await addIcsSubscription(page, 'https://example.com/feiertage.ics', 'Feiertage');
  await refreshIcsSubscriptions(page);

  await expect(page.locator('.events-overview__next')).toContainText('Nationalfeiertag');
});

test('AK4 (issue #1091): ein mehrtägiger ganztägiger Termin, der heute schon läuft, gilt als der nächste Termin', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedEvent(page, {
    title: 'Urlaub',
    allDay: true,
    startsAt: null,
    endsAt: null,
    startDate: '2026-07-16',
    endDate: '2026-07-20',
    category: null,
  });

  const next = page.locator('.events-overview__next');
  await expect(next).toContainText('Urlaub');
  // "bis 20.07." statt nur "Heute" — der Termin läuft noch 2 weitere Tage (issue #1187 AK4).
  await expect(next.locator('.events-overview__next-range')).toHaveText('Heute · bis Mo, 20.07.');
});
