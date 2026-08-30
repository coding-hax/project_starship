import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { parseForecast } from '@/features/weather/forecast';
import {
  FIXED_NOW,
  installClockAt,
  openMeteoForecastBody,
  registerPasskey,
  resetAppData,
  withDb,
} from './helpers';

/**
 * Abgleich Route für Route (issue #834, S6 von #828): AK4 — die vier Kopf-Angaben,
 * die #833s S2-AK4 schon auf Anwesenheit (`toBeVisible`) prüft, bleiben zusätzlich
 * tatsächlich im 375×812-Bild (`toBeInViewport`), im vollen Vollfarb-Zusammenspiel
 * aller Stufen S1–S5 — die einzige Prüfebene, auf der Occlusion durch Hintergrundkreise
 * (S3) oder Karten (S5) überhaupt sichtbar würde. Hell/dunkel × Bewegung/reduced-motion,
 * je eigener Test (kein `.skip`/`.only`, DoD Dark Mode + reduced-motion).
 */

const GARMIN_SYNC_PATTERN = '**/api/garmin-sync';
const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';
const SYNC_COUNTERS = { scanned: 0, created: 0, updated: 0, detailsFilled: 0, mapsFilled: 0 };
// Umschließt FIXED_NOW (Samstag, 2026-07-18) — für den Wetter-Kopf unten
// (issue #870 T3), der eine echte Vorhersage statt der leeren beforeEach-
// Antwort braucht (dieselbe Woche wie seitenkopf.spec.ts's FORECAST_WEEK).
const FORECAST_WEEK = [
  '2026-07-15',
  '2026-07-16',
  '2026-07-17',
  '2026-07-18',
  '2026-07-19',
  '2026-07-20',
  '2026-07-21',
];

test.beforeEach(async ({ page }) => {
  await resetAppData();
  await page.route(GARMIN_SYNC_PATTERN, (route) => route.fulfill({ json: SYNC_COUNTERS }));
  await page.route(OPEN_METEO_PATTERN, (route) =>
    route.fulfill({ json: openMeteoForecastBody({ dates: [], tempsMax: [], tempsMin: [] }) }),
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

/** Trimmed one-off of seitenkopf.spec.ts's insertGarminActivity. */
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

const MODES: Array<{
  label: string;
  colorScheme: 'light' | 'dark';
  reducedMotion: 'reduce' | 'no-preference';
}> = [
  { label: 'hell, Bewegung an', colorScheme: 'light', reducedMotion: 'no-preference' },
  { label: 'hell, reduced-motion', colorScheme: 'light', reducedMotion: 'reduce' },
  { label: 'dunkel, Bewegung an', colorScheme: 'dark', reducedMotion: 'no-preference' },
  { label: 'dunkel, reduced-motion', colorScheme: 'dark', reducedMotion: 'reduce' },
];

for (const mode of MODES) {
  test(`AK4: Kopf-Angaben aus S2 AK4 stehen im vollen Recolor tatsächlich im Bild (${mode.label})`, async ({
    page,
  }) => {
    await installClockAt(page, FIXED_NOW); // Saturday, 2026-07-18
    await registerPasskey(page);
    await page.emulateMedia({ colorScheme: mode.colorScheme, reducedMotion: mode.reducedMotion });

    // Aufgaben: „Danach nichts mehr geplant." (task-list.tsx:513).
    await seedTask(page, { title: 'Abgleich Nur heute', dueAt: FIXED_NOW });
    await page.goto('/aufgaben');
    await expect(page.getByText('Danach nichts mehr geplant.')).toBeInViewport();
    // issue #870 (T3): Augenbraue „N offen · M erledigt" (T1 von #861).
    await expect(page.locator('[data-ground="aufgaben"] .page-head__eyebrow')).toBeInViewport();

    // Aktivitäten: die drei Kurven (Herzfrequenz/Pace/Höhenprofil).
    await insertGarminActivity();
    await page.goto('/aktivitaeten');
    const curves = page.locator('.activity-chart__svg path');
    await expect(curves).toHaveCount(3);
    for (let i = 0; i < 3; i += 1) {
      await expect(curves.nth(i)).toBeInViewport();
    }
    // issue #870 (T3): Augenbraue „Letzte 30 Tage" + Distanz-Titel (T2a von #861, #897).
    await expect(page.locator('[data-module="aktivitaeten"] .page-head__eyebrow')).toBeInViewport();
    await expect(page.locator('[data-module="aktivitaeten"] h1')).toBeInViewport();

    // Routinen-Zwischenstand lebt in der Übersicht-Habit-Sektion + Fortschrittsring.
    const habitId = await seedHabit(page, {
      name: 'Abgleich Krafttraining',
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
      .filter({ hasText: 'Abgleich Krafttraining' });
    await expect(habitItem.getByText('1 von 3 diese Woche')).toBeInViewport();
    await expect(page.locator('.daily-progress-ring-slot')).toBeInViewport();
    // issue #870 (T3): Augenbraue (langes Datum). Keine Unterzeile mehr seit #920
    // AK4 — der Fortschrittsring (oben, in derselben Augenbrauenzeile) ersetzt sie.
    await expect(page.locator('[data-ground="uebersicht"] .page-head__eyebrow')).toBeInViewport();

    // Kalender: eigener Leerzustand (issue #638).
    await page.goto('/kalender');
    await expect(page.getByText('Keine Termine an diesem Tag.')).toBeInViewport();
    // issue #870 (T3): Augenbraue (Periode) + Chips, Monatsansicht (T2b von #861, #898).
    await expect(page.locator('.calendar-view__period')).toBeInViewport();
    await page.getByRole('radio', { name: 'Monat' }).click();
    await expect(page.locator('.page-head__chip').first()).toBeInViewport();

    // Journal: Titel „Wie war dein Tag?" (T1 von #861, #868).
    await page.goto('/journal');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Wie war dein Tag?' }),
    ).toBeInViewport();

    // Wetter: Augenbraue (Datum) + Titel (Temperatur) + Unterzeile (Kategorie),
    // issue #870 T3. Vorhersage direkt in den Dexie-Cache geschrieben (statt über
    // die beforeEach-Route umgebogen) — die trägt der Wetter-Kopf unten, ohne dass
    // /uebersichts eigener Wetter-Streifen (oben in dieser Suite bereits geprüft)
    // dadurch von leer auf sieben echte Tage wächst (CI-Fund Runde 4: schob die
    // Routinen-Sektion aus dem 812px-Bild).
    await page.evaluate(
      (days) => window.__starship.debugSeedWeather(days),
      parseForecast(
        openMeteoForecastBody({
          dates: FORECAST_WEEK,
          tempsMax: FORECAST_WEEK.map(() => 20),
          tempsMin: FORECAST_WEEK.map(() => 10),
        }),
      ),
    );
    await page.goto('/wetter/2026-07-18');
    await expect(page.locator('.weather-day__date')).toBeInViewport();
    await expect(page.locator('.weather-day__temp-max')).toBeInViewport();
    await expect(page.locator('.page-head__subline')).toBeInViewport();

    // Einstellungen: Augenbraue (Zurück) + Titel, kein Zusatz-Slot (issue #870 T3).
    await page.goto('/einstellungen');
    await expect(page.locator('.einstellungen__back')).toBeInViewport();
    await expect(page.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeInViewport();

    // Anmelden (ausgeloggt) passt nicht in diese eingeloggte Suite — seine
    // Sichtbarkeit deckt der eigene "Anmelden (ausgeloggter Kontext)"-Block in
    // seitenkopf.spec.ts ab.
  });
}
