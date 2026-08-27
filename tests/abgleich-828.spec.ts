import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
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

    // Aktivitäten: die drei Kurven (Herzfrequenz/Pace/Höhenprofil).
    await insertGarminActivity();
    await page.goto('/aktivitaeten');
    const curves = page.locator('.activity-chart__svg path');
    await expect(curves).toHaveCount(3);
    for (let i = 0; i < 3; i += 1) {
      await expect(curves.nth(i)).toBeInViewport();
    }

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

    // Kalender: eigener Leerzustand (issue #638).
    await page.goto('/kalender');
    await expect(page.getByText('Keine Termine an diesem Tag.')).toBeInViewport();
  });
}
