import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  FIXED_NOW,
  installClockAt,
  openMeteoForecastBody,
  registerPasskey,
  resetAppData,
  withDb,
} from './helpers';

/**
 * Halbhoher Seitenkopf (issue #833, S2 von #828): Titelzone direkt auf dem
 * Vollfarb-Grund aus #832, ohne Verlaufsblock, mit halbierten Titelgraden.
 * Ein Test je AK — Messung per getComputedStyle/BoundingBox, keine Sichtprüfung
 * (genau daran ist der Entwurf laut Ticket zweimal gescheitert).
 */

const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';
const GARMIN_SYNC_PATTERN = '**/api/garmin-sync';
const SYNC_COUNTERS = { scanned: 0, created: 0, updated: 0, detailsFilled: 0, mapsFilled: 0 };
// Volle Woche statt eines einzelnen Tages: useWeatherForecast cached die erste
// Antwort und fetcht erst nach REFRESH_INTERVAL_MS neu (ADR-0009) — ein zweiter,
// anders gemockter /uebersicht-Besuch später im selben Test würde die alten
// Daten trotzdem weiter anzeigen. Die Vorschau rendert ein <li> je Tag
// (weather-forecast.tsx), der Titelgrößen-Test prüft auf 7.
const FORECAST_WEEK = [
  '2026-07-15',
  '2026-07-16',
  '2026-07-17',
  '2026-07-18',
  '2026-07-19',
  '2026-07-20',
  '2026-07-21',
];

/** Langes Datumsformat der `PageHead`-Augenbraue (`TodayLongDate`, issue #868). */
const EYEBROW_DATE_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // Wie grundfarbe.spec.ts: /uebersicht und /aktivitaeten lösen beim Laden echte
  // Netzaufrufe aus, die ungemockt als Konsolenfehler/Dev-Overlay im DOM landen.
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

async function seedTask(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: p }),
    payload,
  );
}

async function seedHabit(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'habits', op: 'upsert', payload: p }),
    payload,
  );
}

async function seedHabitLog(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'habit_logs', op: 'upsert', payload: p }),
    payload,
  );
}

async function seedEvent(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'events', op: 'upsert', payload: p }),
    payload,
  );
}

/** Trimmed one-off of aktivitaeten.spec.ts's insertGarminActivity — genug Track-Punkte
 * für alle drei Kurven (HF/Pace/Höhe), Rest bewusst minimal. */
async function insertGarminActivity(): Promise<void> {
  const track = {
    n: 5,
    hr: [140, 150, 160, 155, 148],
    speed: [2.6, 2.9, 3.1, 2.8, 2.7],
    elevation: [60, 65, 72, 68, 61],
  };
  await withDb((client) =>
    client.query(
      `INSERT INTO garmin_activities
        (id, updated_at, deleted_at, synced_at, sync_seq, garmin_activity_id, activity_type, name,
         started_at, distance_meters, duration_seconds, elapsed_seconds, elevation_gain, elevation_loss,
         average_hr, max_hr, average_speed, calories, track, map_image, fetched_at)
       VALUES
        ($1, now(), NULL, now(), nextval('sync_seq'), $2, 'running', 'Sonde-Lauf',
         '2026-07-20T06:30:00Z', 5000, 1750, 1810, 120, 118,
         150, 178, 2.8, 400, $3, NULL, now())`,
      [randomUUID(), Math.floor(Math.random() * 1_000_000_000), JSON.stringify(track)],
    ),
  );
}

/** Mirrors grundfarbe.spec.ts's own probe-span technique for a var()-resolved length. */
async function resolvePxToken(page: Page, token: string): Promise<number> {
  return page.evaluate((cssVar) => {
    const probe = document.createElement('span');
    probe.style.fontSize = `var(${cssVar})`;
    document.body.appendChild(probe);
    const size = parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();
    return size;
  }, token);
}

async function fontSizeOf(locator: Locator): Promise<number> {
  return locator.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
}

/** Mirrors grundfarbe.spec.ts's own canvas-pixel technique — a regex against
 * getComputedStyle's serialized colour would misparse an oklch()/color-mix()
 * string as if it were rgb(). */
async function toRgb(page: Page, color: string): Promise<[number, number, number]> {
  return page.evaluate((c) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b] as [number, number, number];
  }, color);
}

function relativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/** WCAG contrast ratio (1–21) between two 0–255 sRGB byte tuples. */
function contrastRatio(rgbA: [number, number, number], rgbB: [number, number, number]): number {
  const [la, lb] = [relativeLuminance(...rgbA), relativeLuminance(...rgbB)];
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

async function elementColor(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).color);
}

async function htmlBackground(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
}

interface HeaderCase {
  path: string;
  /** Der Kopf-Container: Titelzeile + optionaler Zusatz (Ring, Datum, Suchknopf). */
  header: (page: Page) => Locator;
}

// Acht der neun authentifizierten Routen — Anmelden braucht einen ausgeloggten
// Kontext und bekommt seinen eigenen Block weiter unten.
const HEADERS: HeaderCase[] = [
  { path: '/uebersicht', header: (page) => page.locator('.uebersicht__title-row') },
  { path: '/aufgaben', header: (page) => page.getByRole('heading', { level: 1, name: 'Aufgaben' }) },
  { path: '/kalender', header: (page) => page.locator('.calendar-view__header') },
  {
    path: '/routinen',
    header: (page) => page.getByRole('heading', { level: 1, name: 'Routinen' }),
  },
  { path: '/journal', header: (page) => page.locator('.journal-page__title-row') },
  {
    path: '/aktivitaeten',
    header: (page) => page.getByRole('heading', { level: 1, name: 'Aktivitäten' }),
  },
  { path: '/wetter/2026-07-18', header: (page) => page.locator('.weather-day__topbar') },
  { path: '/einstellungen', header: (page) => page.locator('.einstellungen__topbar') },
];

async function assertFlatHeader(header: Locator, label: string) {
  await expect(header).toBeVisible();
  const { backgroundImage, borderRadius } = await header.evaluate((el) => {
    const style = getComputedStyle(el);
    return { backgroundImage: style.backgroundImage, borderRadius: style.borderRadius };
  });
  expect(backgroundImage, `Kopf auf ${label} trägt keinen Verlauf`).toBe('none');
  expect(borderRadius, `Kopf auf ${label} ist kein abgerundeter Block`).toBe('0px');
}

async function assertHeaderFitsItself(header: Locator, label: string) {
  await expect(header).toBeVisible();
  const { scrollHeight, clientHeight } = await header.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(
    scrollHeight,
    `Kopf auf ${label}: scrollHeight ${scrollHeight} vs. clientHeight ${clientHeight}`,
  ).toBeLessThanOrEqual(clientHeight);
}

test('AK1: der Kopf ist Titelzeile + optionaler Zusatz, flach — kein Verlauf, kein Block-Radius', async ({
  page,
}) => {
  await registerPasskey(page);
  for (const { path, header } of HEADERS) {
    await page.goto(path);
    await assertFlatHeader(header(page), path);
  }
});

test('AK2: Titelgrad ist gegenüber --text-title halbiert, /uebersicht zeigt mehr Inhalt ohne neuen Abschnitt', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await registerPasskey(page);
  await seedTask(page, { title: 'AK2 Aufgabe 1', dueAt: FIXED_NOW });
  await seedTask(page, { title: 'AK2 Aufgabe 2', dueAt: FIXED_NOW });
  await seedHabit(page, { name: 'AK2 Routine 1', schedule: 'daily', color: null, archivedAt: null });
  await seedHabit(page, { name: 'AK2 Routine 2', schedule: 'daily', color: null, archivedAt: null });
  await page.goto('/uebersicht');

  // Erst NACH einer echten Navigation prüfbar — die Tokens leben in
  // tokens.css/globals.css, die about:blank (Playwright-Startseite) nicht lädt.
  const pageTitleSize = await resolvePxToken(page, '--text-page-title');
  const titleSize = await resolvePxToken(page, '--text-title');
  expect(pageTitleSize, '--text-page-title ist kleiner als --text-title').toBeLessThan(titleSize);

  // "Ohne Abschnitt" (Plan-Revision A): der gewonnene Platz geht direkt an die
  // Liste — kein neues "mehr anzeigen"/Zusammenklappen versteckt die zweite
  // Aufgabe oder Routine.
  await expect(page.getByText('AK2 Aufgabe 1')).toBeVisible();
  await expect(page.getByText('AK2 Aufgabe 2')).toBeVisible();
  await expect(page.getByText('AK2 Routine 1')).toBeVisible();
  await expect(page.getByText('AK2 Routine 2')).toBeVisible();
});

test('AK3: der Fortschrittsring steht im Fluss neben dem Titel, nicht absolut darüber', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/uebersicht');

  const ring = page.locator('.daily-progress-ring-slot');
  await expect(ring).toBeVisible();
  const position = await ring.evaluate((el) => getComputedStyle(el).position);
  expect(['absolute', 'fixed'], 'Ring ist kein positionierter Overlay').not.toContain(position);

  // Nicht nach Name filtern: der h1-Text ist seit issue #862 eine tageszeitabhängige
  // Begrüßung, nicht mehr fest „Übersicht" — `[data-ground="uebersicht"] h1` ist
  // hier eindeutig, es gibt genau eine h1 auf dieser Seite.
  const heading = page.locator('[data-ground="uebersicht"] h1');
  const [headingBox, ringBox] = await Promise.all([heading.boundingBox(), ring.boundingBox()]);
  expect(headingBox).not.toBeNull();
  expect(ringBox).not.toBeNull();
  const overlaps =
    headingBox!.x < ringBox!.x + ringBox!.width &&
    headingBox!.x + headingBox!.width > ringBox!.x &&
    headingBox!.y < ringBox!.y + ringBox!.height &&
    headingBox!.y + headingBox!.height > ringBox!.y;
  expect(overlaps, 'Titel und Ring überlappen sich nicht').toBe(false);
});

test('AK4: die tatsächlich vorhandenen Angaben bleiben stehen — Aufgaben-Hinweis, Aktivitäts-Kurven, Habit-Zwischenstand, Kalender-Leerzustand', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW); // Saturday, 2026-07-18
  await registerPasskey(page);

  // Aufgaben: „Danach nichts mehr geplant." (task-list.tsx:513) — NICHT Kalender,
  // das hat seit issue #638 einen eigenen, textlosen Leerzustand (siehe unten).
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'AK4 Nur heute', dueAt: FIXED_NOW });
  await expect(page.getByText('Danach nichts mehr geplant.')).toBeVisible();

  // Aktivitäten: die drei Kurven (Herzfrequenz/Pace/Höhenprofil, activity-block.tsx).
  await insertGarminActivity();
  await page.goto('/aktivitaeten');
  await expect(page.locator('.activity-chart__svg path')).toHaveCount(3);

  // Routinen: „N von M"-Zwischenstand lebt in der Übersicht-Habit-Sektion
  // (habit-today.tsx:97), nicht auf /routinen selbst.
  const habitId = await seedHabit(page, {
    name: 'AK4 Krafttraining',
    schedule: 'weekly',
    target: 3,
    color: null,
    archivedAt: null,
  });
  await seedHabitLog(page, { habitId, logDate: '2026-07-13', done: true }); // Montag derselben Woche
  await page.goto('/uebersicht');
  const habitItem = page
    .getByRole('list', { name: 'Routinen heute' })
    .getByRole('listitem')
    .filter({ hasText: 'AK4 Krafttraining' });
  await expect(habitItem.getByText('1 von 3 diese Woche')).toBeVisible();

  // Kalender: eigener Leerzustand, kein Text aus #638 wiederverwendet.
  await page.goto('/kalender');
  await expect(page.getByText('Keine Termine an diesem Tag.')).toBeVisible();
});

test('AK5: die Kopfzeile selbst läuft auf keiner der neun Routen über (375×812)', async ({
  page,
}) => {
  await registerPasskey(page);
  for (const { path, header } of HEADERS) {
    await page.goto(path);
    await assertHeaderFitsItself(header(page), path);
  }
});

test('Titelgrößen: h1 ist überall 22px, Aktivitäten 26px, Wetter-Temperatur 40px', async ({
  page,
}) => {
  await registerPasskey(page);

  const routesAt22: Array<{ path: string; heading: (page: Page) => Locator }> = [
    { path: '/aufgaben', heading: (p) => p.getByRole('heading', { level: 1, name: 'Aufgaben' }) },
    {
      path: '/routinen',
      heading: (p) => p.getByRole('heading', { level: 1, name: 'Routinen' }),
    },
    {
      path: '/journal',
      // Titel „Wie war dein Tag?“ seit issue #868.
      heading: (p) => p.getByRole('heading', { level: 1, name: 'Wie war dein Tag?' }),
    },
    {
      path: '/einstellungen',
      heading: (p) => p.getByRole('heading', { level: 1, name: 'Einstellungen' }),
    },
    // Kein Name-Filter (issue #862): der Titel ist eine tageszeitabhängige Begrüßung.
    { path: '/uebersicht', heading: (p) => p.locator('[data-ground="uebersicht"] h1') },
  ];
  for (const { path, heading } of routesAt22) {
    await page.goto(path);
    expect(await fontSizeOf(heading(page)), `Titelgröße auf ${path}`).toBe(22);
  }

  await page.goto('/aktivitaeten');
  expect(
    await fontSizeOf(page.getByRole('heading', { level: 1, name: 'Aktivitäten' })),
    'Titelgröße Aktivitäten',
  ).toBe(26);

  // Wetter-Temperatur liest den gecachten Vorhersage-Tag, nicht einen eigenen
  // Netzaufruf (AC „kein eigener Netzaufruf") — /uebersicht wärmt den Dexie-Cache
  // vor, erst danach zeigt die Tagesseite echte Werte statt des Leerzustands.
  await page.goto('/uebersicht');
  await expect(page.locator('.weather-forecast').getByRole('listitem')).toHaveCount(7);
  await page.goto('/wetter/2026-07-18');
  expect(
    await fontSizeOf(page.locator('.weather-day__temp-max')),
    'Titelgröße Wetter-Temperatur',
  ).toBe(40);
});

/* -------------------------------------------------------------------------- */
/* issue #868 (T1 von #861): gemeinsames PageHead-Bauteil für Übersicht/       */
/* Aufgaben/Journal — Augenbraue, Zusatz-Slot, Kontrast.                     */
/* -------------------------------------------------------------------------- */

test('AK2 (#868): Übersicht zeigt die Augenbraue (langes Datum) und die Unterzeile (was heute offen ist)', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await registerPasskey(page);
  await seedTask(page, { title: 'AK2 868 Aufgabe', dueAt: FIXED_NOW });
  await seedHabit(page, { name: 'AK2 868 Routine', schedule: 'daily', color: null, archivedAt: null });
  await page.goto('/uebersicht');

  const eyebrow = page.locator('[data-ground="uebersicht"] .page-head__eyebrow');
  await expect(eyebrow).toHaveText(EYEBROW_DATE_FORMATTER.format(new Date(FIXED_NOW)));
  await expect(page.locator('[data-ground="uebersicht"] h1')).toBeVisible();

  // Eine Aufgabe + eine Routine, keine erledigt -> "Noch 2 von 2 offen".
  const subline = page.locator('[data-ground="uebersicht"] .page-head__subline');
  await expect(subline).toHaveText('Noch 2 von 2 offen');
});

test('AK2 (#868): Aufgaben zeigt die Augenbraue „N offen · M erledigt" und bleibt ohne Zusatz-Slot', async ({
  page,
}) => {
  await registerPasskey(page);
  await seedTask(page, { title: 'AK2 868 erledigt', dueAt: null, completedAt: FIXED_NOW });
  await seedTask(page, { title: 'AK2 868 offen', dueAt: null });
  await page.goto('/aufgaben');

  const eyebrow = page.locator('[data-ground="aufgaben"] .page-head__eyebrow');
  await expect(eyebrow).toHaveText('1 offen · 1 erledigt');
  await expect(page.getByRole('heading', { level: 1, name: 'Aufgaben' })).toBeVisible();

  // Die #861-Tabelle sagt "—" für Aufgaben — kein Zusatz-Slot im DOM.
  await expect(page.locator('[data-ground="aufgaben"] .page-head__extra')).toHaveCount(0);
});

test('AK2 (#868): Journal zeigt die Augenbraue (langes Datum) über dem Titel „Wie war dein Tag?"', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await registerPasskey(page);
  await page.goto('/journal');

  const eyebrow = page.locator('[data-ground="journal"] .page-head__eyebrow');
  await expect(eyebrow).toHaveText(EYEBROW_DATE_FORMATTER.format(new Date(FIXED_NOW)));
  await expect(page.getByRole('heading', { level: 1, name: 'Wie war dein Tag?' })).toBeVisible();
});

test('AK5 (#868): der PageHead läuft auf Übersicht/Aufgaben/Journal mit Inhalt nicht über (375×812)', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await registerPasskey(page);
  await seedTask(page, { title: 'AK5 868 Aufgabe', dueAt: FIXED_NOW });
  await seedHabit(page, { name: 'AK5 868 Routine', schedule: 'daily', color: null, archivedAt: null });

  for (const path of ['/uebersicht', '/aufgaben', '/journal']) {
    await page.goto(path);
    await assertHeaderFitsItself(page.locator('.page-head'), path);
  }
});

test('AK6 (#868): die Augenbraue erfüllt 4,5:1 gegen den Grund, Hell und Dunkel, auf Übersicht/Aufgaben/Journal', async ({
  page,
}) => {
  await registerPasskey(page);

  for (const path of ['/uebersicht', '/aufgaben', '/journal']) {
    await page.goto(path);
    const eyebrow = page.locator('.page-head__eyebrow');
    await expect(eyebrow).toBeVisible();

    const lightColor = await elementColor(eyebrow);
    const lightGround = await htmlBackground(page);
    expect(
      contrastRatio(await toRgb(page, lightColor), await toRgb(page, lightGround)),
      `Augenbraue auf ${path} (hell)`,
    ).toBeGreaterThanOrEqual(4.5);

    await page.emulateMedia({ colorScheme: 'dark' });
    const darkColor = await elementColor(eyebrow);
    const darkGround = await htmlBackground(page);
    expect(
      contrastRatio(await toRgb(page, darkColor), await toRgb(page, darkGround)),
      `Augenbraue auf ${path} (dunkel)`,
    ).toBeGreaterThanOrEqual(4.5);
    await page.emulateMedia({ colorScheme: 'light' });
  }
});

test('AK6 (#861): die Augenbraue erfüllt 4,5:1 gegen den Aktivitäten-Grund, Hell und Dunkel', async ({
  page,
}) => {
  await registerPasskey(page);
  // Genügt für den "befüllten" Kopf: der Zustand hängt an activities.length, nicht
  // am 30-Tage-Fenster -- die Augenbraue rendert auch, wenn die eine Aktivität aus
  // dem Recap-Fenster fällt (siehe activity-list.tsx).
  await insertGarminActivity();
  await page.goto('/aktivitaeten');

  const eyebrow = page.locator('[data-module="aktivitaeten"] .page-head__eyebrow');
  await expect(eyebrow).toBeVisible();

  const lightColor = await elementColor(eyebrow);
  const lightGround = await htmlBackground(page);
  expect(
    contrastRatio(await toRgb(page, lightColor), await toRgb(page, lightGround)),
    'Augenbraue auf /aktivitaeten (hell)',
  ).toBeGreaterThanOrEqual(4.5);

  await page.emulateMedia({ colorScheme: 'dark' });
  const darkColor = await elementColor(eyebrow);
  const darkGround = await htmlBackground(page);
  expect(
    contrastRatio(await toRgb(page, darkColor), await toRgb(page, darkGround)),
    'Augenbraue auf /aktivitaeten (dunkel)',
  ).toBeGreaterThanOrEqual(4.5);
});

/* -------------------------------------------------------------------------- */
/* issue #898 (T2b von #861/#869): Kalender-Kopf — Augenbraue + „Diese Woche"/ */
/* Monat + Chips, dieselben drei Zonen/Tokens wie PageHead, kein PageHead-     */
/* Bauteil selbst (der `<header>` bleibt handgebaut, Streifen bleibt darin).   */
/* -------------------------------------------------------------------------- */

test('AK2 (#898): Kalender zeigt Woche „<Monat Jahr>"/„Diese Woche" und Monat „<Jahr>"/Monatsname + Chips', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW); // Samstag, 2026-07-18
  await registerPasskey(page);
  await seedEvent(page, {
    title: 'AK2 898 getimt',
    allDay: false,
    startsAt: '2026-07-10T09:00:00.000Z',
    endsAt: '2026-07-10T10:00:00.000Z',
  });
  await seedEvent(page, {
    title: 'AK2 898 ganztägig',
    allDay: true,
    startDate: '2026-07-15',
    endDate: '2026-07-15',
  });
  await page.goto('/kalender');

  const period = page.locator('.calendar-view__period');
  await expect(period).toHaveText('Juli 2026');
  await expect(page.getByRole('heading', { level: 1, name: 'Diese Woche' })).toBeVisible();
  await expect(page.locator('.page-head__chips')).toHaveCount(0);

  await page.getByRole('radio', { name: 'Monat' }).click();

  await expect(period).toHaveText('2026');
  await expect(page.getByRole('heading', { level: 1, name: 'Juli' })).toBeVisible();
  const chips = page.locator('.page-head__chip');
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0)).toHaveText('2 Termine');
  await expect(chips.nth(1)).toHaveText('1 ganztägig');
});

test('AK5 (#898): der Kalender-Kopf läuft in Woche und Monat nicht über (375×812), Chips brechen um', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await registerPasskey(page);
  await seedEvent(page, {
    title: 'AK5 898 getimt',
    allDay: false,
    startsAt: '2026-07-10T09:00:00.000Z',
    endsAt: '2026-07-10T10:00:00.000Z',
  });
  await page.goto('/kalender');

  const header = page.locator('.calendar-view__header');
  await assertHeaderFitsItself(header, '/kalender (Woche)');

  await page.getByRole('radio', { name: 'Monat' }).click();
  await assertHeaderFitsItself(header, '/kalender (Monat)');
  await expect(page.locator('.page-head__chips')).toHaveCSS('flex-wrap', 'wrap');
});

test('AK6 (#898): die Kalender-Augenbraue erfüllt 4,5:1 gegen den Kalender-Grund, Hell und Dunkel', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await registerPasskey(page);
  await page.goto('/kalender');

  const eyebrow = page.locator('.calendar-view__period');
  await expect(eyebrow).toBeVisible();

  const lightColor = await elementColor(eyebrow);
  const lightGround = await htmlBackground(page);
  expect(
    contrastRatio(await toRgb(page, lightColor), await toRgb(page, lightGround)),
    'Augenbraue auf /kalender (hell)',
  ).toBeGreaterThanOrEqual(4.5);

  await page.emulateMedia({ colorScheme: 'dark' });
  const darkColor = await elementColor(eyebrow);
  const darkGround = await htmlBackground(page);
  expect(
    contrastRatio(await toRgb(page, darkColor), await toRgb(page, darkGround)),
    'Augenbraue auf /kalender (dunkel)',
  ).toBeGreaterThanOrEqual(4.5);
});

/* -------------------------------------------------------------------------- */
/* issue #870 (T3 von #861): Wetter/Einstellungen/Anmelden füllen PageHead aus */
/* T1 (#868) — Wetter/Einstellungen als handgebauter Kopf (Muster #898),      */
/* Anmelden ohne Augenbraue/Zusatz, dafür große Figur statt Titelzeile.       */
/* -------------------------------------------------------------------------- */

test('AK2 (#870): Wetter zeigt die Augenbraue (Datum), die Temperatur als Titel und die Kategorie als Unterzeile', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await registerPasskey(page);
  // /uebersicht wärmt den Dexie-Cache vor (AC „kein eigener Netzaufruf" auf
  // der Tagesseite) — erst danach zeigt /wetter echte Werte statt no-data.
  await page.goto('/uebersicht');
  await expect(page.locator('.weather-forecast').getByRole('listitem')).toHaveCount(7);
  await page.goto('/wetter/2026-07-18');

  const eyebrow = page.locator('.weather-day__date');
  await expect(eyebrow).toHaveText(EYEBROW_DATE_FORMATTER.format(new Date(FIXED_NOW)));
  await expect(page.locator('.weather-day__temp-max')).toHaveText('20°');
  // Wettercode 0 (Standard des Test-Mocks) -> Kategorie "Klar".
  await expect(page.locator('.page-head__subline')).toHaveText('Klar');
});

test('AK2 (#870): Einstellungen zeigt die Augenbraue (Zurück) über dem Titel, ohne Zusatz-Slot', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/einstellungen');

  await expect(page.locator('.einstellungen__back')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible();

  // Die #861-Tabelle sagt "—" für Einstellungen — kein Zusatz-Slot im DOM.
  await expect(page.locator('.page-head__extra')).toHaveCount(0);
  await expect(page.locator('.page-head__subline')).toHaveCount(0);
});

test('AK6 (#870): die Wetter-Augenbraue erfüllt 4,5:1 gegen den Wetter-Grund, Hell und Dunkel', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await registerPasskey(page);
  await page.goto('/uebersicht');
  await expect(page.locator('.weather-forecast').getByRole('listitem')).toHaveCount(7);
  await page.goto('/wetter/2026-07-18');

  const eyebrow = page.locator('.weather-day__date');
  await expect(eyebrow).toBeVisible();

  const lightColor = await elementColor(eyebrow);
  const lightGround = await htmlBackground(page);
  expect(
    contrastRatio(await toRgb(page, lightColor), await toRgb(page, lightGround)),
    'Augenbraue auf /wetter (hell)',
  ).toBeGreaterThanOrEqual(4.5);

  await page.emulateMedia({ colorScheme: 'dark' });
  const darkColor = await elementColor(eyebrow);
  const darkGround = await htmlBackground(page);
  expect(
    contrastRatio(await toRgb(page, darkColor), await toRgb(page, darkGround)),
    'Augenbraue auf /wetter (dunkel)',
  ).toBeGreaterThanOrEqual(4.5);
});

test('AK6 (#870): die Einstellungen-Augenbraue (Zurück-Link) erfüllt 4,5:1 gegen den Einstellungen-Grund, Hell und Dunkel', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/einstellungen');

  const eyebrow = page.locator('.einstellungen__back');
  await expect(eyebrow).toBeVisible();

  const lightColor = await elementColor(eyebrow);
  const lightGround = await htmlBackground(page);
  expect(
    contrastRatio(await toRgb(page, lightColor), await toRgb(page, lightGround)),
    'Augenbraue auf /einstellungen (hell)',
  ).toBeGreaterThanOrEqual(4.5);

  await page.emulateMedia({ colorScheme: 'dark' });
  const darkColor = await elementColor(eyebrow);
  const darkGround = await htmlBackground(page);
  expect(
    contrastRatio(await toRgb(page, darkColor), await toRgb(page, darkGround)),
    'Augenbraue auf /einstellungen (dunkel)',
  ).toBeGreaterThanOrEqual(4.5);
});

test.describe('Anmelden (ausgeloggter Kontext)', () => {
  // Eingeloggt leitet /anmelden sofort auf /uebersicht um (shell.spec.ts) — dieser
  // Block braucht einen frischen, ausgeloggten Context statt der geteilten Sitzung.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('AK1/AK5: Anmelden-Kopf ist flach und läuft nicht über', async ({ page }) => {
    await page.goto('/anmelden');
    const header = page.getByRole('heading', { level: 1 });
    await assertFlatHeader(header, '/anmelden');
    // Die 136px-Figur (#870) ist Geschwister des <h1>, nicht sein Kind — ihr
    // Bounce-Überlauf (faces.css pf-bob, ±3px translate) zeigt sich nur am
    // gemeinsamen Container .auth__title-row, nie am <h1> allein.
    await assertHeaderFitsItself(page.locator('.auth__title-row'), '/anmelden');
    expect(await fontSizeOf(header), 'Titelgröße Anmelden').toBe(22);
  });

  test('AK2 (#870): Anmelden zeigt „Willkommen zurück" mit großer Figur, keine Augenbraue, kein Zusatz-Slot', async ({
    page,
  }) => {
    await page.goto('/anmelden');

    await expect(page.getByRole('heading', { level: 1, name: 'Willkommen zurück' })).toBeVisible();
    const face = page.locator('.face');
    await expect(face).toBeVisible();
    const box = await face.boundingBox();
    expect(Math.round(box!.width), 'Figurbreite auf /anmelden').toBe(136);
    expect(Math.round(box!.height), 'Figurhöhe auf /anmelden').toBe(136);

    // Die #861-Tabelle sagt "—" für beide Zonen auf Anmelden.
    await expect(page.locator('.page-head__eyebrow')).toHaveCount(0);
    await expect(page.locator('.page-head__extra, .page-head__subline')).toHaveCount(0);
  });
});
