import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openMeteoForecastBody, registerPasskey, resetAppData, withDb } from './helpers';

const MODULES_OFF_KEY = 'starship:modules-off';
const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';

async function setModulesOff(page: Page, off: string[]): Promise<void> {
  await page.evaluate(
    ({ key, off }) => localStorage.setItem(key, JSON.stringify(off)),
    { key: MODULES_OFF_KEY, off },
  );
}

/**
 * Minimal server-origin activity row (ADR-0011, issue #186) — just enough to make
 * `activities.length > 0` true, so the `aktivitaeten`-off assertions below prove the
 * registry gate, not the strip's own empty-data guard (issue #180) that would hide
 * it anyway.
 */
async function seedGarminActivity(): Promise<void> {
  await withDb((client) =>
    client.query(
      `INSERT INTO garmin_activities
        (id, updated_at, deleted_at, synced_at, sync_seq, garmin_activity_id, activity_type, started_at, fetched_at)
       VALUES ($1, now(), NULL, now(), nextval('sync_seq'), $2, $3, $4, now())`,
      [randomUUID(), Math.floor(Math.random() * 1_000_000_000), 'running', '2020-01-01T00:00:00Z'],
    ),
  );
}

async function topOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Element muss sichtbar sein, um seine Position zu messen');
  return box.y;
}

test.beforeEach(async ({ page }) => {
  await registerPasskey(page);
});

test('Auslieferungszustand: alle Module an, sechs Tabs sichtbar (issue #307 AC1)', async ({ page }) => {
  await page.goto('/uebersicht');

  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await expect(nav.locator('.nav__item')).toHaveCount(6);
});

test('ein Modul abschalten blendet seinen Tab aus, ohne die übrigen zu verändern (issue #307 AC2)', async ({
  page,
}) => {
  await page.goto('/einstellungen');
  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });

  await expect(nav.getByRole('link', { name: 'Journal' })).toBeVisible();
  await page.getByRole('switch', { name: 'Journal' }).click();

  await expect(nav.getByRole('link', { name: 'Journal' })).toHaveCount(0);
  await expect(nav.locator('.nav__item')).toHaveCount(5);
  for (const label of ['Übersicht', 'Aufgaben', 'Gewohnheiten', 'Kalender', 'Aktivitäten']) {
    await expect(nav.getByRole('link', { name: label })).toBeVisible();
  }
});

test('Journal aus archiviert die Journal-Gewohnheit, wieder an entarchiviert sie (issue #505 AC7)', async ({
  page,
}) => {
  await resetAppData();
  await page.goto('/uebersicht');

  // Wait for JournalHabitBoot's idempotent ensure to land locally, then push it —
  // mutate() itself schedules no sync, so without this the row might not have
  // reached the outbox yet when the explicit sync() below runs.
  await expect
    .poll(async () => {
      const records = await page.evaluate(() => window.__starship.debugRecords());
      return records.some((r) => r.table === 'habits' && r.data.name === 'Journal');
    })
    .toBe(true);
  await page.evaluate(() => window.__starship.sync());

  const before = await withDb((client) =>
    client.query('SELECT id, archived_at FROM habits WHERE name = $1', ['Journal']),
  );
  expect(before.rowCount).toBe(1);
  expect(before.rows[0].archived_at).toBeNull();
  const habitId = before.rows[0].id as string;

  await page.goto('/einstellungen');
  await page.getByRole('switch', { name: 'Journal' }).click();
  await page.evaluate(() => window.__starship.sync());

  const afterOff = await withDb((client) =>
    client.query('SELECT archived_at FROM habits WHERE id = $1', [habitId]),
  );
  expect(afterOff.rows[0].archived_at).not.toBeNull();

  await page.getByRole('switch', { name: 'Journal' }).click();
  await page.evaluate(() => window.__starship.sync());

  const afterOn = await withDb((client) =>
    client.query('SELECT archived_at FROM habits WHERE id = $1', [habitId]),
  );
  expect(afterOn.rows[0].archived_at).toBeNull();
});

test('wieder anschalten stellt den Tab an derselben Position wieder her (issue #307 AC3)', async ({ page }) => {
  await page.goto('/einstellungen');
  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  const labelsBefore = await nav.locator('.nav__label').allInnerTexts();

  await page.getByRole('switch', { name: 'Kalender' }).click();
  await expect(nav.getByRole('link', { name: 'Kalender' })).toHaveCount(0);

  await page.getByRole('switch', { name: 'Kalender' }).click();
  await expect(nav.locator('.nav__label')).toHaveCount(6);
  const labelsAfter = await nav.locator('.nav__label').allInnerTexts();
  expect(labelsAfter).toEqual(labelsBefore);
});

test('core-Module (Übersicht, Einstellungen) haben keinen Schalter, Einstellungen bleibt erreichbar (issue #307 AC4)', async ({
  page,
}) => {
  await page.goto('/einstellungen');

  await expect(page.getByRole('switch', { name: 'Übersicht' })).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Einstellungen' })).toHaveCount(0);
  await expect(
    page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Übersicht' }),
  ).toBeVisible();

  // Der Einstellungen-Einstieg selbst lebt in AppHeader, nicht in der Nav (issue #126):
  // `chrome` ist ab 768px in der Shell sichtbar, `inline` nur auf /uebersicht mobil.
  // Auf /einstellungen ist auf Mobile design-bedingt keiner der beiden sichtbar — die
  // Erreichbarkeit prüft sich von dort, wo der Einstieg tatsächlich lebt.
  await page.goto('/uebersicht');
  await expect(page.getByRole('link', { name: 'Einstellungen' })).toBeVisible();
});

test('der Zustand übersteht einen Reload (issue #307 AC5)', async ({ page }) => {
  await page.goto('/einstellungen');
  await page.getByRole('switch', { name: 'Gewohnheiten' }).click();
  await expect(page.getByRole('switch', { name: 'Gewohnheiten' })).toHaveAttribute('aria-checked', 'false');

  await page.reload();
  await expect(page.getByRole('switch', { name: 'Gewohnheiten' })).toHaveAttribute('aria-checked', 'false');
  await expect(
    page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Gewohnheiten' }),
  ).toHaveCount(0);
});

test('offline: Umschalten ist eine reine localStorage-Mutation, keine Outbox-Op (issue #307 AC6)', async ({
  page,
  context,
}) => {
  await page.goto('/einstellungen');
  await context.setOffline(true);

  await page.getByRole('switch', { name: 'Aktivitäten' }).click();
  await expect(page.getByRole('switch', { name: 'Aktivitäten' })).toHaveAttribute('aria-checked', 'false');

  const pendingSize = await page.evaluate(() => window.__starship.size());
  expect(pendingSize).toBe(0);

  await context.setOffline(false);
});

test('Dark Mode: Schalter nutzt Tokens statt Rohfarben, reduzierte Bewegung bleibt bedienbar (issue #307 AC7)', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/einstellungen');

  const toggle = page.getByRole('switch', { name: 'Wetter' });
  const trackColor = await toggle.evaluate((el) => getComputedStyle(el, '::before').backgroundColor);
  expect(trackColor).not.toBe('');
  expect(trackColor).not.toBe('rgba(0, 0, 0, 0)');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
});

test('ein zuvor abgeschaltetes Modul bleibt über einen frischen Ausschlussschlüssel hinweg konsistent (Regression, issue #307)', async ({
  page,
}) => {
  await setModulesOff(page, ['aufgaben']);
  await page.goto('/uebersicht');

  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await expect(nav.getByRole('link', { name: 'Aufgaben' })).toHaveCount(0);
  await expect(nav.locator('.nav__item')).toHaveCount(5);
});

/* -------------------------------------------------------------------------- */
/* T2 (issue #308): Übersicht + Einstellungen deklarativ aus der Registry     */
/* -------------------------------------------------------------------------- */

test('aufgaben aus blendet die Aufgaben-Sektion auf der Übersicht und das Spracherfassungs-Panel in den Einstellungen aus (issue #308 AC1)', async ({
  page,
}) => {
  await page.goto('/einstellungen');
  await expect(page.getByRole('heading', { name: 'Spracherfassung', level: 2 })).toBeVisible();

  await page.getByRole('switch', { name: 'Aufgaben' }).click();
  await expect(page.getByRole('heading', { name: 'Spracherfassung', level: 2 })).toHaveCount(0);

  await page.goto('/uebersicht');
  await expect(page.getByRole('heading', { name: 'Aufgaben', level: 2 })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Aufgaben' })).toHaveCount(0);
});

test('wetter aus blendet den Wetter-Streifen auf der Übersicht und das Wetter-Panel in den Einstellungen aus (issue #308 AC2)', async ({
  page,
}) => {
  await page.goto('/einstellungen');
  await expect(page.getByRole('heading', { name: 'Wetter', level: 2 })).toBeVisible();

  await page.getByRole('switch', { name: 'Wetter' }).click();
  await expect(page.getByRole('heading', { name: 'Wetter', level: 2 })).toHaveCount(0);

  await page.goto('/uebersicht');
  await expect(page.locator('.weather-forecast')).toHaveCount(0);
});

test('export aus blendet das Export-Panel aus — die Export-Fähigkeit selbst bleibt unverändert, src/features/export/export.ts wird nicht angefasst (issue #308 AC3)', async ({
  page,
}) => {
  await page.goto('/einstellungen');
  await expect(page.getByRole('heading', { name: 'Daten', level: 2 })).toBeVisible();

  await page.getByRole('switch', { name: 'Export' }).click();
  await expect(page.getByRole('heading', { name: 'Daten', level: 2 })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Alles exportieren' })).toHaveCount(0);
});

test('aktivitaeten aus blendet den Monatsstreifen aus, auch wenn Aktivitäten vorhanden sind (issue #308 AC4)', async ({
  page,
}) => {
  await resetAppData();
  await seedGarminActivity();

  await page.goto('/uebersicht');
  await expect(page.locator('.activity-month-strip')).toBeVisible();

  await page.goto('/einstellungen');
  await page.getByRole('switch', { name: 'Aktivitäten' }).click();

  await page.goto('/uebersicht');
  await expect(page.locator('.activity-month-strip')).toHaveCount(0);
});

test('Reihenfolge der aktiven Sektionen bleibt Wetter→Aufgaben→Aktivitäten→Gewohnheiten, auch wenn eine mittendrin fehlt (issue #308 AC5)', async ({
  page,
}) => {
  await resetAppData();
  await seedGarminActivity();
  await page.route(OPEN_METEO_PATTERN, (route) =>
    route.fulfill({ json: openMeteoForecastBody({ dates: ['2026-07-28'], tempsMax: [20], tempsMin: [10] }) }),
  );

  await page.goto('/uebersicht');
  const wetter = page.locator('.weather-forecast');
  const aufgaben = page.getByRole('heading', { name: 'Aufgaben', level: 2 });
  const aktivitaeten = page.locator('.activity-month-strip');
  const gewohnheiten = page.getByRole('heading', { name: 'Gewohnheiten', level: 2 });

  await expect(wetter).toBeVisible();
  await expect(aktivitaeten).toBeVisible();

  const [wetterY, aufgabenY, aktivitaetenY, gewohnheitenY] = await Promise.all([
    topOf(wetter),
    topOf(aufgaben),
    topOf(aktivitaeten),
    topOf(gewohnheiten),
  ]);
  expect(wetterY).toBeLessThan(aufgabenY);
  expect(aufgabenY).toBeLessThan(aktivitaetenY);
  expect(aktivitaetenY).toBeLessThan(gewohnheitenY);

  // Aufgaben (mittendrin) abschalten — die übrigen drei behalten ihre Reihenfolge,
  // statt in der falschen Sequenz aufzurücken.
  await page.goto('/einstellungen');
  await page.getByRole('switch', { name: 'Aufgaben' }).click();
  await page.goto('/uebersicht');
  await expect(aufgaben).toHaveCount(0);

  const [wetterY2, aktivitaetenY2, gewohnheitenY2] = await Promise.all([
    topOf(wetter),
    topOf(aktivitaeten),
    topOf(gewohnheiten),
  ]);
  expect(wetterY2).toBeLessThan(aktivitaetenY2);
  expect(aktivitaetenY2).toBeLessThan(gewohnheitenY2);
});

test('offline: aufgaben abschalten bleibt eine reine localStorage-Mutation, keine Outbox-Op — die Übersicht-Sektion folgt beim nächsten (Online-)Laden derselben Registry-Prüfung wie die anderen Module (issue #308, Regression zu #307 AC6)', async ({
  page,
  context,
}) => {
  await page.goto('/einstellungen');
  await context.setOffline(true);

  await page.getByRole('switch', { name: 'Aufgaben' }).click();
  await expect(page.getByRole('switch', { name: 'Aufgaben' })).toHaveAttribute('aria-checked', 'false');

  const pendingSize = await page.evaluate(() => window.__starship.size());
  expect(pendingSize).toBe(0);

  await context.setOffline(false);
  await page.goto('/uebersicht');
  await expect(page.getByRole('heading', { name: 'Aufgaben', level: 2 })).toHaveCount(0);
});

test('Dark Mode + reduzierte Bewegung: ein abgeschaltetes Modul bleibt in beiden Zuständen ausgeblendet (issue #308)', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('/einstellungen');

  await page.getByRole('switch', { name: 'Wetter' }).click();
  await expect(page.getByRole('heading', { name: 'Wetter', level: 2 })).toHaveCount(0);

  await page.goto('/uebersicht');
  await expect(page.locator('.weather-forecast')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* T3 (issue #309): Route-Guard + Flacker-Schutz für abgeschaltete Module     */
/* -------------------------------------------------------------------------- */

test('Direktaufruf einer Aus-Route landet auf /uebersicht, kein 404 (issue #309 AC1)', async ({ page }) => {
  await setModulesOff(page, ['journal']);

  const response = await page.goto('/journal');

  expect(response?.status()).toBeLessThan(400);
  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(page.getByRole('heading', { name: 'Übersicht', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Journal', level: 1 })).toHaveCount(0);
});

test('kein Aufblitzen: der Seiten-Wrapper einer Aus-Route ist schon vor der Hydration unsichtbar (issue #309 AC1)', async ({
  page,
}) => {
  await setModulesOff(page, ['journal']);

  // Blockiert jedes Skript — die Seite bleibt dauerhaft unhydriert, der clientseitige
  // Guard (module-route-guard.tsx, läuft erst nach der Hydration) kann also nie feuern.
  // Was übrig bleibt, ist einzig das, was das serverseitig gerenderte HTML plus die
  // Bootstrap-Inline-Skript+CSS-Kombination (data-modules-off, globals.css) ohne jede
  // weitere Ausführung liefern — genau der Mechanismus, der das Aufblitzen verhindert,
  // isoliert von der Umleitung selbst (die deckt der Test oben ab).
  await page.route('**/*', (route) =>
    route.request().resourceType() === 'script' ? route.abort() : route.continue(),
  );

  await page.goto('/journal');

  const wrapper = page.locator('[data-module="journal"]');
  await expect(wrapper).toBeAttached();
  await expect(wrapper).toBeHidden();
});

test('ein aktives Modul bleibt über seine Route direkt erreichbar (issue #309 AC3)', async ({ page }) => {
  await page.goto('/journal');

  await expect(page).toHaveURL(/\/journal$/);
  await expect(page.getByRole('heading', { name: 'Journal', level: 1 })).toBeVisible();
});

test('core-Routen werden nie umgeleitet, auch wenn andere Module aus sind (issue #309 AC4)', async ({ page }) => {
  await setModulesOff(page, ['journal', 'kalender', 'gewohnheiten', 'aufgaben', 'aktivitaeten']);

  await page.goto('/uebersicht');
  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(page.getByRole('heading', { name: 'Übersicht', level: 1 })).toBeVisible();

  await page.goto('/einstellungen');
  await expect(page).toHaveURL(/\/einstellungen$/);
  await expect(page.getByRole('heading', { name: 'Einstellungen', level: 1 })).toBeVisible();
});

test('Dark Mode + reduzierte Bewegung: die Umleitung einer Aus-Route funktioniert unverändert (issue #309 AC5)', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await setModulesOff(page, ['journal']);

  await page.goto('/journal');

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(page.getByRole('heading', { name: 'Übersicht', level: 1 })).toBeVisible();
});
