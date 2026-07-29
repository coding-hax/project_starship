import { expect, test, type Locator, type Page } from '@playwright/test';
import { openMeteoForecastBody, registerPasskey, resetAppData, skewClock } from './helpers';

/** Fixes "now" so due-today vs. overdue vs. future is deterministic (issue #87). */
const NOW = '2026-07-18T12:00:00.000Z';
const YESTERDAY_MORNING = '2026-07-17T09:00:00.000Z';
const YESTERDAY_EVENING = '2026-07-17T18:00:00.000Z';
const TODAY_EVENING = '2026-07-18T18:00:00.000Z';
const TOMORROW_MORNING = '2026-07-19T09:00:00.000Z';
/** Same wall-clock moment as NOW, one day later — for the day-change assertions. */
const TOMORROW_NOON = '2026-07-19T12:00:00.000Z';
const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';

function dueTaskItems(page: Page) {
  // Labelled by the visible <h2>Aufgaben</h2> above it, not its own aria-label
  // (issue #157 AC: no double announcement).
  return page.getByRole('list', { name: 'Aufgaben' }).getByRole('listitem');
}

/** Vertical distance between the bottom of `above` and the top of `below`. */
async function gapBetween(above: Locator, below: Locator): Promise<number> {
  const top = await above.boundingBox();
  const bottom = await below.boundingBox();
  if (!top || !bottom) throw new Error('Beide Überschriften müssen sichtbar sein');
  return bottom.y - (top.y + top.height);
}

async function seedTask(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: p }),
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

test('/uebersicht listet offene Aufgaben, fällig heute oder überfällig (issue #87 AC1)', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  await seedTask(page, { title: 'Überfällig', dueAt: YESTERDAY_MORNING });
  await seedTask(page, { title: 'Heute fällig', dueAt: TODAY_EVENING });
  await seedTask(page, { title: 'Erst morgen', dueAt: TOMORROW_MORNING });
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
  // Never listed while open, so being checked off today does not pull it in
  // (issue #228 AC4).
  await seedTask(page, {
    title: 'Morgen fällig, heute erledigt',
    dueAt: TOMORROW_MORNING,
    completedAt: NOW,
  });

  await expect(page.getByText('Überfällig')).toBeVisible();
  await expect(page.getByText('Heute fällig')).toBeVisible();
  // Checked off today, so it stays for the rest of the day (issue #228 AC1).
  await expect(page.getByText('Heute erledigt')).toBeVisible();
  await expect(dueTaskItems(page)).toHaveCount(3);
  await expect(page.getByText('Erst morgen')).toHaveCount(0);
  await expect(page.getByText('Ohne Fälligkeit')).toHaveCount(0);
  await expect(page.getByText('Gestern erledigt')).toHaveCount(0);
  await expect(page.getByText('Morgen fällig, heute erledigt')).toHaveCount(0);
});

test('ein gestalteter Leerzustand statt einer leeren Fläche (issue #87 AC2)', async ({ page }) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Erst morgen', dueAt: TOMORROW_MORNING });

  await expect(page.getByText('Nichts fällig. Genieß den Tag.')).toBeVisible();
});

test('die Übersicht-Liste nutzt dieselbe TaskItem-Zeile wie /aufgaben — das Häkchen erledigt sofort, die Zeile bleibt den Tag über stehen (issue #87 AC3, issue #228 AC1+AC5)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Wird erledigt', dueAt: YESTERDAY_MORNING, priority: 2 });

  await expect(dueTaskItems(page).locator('.task-list__priority-dot')).toHaveClass(
    /task-list__priority-dot--dringend/,
  );
  // Overdue while open — red. After the check-off it must not shout any more.
  await expect(dueTaskItems(page).locator('.task-list__due')).toHaveClass(
    /task-list__due--overdue/,
  );

  const checkbox = page.getByRole('checkbox', { name: 'Wird erledigt als erledigt markieren' });
  await checkbox.click();

  // Not `page.getByText('Wird erledigt')` — the undo toast's own text ("„Wird
  // erledigt" erledigt") contains that same substring, scoped to the list instead.
  await expect(dueTaskItems(page)).toHaveCount(1);
  await expect(dueTaskItems(page).first()).toHaveClass(/task-list__item--done/);
  await expect(checkbox).toBeChecked();
  await expect(dueTaskItems(page).locator('.task-list__due')).not.toHaveClass(
    /task-list__due--overdue/,
  );
  await expect(page.getByText('Nichts fällig. Genieß den Tag.')).toHaveCount(0);

  // The row stays reachable, so the same tap takes it back (issue #228 AC5).
  await checkbox.click();
  await expect(dueTaskItems(page)).toHaveCount(1);
  await expect(checkbox).not.toBeChecked();
  await expect(dueTaskItems(page).first()).not.toHaveClass(/task-list__item--done/);
});

test('am Folgetag ist die gestern abgehakte Aufgabe aus der Übersicht verschwunden (issue #228 AC2+AC3)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Wird erledigt', dueAt: YESTERDAY_MORNING });

  await page.getByRole('checkbox', { name: 'Wird erledigt als erledigt markieren' }).click();
  await expect(dueTaskItems(page)).toHaveCount(1);

  await skewClock(page, TOMORROW_NOON);
  await page.reload();

  await expect(dueTaskItems(page)).toHaveCount(0);
  await expect(page.getByText('Nichts fällig. Genieß den Tag.')).toBeVisible();
});

test('ohne fällige Aufgabe rückt der Leerzustand nicht auseinander — der Abstand zwischen den Abschnitten bleibt wie mit einer Aufgabe (issue #228 AC6)', async ({
  page,
}) => {
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/uebersicht');

    const aufgaben = page.getByRole('heading', { name: 'Aufgaben', level: 2 });
    const gewohnheiten = page.getByRole('heading', { name: 'Gewohnheiten', level: 2 });
    await expect(page.getByText('Nichts fällig. Genieß den Tag.')).toBeVisible();
    const emptyGap = await gapBetween(aufgaben, gewohnheiten);

    const id = await seedTask(page, { title: 'Eine Aufgabe', dueAt: YESTERDAY_MORNING });
    await expect(dueTaskItems(page)).toHaveCount(1);
    const filledGap = await gapBetween(aufgaben, gewohnheiten);

    // The empty state occupies one card's box, so the two gaps differ by rounding
    // at most. Anything beyond that is the hole this ticket is about — the numbers
    // travel in the message, so a red run says how far off it is.
    expect(
      Math.abs(emptyGap - filledGap),
      `leer ${emptyGap}px vs. mit Aufgabe ${filledGap}px bei ${width}px`,
    ).toBeLessThanOrEqual(8);

    await page.evaluate(
      (rowId) => window.__starship.mutate({ table: 'tasks', rowId, op: 'delete' }),
      id,
    );
    await expect(dueTaskItems(page)).toHaveCount(0);
  }
});

test('kein "Gewohnheiten verwalten"-Link mehr auf /uebersicht — der Nav-Tab bleibt der Weg (issue #137 AC1+AC2)', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  await expect(page.getByRole('link', { name: 'Gewohnheiten verwalten' })).toHaveCount(0);

  await page
    .getByRole('navigation', { name: 'Hauptnavigation' })
    .getByRole('link', { name: 'Gewohnheiten' })
    .click();
  await expect(page).toHaveURL(/\/gewohnheiten$/);
  await expect(
    page.getByRole('heading', { name: 'Gewohnheiten verwalten', level: 1 }),
  ).toBeVisible();
});

test('über der Aufgabenliste steht ein sichtbares <h2>Aufgaben</h2>, gestaltet wie „Gewohnheiten" (issue #157 AC5)', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  const aufgabenHeading = page.getByRole('heading', { name: 'Aufgaben', level: 2 });
  const gewohnheitenHeading = page.getByRole('heading', { name: 'Gewohnheiten', level: 2 });
  await expect(aufgabenHeading).toBeVisible();
  await expect(gewohnheitenHeading).toBeVisible();

  const [aufgabenStyle, gewohnheitenStyle] = await Promise.all([
    aufgabenHeading.evaluate((el) => {
      const s = getComputedStyle(el);
      return { fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color, margin: s.margin };
    }),
    gewohnheitenHeading.evaluate((el) => {
      const s = getComputedStyle(el);
      return { fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color, margin: s.margin };
    }),
  ]);
  expect(aufgabenStyle).toEqual(gewohnheitenStyle);
});

test('die Aufgabenliste wird nicht doppelt angesagt — die Überschrift benennt sie statt eines eigenen aria-label (issue #157 AC6)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Heute fällig', dueAt: TODAY_EVENING });

  const list = page.getByRole('list', { name: 'Aufgaben' });
  await expect(list).toBeVisible();
  await expect(list).toHaveAttribute('aria-labelledby', 'uebersicht-aufgaben-heading');
  expect(await list.getAttribute('aria-label')).toBeNull();
});

test('Tab-Sonne und Wetter-Sonne sind auf demselben Bildschirm eindeutig unterscheidbar (issue #157 AC3)', async ({
  page,
}) => {
  const dates = [
    '2026-07-18',
    '2026-07-19',
    '2026-07-20',
    '2026-07-21',
    '2026-07-22',
    '2026-07-23',
    '2026-07-24',
  ];
  await page.route(OPEN_METEO_PATTERN, (route) =>
    route.fulfill({
      json: openMeteoForecastBody({
        dates,
        weatherCodes: dates.map(() => 0), // 0 = klar -> IconWeatherClear
        tempsMax: dates.map(() => 20),
        tempsMin: dates.map(() => 10),
      }),
    }),
  );
  await page.goto('/uebersicht');

  const todaySunSvg = page
    .getByRole('navigation', { name: 'Hauptnavigation' })
    .getByRole('link', { name: 'Übersicht' })
    .locator('svg');
  const weatherSunSvg = page.getByRole('img', { name: 'Klar' }).first().locator('svg');
  await expect(weatherSunSvg).toBeVisible();

  const [todayCircleR, weatherCircleR, todayPathD, weatherPathD] = await Promise.all([
    todaySunSvg.locator('circle').first().getAttribute('r'),
    weatherSunSvg.locator('circle').first().getAttribute('r'),
    todaySunSvg.locator('path').first().getAttribute('d'),
    weatherSunSvg.locator('path').first().getAttribute('d'),
  ]);
  expect(todayCircleR).not.toBe(weatherCircleR);
  expect(todayPathD).not.toBe(weatherPathD);
});

/* -------------------------------------------------------------------------- */
/* issue #342 (S5 von #302): Journal-Sektion "heute schon geschrieben?"       */
/* -------------------------------------------------------------------------- */

function journalSection(page: Page) {
  return page.locator('.journal-today-section');
}

async function setUpJournal(page: Page, passphrase: string) {
  await page.goto('/journal');
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('Passphrase wiederholen').fill(passphrase);
  await page.getByRole('button', { name: 'Einrichten' }).click();
  await page.getByTestId('journal-recovery-key').waitFor();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();
}

/**
 * The mood tap saves via a fire-and-forget `saveJournalEntry` (issue #340) — a
 * `page.reload()`/navigation right after `.click()` would race that write. Polls
 * the real IndexedDB record instead of a fixed wait.
 */
async function waitForJournalEntryWritten(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page
        .evaluate(() => window.__starship.debugRecords())
        .then((records) => records.some((r) => r.table === 'journal_entries')),
    )
    .toBe(true);
}

test('Journal-Sektion zeigt "noch nicht geschrieben", bis heute ein Eintrag existiert (issue #342 AC1)', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  await expect(journalSection(page)).toContainText('Heute noch nicht geschrieben');

  await setUpJournal(page, 'ac1 passphrase');
  await page.getByRole('button', { name: '7' }).click(); // Stimmungspunkt in der MoodScale
  await waitForJournalEntryWritten(page);
  await page.goto('/uebersicht');

  await expect(journalSection(page)).toContainText('Heute geschrieben');
});

test('gesperrtes Journal zeigt weiterhin den korrekten (binären) Zustand, die Übersicht bleibt bedienbar (issue #342 AC2)', async ({
  page,
}) => {
  await setUpJournal(page, 'ac2 passphrase');
  await page.getByRole('button', { name: '3' }).click();
  await waitForJournalEntryWritten(page);

  await page.reload(); // Default: nicht speicherresident (issue #339 AC4) -> sperrt wieder
  await page.goto('/uebersicht');

  // Gesperrt: die reichere Stimmungsangabe (AC4) fällt auf die binäre Form zurück,
  // statt eine veraltete oder falsche Stimmung zu zeigen.
  await expect(journalSection(page)).toContainText('Heute geschrieben');
  await expect(journalSection(page)).not.toContainText('Stimmung');

  // "Kalender", not "Aufgaben": Next 16's dev-only "Issues" indicator (unrelated to
  // this app, not gated by `devIndicators: false` — every /uebersicht visit here logs
  // the mocked weather-fetch failure as one such "issue") renders bottom-left on
  // mobile and covers the two leftmost tabs, "Übersicht" and "Aufgaben".
  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await nav.getByRole('link', { name: 'Kalender' }).click();
  await expect(page).toHaveURL(/\/kalender$/);
});

test('bei entsperrtem Journal wird die Sektion reicher — sie zeigt die Stimmung des Tages (issue #342 AC4)', async ({
  page,
}) => {
  await setUpJournal(page, 'ac4 passphrase');
  await page.getByRole('button', { name: '9' }).click();
  await waitForJournalEntryWritten(page);
  // A client-side nav click (not page.goto, a hard navigation) — the DEK lives
  // only in an in-memory module variable (ADR-0016), so a real reload would
  // re-lock by default (issue #339 AC5) and this AC would be untestable.
  await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Übersicht' }).click();

  await expect(journalSection(page)).toContainText('Stimmung 9/10');
});

test('Tippen auf die Sektion führt zum heutigen Eintrag (issue #342 AC5)', async ({ page }) => {
  await page.goto('/uebersicht');

  await journalSection(page).click();
  await expect(page).toHaveURL(/\/journal$/);
  await expect(page.getByRole('heading', { name: 'Journal', level: 1 })).toBeVisible();
});

test('Journal-Modul aus blendet die Sektion auf der Übersicht aus (issue #342 AC6)', async ({ page }) => {
  await page.goto('/uebersicht');
  await expect(journalSection(page)).toBeVisible();

  await page.goto('/einstellungen');
  await page.getByRole('switch', { name: 'Journal' }).click();

  await page.goto('/uebersicht');
  await expect(journalSection(page)).toHaveCount(0);
});

test('Journal-Sektion auf Mobile und Desktop, Dark Mode und reduzierte Bewegung (issue #342 AC7)', async ({
  page,
}) => {
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/uebersicht');
    await expect(journalSection(page)).toBeVisible();
  }

  const lightColor = await journalSection(page).evaluate(
    (el) => getComputedStyle(el.querySelector('.journal-today-section__heading')!).color,
  );

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.reload();
  await expect(journalSection(page)).toBeVisible();
  const darkColor = await journalSection(page).evaluate(
    (el) => getComputedStyle(el.querySelector('.journal-today-section__heading')!).color,
  );

  expect(darkColor).not.toBe(lightColor);
});

/* -------------------------------------------------------------------------- */
/* issue #363: zwei Links mit dem zugänglichen Namen "Journal" (Fund aus #342) */
/* -------------------------------------------------------------------------- */

/**
 * Alle zugänglichen Namen von role=link auf der Seite, per echter
 * Accessibility-Tree-Berechnung (`ariaSnapshot`, YAML-artig: jede Zeile mit
 * einer Link-Rolle trägt den Namen in Anführungszeichen, z. B. `- link "Journal"`).
 */
async function linkAccessibleNames(page: Page): Promise<string[]> {
  const snapshot = await page.locator('body').ariaSnapshot();
  return [...snapshot.matchAll(/-\s*link "([^"]*)"/g)].map((match) => match[1]);
}

test('die Journal-Sektion hat einen eigenen zugänglichen Namen statt des nackten "Journal" wie der Nav-Eintrag (issue #363 AC1)', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  await expect(
    page.getByRole('link', { name: 'Journal — heute noch nicht geschrieben', exact: true }),
  ).toBeVisible();

  await setUpJournal(page, '363 passphrase');
  await page.getByRole('button', { name: '7' }).click(); // Stimmungspunkt in der MoodScale
  await waitForJournalEntryWritten(page);
  // Client-seitige Navigation statt page.goto: der DEK lebt nur in-memory
  // (ADR-0016), ein harter Reload würde wieder sperren (issue #339 AC5).
  await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Übersicht' }).click();

  await expect(
    page.getByRole('link', {
      name: 'Journal — heute geschrieben, Stimmung 7 von 10',
      exact: true,
    }),
  ).toBeVisible();
});

test('kein zugänglicher Name hängt auf /uebersicht doppelt an zwei Links (issue #363 AC2)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await expect(journalSection(page)).toBeVisible();

  const names = await linkAccessibleNames(page);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);

  expect(duplicates, `doppelte Linknamen: ${duplicates.join(', ')}`).toEqual([]);
});
