import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openMeteoForecastBody, registerPasskey, resetAppData, skewClock, withDb } from './helpers';

/**
 * `OverviewBlock` (issue #652, Kartenkopf statt Seitengrund-Überschrift seit
 * issue #972): einheitliche Modulköpfe auf /uebersicht + Ring in der
 * Titelzeile. Je Akzeptanzkriterium ein Test, wie im Ticket gefordert.
 */

/**
 * Playwright's `toBeVisible()` prüft nur eine nicht-leere Bounding-Box und
 * `visibility !== hidden` — eine 1×1px-Box mit `clip-path` (issue #972 AK3)
 * zählt für diese Prüfung als "sichtbar". Die echte Prüfung ist die Größe.
 */
async function isVisuallyHidden(locator: Locator): Promise<boolean> {
  const box = await locator.boundingBox();
  return box === null || (box.width <= 1 && box.height <= 1);
}

const NOW = '2026-07-18T12:00:00.000Z';
const TODAY_EVENING = '2026-07-18T18:00:00.000Z';
const MODULES_OFF_KEY = 'starship:modules-off';

async function seedTask(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: p }),
    payload,
  );
}

async function seedHabit(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) =>
      window.__starship.mutate({
        table: 'habits',
        op: 'upsert',
        payload: { name: 'x', schedule: 'daily', color: null, archivedAt: null, ...p },
      }),
    payload,
  );
}

async function setModulesOff(page: Page, off: string[]): Promise<void> {
  await page.evaluate(
    ({ key, off }) => localStorage.setItem(key, JSON.stringify(off)),
    { key: MODULES_OFF_KEY, off },
  );
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await page.route('https://api.open-meteo.com/**', (route) => route.abort('failed'));
  await registerPasskey(page);
  await skewClock(page, NOW);
});

/* -------------------------------------------------------------------------- */
/* AK2/AK3: Kartenkopf sichtbar, wo das Blatt einen Titel zeigt — sonst        */
/* verborgen (issue #972, löst die #652-Grundzeile ab)                        */
/* -------------------------------------------------------------------------- */

test('Termine und Routinen haben auf /uebersicht ein sichtbares h2 im Kartenkopf (AK2)', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  await expect(page.getByRole('heading', { name: 'Nächster Termin', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Routinen', level: 2 })).toBeVisible();
});

test('Wetter und Aufgaben haben auf /uebersicht ein h2 mit dem Modulnamen, das im DOM bleibt, aber verborgen ist (AK3)', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  // Wetter geht hier über den Fehlerzustand (open-meteo im beforeEach oben
  // aborted) — die Überschrift muss auch dann im DOM stehen, nicht nur beim Erfolg.
  for (const name of ['Wetter', 'Aufgaben']) {
    const heading = page.getByRole('heading', { name, level: 2 });
    await expect(heading).toHaveCount(1);
    expect(await isVisuallyHidden(heading), `${name}-Überschrift muss verborgen sein`).toBe(true);
  }
});

/**
 * Aktivitäten ist server-seitige, gesyncte Daten (ADR-0011) — anders als die
 * übrigen Tests in dieser Datei darf `/api/sync/**` hier nicht blockiert sein,
 * sonst kommt die per `withDb()` eingefügte Aktivität nie in die IndexedDB
 * (gleiches Muster wie aktivitaeten.spec.ts).
 */
test.describe('Aktivitäten (server-seitig gesynct)', () => {
  test.beforeEach(async ({ page }) => {
    await resetAppData();
    // Das äußere beforeEach oben registriert einen abortenden Handler auf
    // demselben Muster — Playwright hängt verschachtelte Hooks an, statt sie zu
    // ersetzen, der Handler bliebe sonst aktiv und die hier eingefügte Aktivität
    // käme nie über den Pull in die IndexedDB.
    await page.unroute('**/api/sync/**');
    await page.route('https://api.open-meteo.com/**', (route) =>
      route.fulfill({ json: openMeteoForecastBody({ dates: ['2026-07-18'], tempsMax: [20], tempsMin: [10] }) }),
    );
    await registerPasskey(page);
    await skewClock(page, NOW);
  });

  test('Aktivitäten hat auf /uebersicht ein h2 mit dem Modulnamen, das im DOM bleibt, aber verborgen ist (AK3)', async ({
    page,
  }) => {
    await withDb((client) =>
      client.query(
        `INSERT INTO garmin_activities
          (id, updated_at, deleted_at, synced_at, sync_seq, garmin_activity_id, activity_type, started_at, fetched_at)
         VALUES ($1, now(), NULL, now(), nextval('sync_seq'), $2, $3, $4, now())`,
        [randomUUID(), Math.floor(Math.random() * 1_000_000_000), 'running', '2020-01-01T00:00:00Z'],
      ),
    );

    await page.goto('/uebersicht');
    const heading = page.getByRole('heading', { name: 'Aktivitäten', level: 2 });
    await expect(heading).toHaveCount(1);
    expect(await isVisuallyHidden(heading)).toBe(true);
  });
});

test('AK1: keine eigene Überschriftenzeile mehr auf dem Seitengrund — der Punkt in Bereichsfarbe entfällt ersatzlos', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  await expect(page.locator('.overview-block__heading')).toHaveCount(0);
  await expect(page.locator('.overview-block__dot')).toHaveCount(0);
});

test('der Kartenkopf zeigt den Titel links und den gedämpften Link rechts, mit Tap-Target ≥44px (AK1+AK2+AK4)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const habitId = await seedHabit(page, { name: 'Lesen' });
  expect(habitId).toBeTruthy();

  const cases: Array<{ head: Locator; title: string; linkText: string | RegExp; href: string }> = [
    {
      head: page.locator('.events-overview__next, .events-overview__empty').locator('.overview-block__head'),
      title: 'Nächster Termin',
      linkText: 'Kalender',
      href: '/kalender',
    },
    {
      head: page.locator('.overview-block__head-card .overview-block__head'),
      title: 'Routinen',
      linkText: /von/,
      href: '/routinen',
    },
  ];

  for (const { head, title, linkText, href } of cases) {
    const titleEl = head.locator('.overview-block__title');
    const link = head.getByRole('link');
    await expect(titleEl).toHaveText(title);
    await expect(link).toHaveText(linkText);
    await expect(link).toHaveAttribute('href', href);

    const [titleBox, linkBox] = await Promise.all([titleEl.boundingBox(), link.boundingBox()]);
    if (!titleBox || !linkBox) throw new Error('Titel und Link müssen sichtbar sein');
    // Titel links, Link rechts …
    expect(linkBox.x).toBeGreaterThan(titleBox.x + titleBox.width);
    // … mit einem Tap-Target von mindestens 44px Höhe (AK4).
    expect(linkBox.height).toBeGreaterThanOrEqual(44);
  }
});

test('der Link-Text im Routinen-Kopf stimmt mit dem Fortschrittsring überein — geteilte Zählung, kein Zweitzähler (AK4)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const habitA = await seedHabit(page, { name: 'Lesen' });
  await seedHabit(page, { name: 'Laufen' });
  await page.evaluate(
    (id) =>
      window.__starship.mutate({
        table: 'habit_logs',
        op: 'upsert',
        payload: { habitId: id, logDate: '2026-07-18', done: true },
      }),
    habitA,
  );

  const ring = page.locator('.daily-progress-ring');
  const link = page.locator('.overview-block__head-card').getByRole('link');
  await expect(ring).toHaveText('1/2');
  await expect(link).toHaveText('1 von 2');
});

/* -------------------------------------------------------------------------- */
/* AK3: Ring in der Augenbrauenzeile, zwischen Datum und Einstellungen        */
/* (issue #920 hebt die #652-Platzierung in der Titelzeile auf — der          */
/* Erfassungsknopf ist seither ein von der Augenbraue unabhängiger FAB)       */
/* -------------------------------------------------------------------------- */

test('der Fortschrittsring sitzt in der Augenbrauenzeile rechts vom Datum, links vom Einstellungen-Einstieg (AK3, #920)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Heute fällig', dueAt: TODAY_EVENING });

  const date = page.locator('.uebersicht__eyebrow-date');
  const ring = page.locator('.daily-progress-ring');
  // `.app-header__settings` sitzt zweimal im DOM (chrome-Variante der Shell,
  // per CSS auf Mobile `display: none`) — die Rollen-Abfrage filtert wie in
  // shell.mobile.spec.ts über die Accessibility-Tree auf die sichtbare.
  const settings = page.getByRole('link', { name: 'Einstellungen' });
  await expect(ring).toBeVisible();

  const [dateBox, ringBox, settingsBox, eyebrowRowBox] = await Promise.all([
    date.boundingBox(),
    ring.boundingBox(),
    settings.boundingBox(),
    page.locator('.uebersicht__eyebrow-row').boundingBox(),
  ]);
  if (!dateBox || !ringBox || !settingsBox || !eyebrowRowBox) {
    throw new Error('Datum, Ring, Einstellungen-Einstieg und Augenbrauenzeile müssen sichtbar sein');
  }

  // Rechts vom Datum …
  expect(ringBox.x).toBeGreaterThan(dateBox.x + dateBox.width);
  // … links vom Einstellungen-Einstieg …
  expect(settingsBox.x).toBeGreaterThanOrEqual(ringBox.x + ringBox.width);
  // … innerhalb der Augenbrauenzeile (vertikal überlappend).
  expect(ringBox.y).toBeGreaterThanOrEqual(eyebrowRowBox.y - 1);
  expect(ringBox.y + ringBox.height).toBeLessThanOrEqual(eyebrowRowBox.y + eyebrowRowBox.height + 1);
});

/* -------------------------------------------------------------------------- */
/* AK4: aria-label nennt den Fortschritt in Worten                            */
/* -------------------------------------------------------------------------- */

test('der Ring hat ein aria-label, das den Fortschritt in Worten nennt (AK4)', async ({ page }) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Heute fällig', dueAt: TODAY_EVENING });
  const habitId = await seedHabit(page, { name: 'Lesen' });
  await page.evaluate(
    (id) =>
      window.__starship.mutate({
        table: 'habit_logs',
        op: 'upsert',
        payload: { habitId: id, logDate: '2026-07-18', done: true },
      }),
    habitId,
  );

  const ring = page.locator('.daily-progress-ring');
  await expect(ring).toHaveAttribute('role', 'status');
  await expect(ring).toHaveAttribute('aria-label', 'heute 1 von 2 erledigt');
});

/* -------------------------------------------------------------------------- */
/* AK3: "heute N von M" kommt als Fließtext nicht mehr vor                    */
/* -------------------------------------------------------------------------- */

test('"heute N von M" kommt auf /uebersicht als Fließtext nicht mehr vor (AK3)', async ({ page }) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Heute fällig', dueAt: TODAY_EVENING });

  await expect(page.locator('.daily-progress-ring')).toBeVisible();
  await expect(page.getByText(/^heute \d+ von \d+$/)).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* AK5: Verlaufskarte ist nicht auf /uebersicht, bleibt auf /routinen         */
/* -------------------------------------------------------------------------- */

test('die Verlaufskarte "Routinen in Serie" ist auf /uebersicht nicht vorhanden, auf /routinen unverändert vorhanden (AK5)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });
  // Log für heute erzeugt eine laufende Serie, sonst zeigt die Karte zwar die
  // Überschrift, aber keine sinnvolle Zahl (streak.ts) — das würde den Test
  // nicht aussagekräftig machen.
  await page.evaluate(
    ({ id, day }) =>
      window.__starship.mutate({
        table: 'habit_logs',
        op: 'upsert',
        payload: { habitId: id, logDate: day, done: true },
      }),
    { id: habitId, day: '2026-07-18' },
  );

  await page.goto('/uebersicht');
  await expect(page.locator('.habit-history-card')).toHaveCount(0);

  await page.goto('/routinen');
  await expect(page.locator('.habit-history-card').getByText('Routinen in Serie')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* AK6: ein abgeschaltetes Modul rendert weder Überschrift noch Inhalt        */
/* -------------------------------------------------------------------------- */

test('ein abgeschaltetes Modul rendert weder Überschrift noch Inhalt (AK6)', async ({ page }) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Heute fällig', dueAt: TODAY_EVENING });
  // Verborgen statt sichtbar (issue #972 AK3) — hier zählt nur, dass die
  // Überschrift überhaupt im DOM steht, bevor das Modul abgeschaltet wird.
  await expect(page.getByRole('heading', { name: 'Aufgaben', level: 2 })).toHaveCount(1);
  await expect(page.getByText('Heute fällig')).toBeVisible();

  await setModulesOff(page, ['aufgaben']);
  await page.reload();

  await expect(page.getByRole('heading', { name: 'Aufgaben', level: 2 })).toHaveCount(0);
  await expect(page.getByText('Heute fällig')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* AK8: 375×812 ohne Überlauf, Dark Mode, reduzierte Bewegung                 */
/* -------------------------------------------------------------------------- */

test('AK8: der Kartenkopf bleibt bei 375×812 einzeilig, ohne horizontalen Überlauf, in Dark Mode und mit reduzierter Bewegung', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 375, height: 812 });
  await seedHabit(page, { name: 'Lesen' });
  await page.goto('/uebersicht');

  for (const titleLocator of [
    page.locator('.events-overview__next, .events-overview__empty').locator('.overview-block__title'),
    page.locator('.overview-block__head-card .overview-block__title'),
  ]) {
    await expect(titleLocator).toBeVisible();
    const { clientHeight, lineHeight } = await titleLocator.evaluate((el) => ({
      clientHeight: el.clientHeight,
      lineHeight: parseFloat(getComputedStyle(el).lineHeight),
    }));
    expect(Math.round(clientHeight / lineHeight)).toBe(1);
  }

  // Der Link behält seine eigene Breite, statt dass sein Text den Titel wegkürzt.
  const routinenLink = page.locator('.overview-block__head-card').getByRole('link');
  await expect(routinenLink).toHaveCSS('flex-shrink', '0');

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});
