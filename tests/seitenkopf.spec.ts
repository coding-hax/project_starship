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

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // Wie grundfarbe.spec.ts: /uebersicht und /aktivitaeten lösen beim Laden echte
  // Netzaufrufe aus, die ungemockt als Konsolenfehler/Dev-Overlay im DOM landen.
  await page.route(GARMIN_SYNC_PATTERN, (route) => route.fulfill({ json: SYNC_COUNTERS }));
  await page.route(OPEN_METEO_PATTERN, (route) =>
    route.fulfill({
      json: openMeteoForecastBody({ dates: ['2026-07-18'], tempsMax: [20], tempsMin: [10] }),
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
    header: (page) => page.getByRole('heading', { level: 1, name: 'Routinen verwalten' }),
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

  const heading = page.getByRole('heading', { level: 1, name: 'Übersicht' });
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
      heading: (p) => p.getByRole('heading', { level: 1, name: 'Routinen verwalten' }),
    },
    { path: '/journal', heading: (p) => p.getByRole('heading', { level: 1, name: 'Journal' }) },
    {
      path: '/einstellungen',
      heading: (p) => p.getByRole('heading', { level: 1, name: 'Einstellungen' }),
    },
    { path: '/uebersicht', heading: (p) => p.getByRole('heading', { level: 1, name: 'Übersicht' }) },
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

test.describe('Anmelden (ausgeloggter Kontext)', () => {
  // Eingeloggt leitet /anmelden sofort auf /uebersicht um (shell.spec.ts) — dieser
  // Block braucht einen frischen, ausgeloggten Context statt der geteilten Sitzung.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('AK1/AK5: Anmelden-Kopf ist flach und läuft nicht über', async ({ page }) => {
    await page.goto('/anmelden');
    const header = page.getByRole('heading', { level: 1 });
    await assertFlatHeader(header, '/anmelden');
    await assertHeaderFitsItself(header, '/anmelden');
    expect(await fontSizeOf(header), 'Titelgröße Anmelden').toBe(22);
  });
});
