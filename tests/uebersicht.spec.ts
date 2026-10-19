import { expect, test, type Locator, type Page } from '@playwright/test';
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

function undatedCard(page: Page) {
  return page.getByRole('button', { name: /Aufgabe(n)? ohne Datum/ });
}

/** Content anchor for the Routinen section (issue #972 AK2: the module keeps
 * a visible title, in its own card head; issue #995 merged that head into the
 * same card as the check-off list, so this now points at the whole card). */
function routinenHead(page: Page): Locator {
  return page.locator('.habit-today');
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

test('der Aufgaben-Leerzustand steht auf einer eigenen Fläche wie die Routinen-Karte, nicht mehr frei auf dem Seitengrund (issue #1217 AK1)', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  // Genau eine Fläche, keine freistehende Nachricht mehr daneben.
  const surface = page.locator('.task-list__surface');
  await expect(surface).toHaveCount(1);
  await expect(surface.getByText('Nichts fällig in den nächsten 7 Tagen.')).toBeVisible();

  // Eigene Tinte wie `.habit-today` (Radius, Schatten) statt einer bloßen Notiz.
  const habitCard = routinenHead(page);
  const [surfaceStyle, habitStyle] = await Promise.all([
    surface.evaluate((el) => {
      const style = getComputedStyle(el);
      return { radius: style.borderRadius, shadow: style.boxShadow };
    }),
    habitCard.evaluate((el) => {
      const style = getComputedStyle(el);
      return { radius: style.borderRadius, shadow: style.boxShadow };
    }),
  ]);
  expect(surfaceStyle).toEqual(habitStyle);
});

test('der Aufgaben-Leerzustand zeigt den Kartenkopf „Aufgaben" mit dem Link „Alle" nach /aufgaben, und nur eine Überschrift (issue #1217 AK2)', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  const heading = page.getByRole('heading', { name: 'Aufgaben', level: 2 });
  await expect(heading).toHaveCount(1);
  await expect(heading).not.toHaveClass(/visually-hidden/);
  await expect(heading).toHaveAttribute('id', 'uebersicht-aufgaben-heading');

  const link = page.locator('.task-list__surface').getByRole('link', { name: 'Alle' });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', '/aufgaben');
  await link.click();
  await expect(page).toHaveURL(/\/aufgaben$/);
});

test('die „ohne Datum"-Zeile steht in derselben Fläche als letzter Abschnitt unter dem Leerzustand-Text (issue #1217 AK5)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Ohne Datum' });

  const surface = page.locator('.task-list__surface');
  await expect(surface).toHaveCount(1);
  const emptyTextBox = await surface.getByText('Nichts fällig in den nächsten 7 Tagen.').boundingBox();
  const undatedBox = await undatedCard(page).boundingBox();
  if (!emptyTextBox || !undatedBox) throw new Error('Text und Ausklappzeile müssen sichtbar sein');
  expect(undatedBox.y, 'die Ausklappzeile steht unter dem Leerzustand-Text').toBeGreaterThan(
    emptyTextBox.y,
  );
});

test('die Aufgaben-Leerzustandskarte ist auf dem Desktop so breit wie die Routinen-Karte (issue #1217 AK6)', async ({
  page,
}) => {
  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/uebersicht');

    const surfaceBox = await page.locator('.task-list__surface').boundingBox();
    const habitBox = await routinenHead(page).boundingBox();
    if (!surfaceBox || !habitBox) throw new Error('Beide Karten müssen sichtbar sein');
    expect(surfaceBox.width, `Breite bei ${width}px`).toBeCloseTo(habitBox.width, 0);
  }
});

async function seedHabit(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'habits', op: 'upsert', payload: p }),
    payload,
  );
}

test('der Kopf „Aufgaben / Alle" der leeren Karte sitzt genauso eingerückt wie der Kopf „Routinen" (issue #1228 AK1/AK2)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  // "Alle" existiert immer; die Routinen-Karte zeigt ihren rechten Link nur,
  // wenn mindestens eine Routine fällig ist (computeHabitProgress) — ohne
  // Routine (dieses Spec blockt **/api/sync/**, also läuft JournalHabitBoot
  // nie an, e2e-Fallen #9) gäbe es nichts, dessen rechten Rand man vergleichen
  // könnte. Direkt über die Outbox geseedet, nicht über den Sync-Pfad.
  await seedHabit(page, { name: 'Testroutine', schedule: 'daily', color: null, archivedAt: null });

  const taskSurface = page.locator('.task-list__surface');
  const taskHead = taskSurface.locator('.overview-block__head');
  const taskTitle = taskHead.locator('.overview-block__title');
  const taskLink = taskHead.locator('.overview-block__more');

  const habitCard = routinenHead(page);
  const habitHead = habitCard.locator('.overview-block__head');
  const habitTitle = habitHead.locator('.overview-block__title');
  const habitLink = habitHead.locator('.overview-block__more');
  await expect(habitLink).toBeVisible();

  const [surfaceBox, titleBox, linkBox, habitBox, habitTitleBox, habitLinkBox] = await Promise.all([
    taskSurface.boundingBox(),
    taskTitle.boundingBox(),
    taskLink.boundingBox(),
    habitCard.boundingBox(),
    habitTitle.boundingBox(),
    habitLink.boundingBox(),
  ]);
  if (!surfaceBox || !titleBox || !linkBox || !habitBox || !habitTitleBox || !habitLinkBox) {
    throw new Error('Beide Kartenköpfe müssen sichtbar sein');
  }

  // AK1: linker Abstand von „Aufgaben" und rechter Abstand von „Alle" zur
  // jeweiligen Kartenkante, Toleranz 1px wie in der Akzeptanzbeschreibung.
  expect(
    Math.abs(titleBox.x - surfaceBox.x - (habitTitleBox.x - habitBox.x)),
    'linker Abstand von „Aufgaben" vs. „Routinen"',
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(
      surfaceBox.x + surfaceBox.width - (linkBox.x + linkBox.width) -
        (habitBox.x + habitBox.width - (habitLinkBox.x + habitLinkBox.width)),
    ),
    'rechter Abstand von „Alle" vs. der Routinen-Zahl',
  ).toBeLessThanOrEqual(1);

  // AK2: oberer Abstand des Kopfs zur jeweiligen Kartenkante.
  expect(
    Math.abs(titleBox.y - surfaceBox.y - (habitTitleBox.y - habitBox.y)),
    'oberer Abstand des Kopfs vs. der Routinen-Karte',
  ).toBeLessThanOrEqual(1);
});

test('eine gefüllte Aufgaben-Woche behält ihren einfachen Einzug, kein doppelter Rand durch die Kopf-Korrektur (issue #1228 AK3)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Heute fällig', dueAt: TODAY_EVENING });
  await expect(dueTaskItems(page)).toHaveCount(1);

  // Die Elemente selbst reichen randlos bis an die Fläche (sie tragen ihr
  // `--space-4` als eigenes `padding`, nicht als Versatz der eigenen Box) —
  // der Einzug steckt im berechneten `padding-left`, nicht in `boundingBox()`.
  const [headerPaddingLeft, itemPaddingLeft] = await Promise.all([
    page.locator('.task-list__group-header').evaluate((el) => getComputedStyle(el).paddingLeft),
    dueTaskItems(page).first().evaluate((el) => getComputedStyle(el).paddingLeft),
  ]);

  // --space-4 (16px), einmal — nicht verdoppelt (issue #866). Der neue
  // seitliche Kopf-Einzug der Leerzustandskarte (issue #1228) ist in
  // task-list.css strikt auf `.task-list__surface > .overview-block__head`
  // begrenzt und berührt diese Selektoren nicht — dies ist der Gegenbeweis.
  expect(headerPaddingLeft, 'Einzug des Gruppenkopfs').toBe('16px');
  expect(itemPaddingLeft, 'Einzug der Aufgabenzeile').toBe('16px');
});

test('die reservierte Höhe der leeren Aufgaben-Karte bleibt durch den neuen seitlichen Kopf-Einzug unverändert (issue #1228 AK4, vormals #228 AC6/#1217 AK4)', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  const surface = page.locator('.task-list__surface');
  const withPadding = await surface.boundingBox();
  if (!withPadding) throw new Error('Leere Karte muss sichtbar sein');

  // Schaltet nur die neue CSS-Regel aus diesem Ticket ab, um isoliert zu
  // zeigen, dass sie die Höhe nicht verändert — ein `padding-inline` kann das
  // nur über Zeilenumbruch tun, und bei "Aufgaben"/"Alle" bricht bei 375px
  // nichts um.
  await page.addStyleTag({
    content: '.task-list__surface > .overview-block__head { padding-inline: 0 !important; }',
  });
  const withoutPadding = await surface.boundingBox();
  if (!withoutPadding) throw new Error('Leere Karte muss sichtbar bleiben');

  expect(
    Math.abs(withPadding.height - withoutPadding.height),
    'Höhe mit vs. ohne den neuen Kopf-Einzug',
  ).toBeLessThanOrEqual(1);
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
