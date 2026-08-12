import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { openMeteoForecastBody, registerPasskey, resetAppData, skewClock, withDb } from './helpers';

/**
 * `OverviewBlock` (issue #652): einheitliche Modulköpfe auf /uebersicht + Ring
 * in der Titelzeile. Je Akzeptanzkriterium ein Test, wie im Ticket gefordert.
 */

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
/* AK2: einheitliche h2 je Modul                                              */
/* -------------------------------------------------------------------------- */

test('Wetter, Aufgaben, Termine und Routinen haben auf /uebersicht ein sichtbares h2 mit dem Modulnamen (AK2)', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  // Wetter geht hier über den Fehlerzustand (open-meteo im beforeEach oben
  // aborted) — die Überschrift muss auch dann stehen, nicht nur beim Erfolg.
  await expect(page.getByRole('heading', { name: 'Wetter', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Aufgaben', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Termine', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Routinen', level: 2 })).toBeVisible();
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

  test('Aktivitäten hat auf /uebersicht ein sichtbares h2 mit dem Modulnamen (AK2)', async ({ page }) => {
    await withDb((client) =>
      client.query(
        `INSERT INTO garmin_activities
          (id, updated_at, deleted_at, synced_at, sync_seq, garmin_activity_id, activity_type, started_at, fetched_at)
         VALUES ($1, now(), NULL, now(), nextval('sync_seq'), $2, $3, $4, now())`,
        [randomUUID(), Math.floor(Math.random() * 1_000_000_000), 'running', '2020-01-01T00:00:00Z'],
      ),
    );

    await page.goto('/uebersicht');
    await expect(page.getByRole('heading', { name: 'Aktivitäten', level: 2 })).toBeVisible();
  });
});

test('der Überschriftenpunkt trägt die Bereichsfarbe des jeweiligen Moduls (AK1+AK2)', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  const aufgabenDot = page
    .getByRole('heading', { name: 'Aufgaben', level: 2 })
    .locator('.overview-block__dot');
  const routinenDot = page
    .getByRole('heading', { name: 'Routinen', level: 2 })
    .locator('.overview-block__dot');
  const wetterDot = page.getByRole('heading', { name: 'Wetter', level: 2 }).locator('.overview-block__dot');

  const [tasksToken, habitsToken, weatherToken, aufgabenColor, routinenColor, wetterColor] = await Promise.all([
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--area-tasks').trim()),
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--area-habits').trim()),
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--area-weather').trim()),
    aufgabenDot.evaluate((el) => getComputedStyle(el).backgroundColor),
    routinenDot.evaluate((el) => getComputedStyle(el).backgroundColor),
    wetterDot.evaluate((el) => getComputedStyle(el).backgroundColor),
  ]);

  const toRgb = async (token: string) =>
    page.evaluate((t) => {
      const probe = document.createElement('span');
      probe.style.color = t;
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }, token);

  expect(aufgabenColor).toBe(await toRgb(tasksToken));
  expect(routinenColor).toBe(await toRgb(habitsToken));
  expect(wetterColor).toBe(await toRgb(weatherToken));
  expect(aufgabenColor).not.toBe(routinenColor);
  expect(wetterColor).not.toBe(routinenColor);
});

/* -------------------------------------------------------------------------- */
/* AK3: Ring in der Titelzeile, rechts vom Erfassungsknopf                    */
/* -------------------------------------------------------------------------- */

test('der Fortschrittsring sitzt in der Titelzeile rechts vom Erfassungsknopf (AK3)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Heute fällig', dueAt: TODAY_EVENING });

  const captureButton = page.locator('.uebersicht-capture__button');
  const ring = page.locator('.daily-progress-ring');
  await expect(ring).toBeVisible();

  const [captureBox, ringBox, titleRowBox] = await Promise.all([
    captureButton.boundingBox(),
    ring.boundingBox(),
    page.locator('.uebersicht__title-row').boundingBox(),
  ]);
  if (!captureBox || !ringBox || !titleRowBox) {
    throw new Error('Erfassungsknopf, Ring und Titelzeile müssen sichtbar sein');
  }

  // Rechts vom Erfassungsknopf …
  expect(ringBox.x).toBeGreaterThan(captureBox.x + captureBox.width);
  // … und innerhalb der Titelzeile (vertikal überlappend).
  expect(ringBox.y).toBeGreaterThanOrEqual(titleRowBox.y);
  expect(ringBox.y + ringBox.height).toBeLessThanOrEqual(titleRowBox.y + titleRowBox.height + 1);
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
/* AK5: Wochenrückblick verlässt /uebersicht, bleibt auf /routinen            */
/* -------------------------------------------------------------------------- */

test('der Wochenrückblick ist auf /uebersicht nicht vorhanden, auf /routinen unverändert vorhanden (AK5)', async ({
  page,
}) => {
  const habitId = await seedHabit(page, { createdAt: '2026-06-01T00:00:00.000Z' });
  // Bezugswoche (Mo–So vor der laufenden Woche) mit Logs, sonst zeigt die Karte
  // ohnehin nichts (weekly-recap.ts) — das würde den Test nicht aussagekräftig machen.
  for (const day of ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-11', '2026-07-12']) {
    await page.evaluate(
      ({ id, day }) =>
        window.__starship.mutate({
          table: 'habit_logs',
          op: 'upsert',
          payload: { habitId: id, logDate: day, done: true },
        }),
      { id: habitId, day },
    );
  }

  await page.goto('/uebersicht');
  await expect(page.locator('.weekly-recap-card')).toHaveCount(0);

  await page.goto('/routinen');
  await expect(page.locator('.weekly-recap-card').getByText('Wochenrückblick')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* AK6: ein abgeschaltetes Modul rendert weder Überschrift noch Inhalt        */
/* -------------------------------------------------------------------------- */

test('ein abgeschaltetes Modul rendert weder Überschrift noch Inhalt (AK6)', async ({ page }) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Heute fällig', dueAt: TODAY_EVENING });
  await expect(page.getByRole('heading', { name: 'Aufgaben', level: 2 })).toBeVisible();
  await expect(page.getByText('Heute fällig')).toBeVisible();

  await setModulesOff(page, ['aufgaben']);
  await page.reload();

  await expect(page.getByRole('heading', { name: 'Aufgaben', level: 2 })).toHaveCount(0);
  await expect(page.getByText('Heute fällig')).toHaveCount(0);
});
