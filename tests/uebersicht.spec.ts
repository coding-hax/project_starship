import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  freezeClock,
  openMeteoForecastBody,
  registerPasskey,
  resetAppData,
  skewClock,
} from './helpers';

/** Fixes "now" so due-today vs. overdue vs. future is deterministic (issue #87). */
const NOW = '2026-07-18T12:00:00.000Z';
const YESTERDAY_MORNING = '2026-07-17T09:00:00.000Z';
const YESTERDAY_EVENING = '2026-07-17T18:00:00.000Z';
const TODAY_EVENING = '2026-07-18T18:00:00.000Z';
const TOMORROW_MORNING = '2026-07-19T09:00:00.000Z';
/** Same wall-clock moment as NOW, one day later — for the day-change assertions. */
const TOMORROW_NOON = '2026-07-19T12:00:00.000Z';
/** Innerhalb des 7-Tage-Fensters (heute + 2), aber weder heute noch morgen (issue #762). */
const WITHIN_WEEK = '2026-07-20T09:00:00.000Z';
/** Außerhalb des 7-Tage-Fensters (heute + 9) — der 25.07. (heute + 7) ist die erste
 *  ausgeschlossene Kalendertag-Grenze, dieses Datum liegt sicher jenseits davon. */
const BEYOND_WEEK = '2026-07-27T09:00:00.000Z';
const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';

function dueTaskItems(page: Page) {
  // Labelled by the visible <h2>Aufgaben</h2> above it, not its own aria-label
  // (issue #157 AC: no double announcement). A group card's outer `<li>` renders
  // `role="presentation"` (task-list.tsx, issue #866), so it never counts as a
  // `listitem` here — only the task rows nested inside it do.
  return page.getByRole('list', { name: 'Aufgaben' }).getByRole('listitem');
}

/** A group card's title (issue #866) — "Überfällig"/"Heute"/"Diese Woche". */
function groupTitles(page: Page) {
  return page.locator('.task-list__group-title');
}

function undatedCard(page: Page) {
  return page.getByRole('button', { name: /Aufgabe(n)? ohne Datum/ });
}

function disclosureFor(page: Page, title: string) {
  return dueTaskItems(page)
    .filter({ hasText: title })
    .getByRole('button', { name: /Unteraufgaben/ });
}

function progressFor(page: Page, title: string) {
  return dueTaskItems(page).filter({ hasText: title }).locator('.task-list__progress');
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
  await expect(page.getByText('Heute erledigt', { exact: true })).toBeVisible();
  await expect(page.getByText('Morgen fällig, heute erledigt')).toBeVisible();
  await expect(dueTaskItems(page)).toHaveCount(5);
  await expect(page.getByText('Außerhalb der Woche')).toHaveCount(0);
  // Undatiert steht nicht in der Liste — nur in der ausklappbaren Karte (issue #762).
  await expect(dueTaskItems(page).filter({ hasText: 'Ohne Fälligkeit' })).toHaveCount(0);
  await expect(page.getByText('Gestern erledigt')).toHaveCount(0);

  // Karten: Überfällig zuerst, dann Heute/Diese Woche (issue #762, drei feste
  // Buckets statt einer Marke je Tag seit issue #866).
  const titles = groupTitles(page);
  await expect(titles.first()).toHaveText('Überfällig');
  await expect(titles.last()).toHaveText('Diese Woche');
});

test('ein gestalteter Leerzustand statt einer leeren Fläche (issue #87 AC2)', async ({ page }) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Außerhalb der Woche', dueAt: BEYOND_WEEK });

  await expect(page.getByText('Nichts fällig. Genieß den Tag.')).toBeVisible();
});

test('undatierte offene Aufgaben stehen nicht in der Woche-Liste, sondern in einer eingeklappten Karte darunter (issue #762)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Ohne Datum A' });
  await seedTask(page, { title: 'Ohne Datum B' });
  // Erledigt und ohne Datum zählt nicht mit — nur offene (analog zu tasks.spec.ts AK6).
  await seedTask(page, { title: 'Ohne Datum, aber erledigt', completedAt: NOW });
  await seedTask(page, { title: 'Heute fällig', dueAt: TODAY_EVENING });

  await expect(dueTaskItems(page)).toHaveCount(1);
  for (const title of ['Ohne Datum A', 'Ohne Datum B', 'Ohne Datum, aber erledigt']) {
    await expect(dueTaskItems(page).filter({ hasText: title })).toHaveCount(0);
  }

  const card = undatedCard(page);
  await expect(card).toHaveText('2 Aufgaben ohne Datum');
  await expect(card).toHaveAttribute('aria-expanded', 'false');
  // `inert` (section-card.tsx) isn't respected by Playwright's role/text engine
  // (checked empirically: getByRole still finds inert rows) — the collapsed
  // *container* is the only element whose own box is genuinely zero-size (CSS
  // grid-template-rows: 0fr), so that is what toBeHidden() must target, found via
  // aria-controls rather than a hardcoded class name.
  const contentId = await card.getAttribute('aria-controls');
  await expect(page.locator(`[id="${contentId}"]`)).toBeHidden();

  await card.click();
  await expect(card).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Ohne Datum A')).toBeVisible();
  await expect(page.getByText('Ohne Datum B')).toBeVisible();
});

test('die Karte für undatierte Aufgaben steht auch dann, wenn diese Woche sonst nichts fällig ist (issue #762)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Ohne Datum' });

  await expect(page.getByText('Nichts fällig. Genieß den Tag.')).toBeVisible();
  const card = undatedCard(page);
  await expect(card).toHaveText('1 Aufgabe ohne Datum');
  await card.click();
  // exact: true — the card's own title text ("1 Aufgabe ohne Datum") is a substring match otherwise.
  await expect(page.getByText('Ohne Datum', { exact: true })).toBeVisible();
});

test('Unteraufgaben starten auf der Übersicht eingeklappt, die Elternzeile zeigt trotzdem ihren Fortschritt (issue #779 AK1)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const parentId = await seedTask(page, { title: 'Elternaufgabe', dueAt: WITHIN_WEEK });
  await seedTask(page, { title: 'Kind A', parentId });
  await seedTask(page, { title: 'Kind B', parentId });

  const disclosure = disclosureFor(page, 'Elternaufgabe');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');

  const childA = dueTaskItems(page).filter({ hasText: 'Kind A' });
  const childB = dueTaskItems(page).filter({ hasText: 'Kind B' });
  await expect(childA).toHaveJSProperty('inert', true);
  await expect(childB).toHaveJSProperty('inert', true);
  expect((await childA.boundingBox())?.height).toBe(0);
  expect((await childB.boundingBox())?.height).toBe(0);

  await expect(progressFor(page, 'Elternaufgabe')).toHaveText('0/2');
});

test('Klick auf den Klapp-Zweig zeigt die Kind-Zeilen mit voller Höhe, erneuter Klick nimmt genau diese Höhe wieder heraus (issue #779 AK2)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const parentId = await seedTask(page, { title: 'Elternaufgabe', dueAt: WITHIN_WEEK });
  await seedTask(page, { title: 'Kind A', parentId });
  await seedTask(page, { title: 'Kind B', parentId });

  const disclosure = disclosureFor(page, 'Elternaufgabe');
  const parentRow = dueTaskItems(page).filter({ hasText: 'Elternaufgabe' });
  const childA = dueTaskItems(page).filter({ hasText: 'Kind A' });
  const childB = dueTaskItems(page).filter({ hasText: 'Kind B' });
  const parentHeight = (await parentRow.boundingBox())!.height;

  await disclosure.click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(childA).toHaveJSProperty('inert', false);
  await expect(childB).toHaveJSProperty('inert', false);
  // Both children share the same row height as the parent — polled since the
  // reveal still runs a max-height transition (task-list.css).
  await expect
    .poll(async () => (await childA.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(parentHeight - 1);
  await expect
    .poll(async () => (await childB.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(parentHeight - 1);

  await disclosure.click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(childA).toHaveJSProperty('inert', true);
  await expect(childB).toHaveJSProperty('inert', true);
  // Polled for the same reason as the reveal above — the collapse also runs
  // over the `max-height` transition (task-list.css), it just runs backwards.
  await expect.poll(async () => (await childA.boundingBox())?.height ?? -1).toBe(0);
  await expect.poll(async () => (await childB.boundingBox())?.height ?? -1).toBe(0);
});

test('abgehakte Unteraufgabe verschwindet auf der Übersicht vollständig beim Zuklappen der Elternaufgabe (issue #782 AK5)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const parentId = await seedTask(page, { title: 'Elternaufgabe', dueAt: WITHIN_WEEK });
  await seedTask(page, { title: 'Kind erledigt', parentId });
  await seedTask(page, { title: 'Kind offen', parentId });

  const disclosure = disclosureFor(page, 'Elternaufgabe');
  // Startet eingeklappt (issue #779 AK1) — erst aufklappen, um die Checkbox zu erreichen.
  await disclosure.click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');

  const doneChild = dueTaskItems(page).filter({ hasText: 'Kind erledigt' });
  await page
    .getByRole('checkbox', { name: 'Kind erledigt als erledigt markieren' })
    .click();
  await expect(doneChild).toHaveClass(/task-list__item--done/);

  await disclosure.click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');

  await expect(doneChild).toBeHidden();
  await expect.poll(() => doneChild.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
});

test('Aufklappen macht die Liste um die Höhe der Kind-Zeilen länger, nicht um nichts (issue #779 AK3)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const parentId = await seedTask(page, { title: 'Elternaufgabe', dueAt: WITHIN_WEEK });
  await seedTask(page, { title: 'Kind A', parentId });
  await seedTask(page, { title: 'Kind B', parentId });

  const list = page.getByRole('list', { name: 'Aufgaben' });
  const disclosure = disclosureFor(page, 'Elternaufgabe');
  const parentRow = dueTaskItems(page).filter({ hasText: 'Elternaufgabe' });
  const childA = dueTaskItems(page).filter({ hasText: 'Kind A' });

  const parentHeight = (await parentRow.boundingBox())!.height;
  const collapsedHeight = (await list.boundingBox())!.height;

  await disclosure.click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await expect
    .poll(async () => (await childA.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(parentHeight - 1);

  const expandedHeight = (await list.boundingBox())!.height;
  // Two child rows' worth of height, not the rounding-error-sized gap the
  // min-height bug (issue #779) would have left.
  expect(expandedHeight - collapsedHeight).toBeGreaterThan(parentHeight * 1.5);
});

test('die Übersicht-Liste nutzt dieselbe TaskItem-Zeile wie /aufgaben — das Häkchen erledigt sofort, die Zeile bleibt den Tag über stehen (issue #87 AC3, issue #228 AC1+AC5)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Wird erledigt', dueAt: YESTERDAY_MORNING, priority: 2 });

  // Overdue and priority 2 at once — precedence (issue #704 AK5) picks the
  // overdue edge, not the priority one.
  await expect(dueTaskItems(page)).toHaveAttribute('data-edge', 'overdue');
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
  // Erledigung muss persistiert sein, bevor der Tag wechselt — sonst lädt der
  // Reload die noch offene (überfällige) Aufgabe und verdeckt die eigentliche Prüfung.
  await expect(
    page.getByRole('checkbox', { name: 'Wird erledigt als erledigt markieren' }),
  ).toBeChecked();

  // Ein page.reload() setzt die Fake-Uhr auf den im beforeEach installierten
  // Ausgangswert (NOW) zurück, nicht auf das letzte setFixedTime — die neu geladene
  // Übersicht würde sonst weiter „heute" rendern. Neu aufsetzen, damit der frische
  // Load tatsächlich am Folgetag passiert (issue #228 AC2+AC3).
  await page.clock.install({ time: new Date(TOMORROW_NOON) });
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
    const routinen = page.getByRole('heading', { name: 'Routinen', level: 2 });
    await expect(page.getByText('Nichts fällig. Genieß den Tag.')).toBeVisible();
    const emptyGap = await gapBetween(aufgaben, routinen);

    const id = await seedTask(page, { title: 'Eine Aufgabe', dueAt: YESTERDAY_MORNING });
    await expect(dueTaskItems(page)).toHaveCount(1);
    const filledGap = await gapBetween(aufgaben, routinen);

    // The empty state reserves one group card's worth of box — its own padding, a
    // header line, one task row (issue #762, card since issue #866) — so a filled
    // "Woche" list is never just a bare row anymore, and the two gaps differ by
    // rounding at most. Anything beyond that is the hole issue #228 fixed
    // reopening — the numbers travel in the message, so a red run says how far off it is.
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

test('kein "Routinen verwalten"-Link mehr auf /uebersicht — der Nav-Tab bleibt der Weg (issue #137 AC1+AC2)', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  await expect(page.getByRole('link', { name: 'Routinen verwalten' })).toHaveCount(0);

  await page
    .getByRole('navigation', { name: 'Hauptnavigation' })
    .getByRole('link', { name: 'Routinen' })
    .click();
  await expect(page).toHaveURL(/\/routinen$/);
  await expect(
    page.getByRole('heading', { name: 'Routinen verwalten', level: 1 }),
  ).toBeVisible();
});

test('über der Aufgabenliste steht ein sichtbares <h2>Aufgaben</h2>, gestaltet wie „Routinen" (issue #157 AC5)', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  const aufgabenHeading = page.getByRole('heading', { name: 'Aufgaben', level: 2 });
  const routinenHeading = page.getByRole('heading', { name: 'Routinen', level: 2 });
  await expect(aufgabenHeading).toBeVisible();
  await expect(routinenHeading).toBeVisible();

  const [aufgabenStyle, routinenStyle] = await Promise.all([
    aufgabenHeading.evaluate((el) => {
      const s = getComputedStyle(el);
      return { fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color, margin: s.margin };
    }),
    routinenHeading.evaluate((el) => {
      const s = getComputedStyle(el);
      return { fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color, margin: s.margin };
    }),
  ]);
  expect(aufgabenStyle).toEqual(routinenStyle);
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
/* issue #506: Journal-Block von der Übersicht entfernt (Nachfolge #342/#413/ */
/* #363, deren Journal-Kachel-Verhalten hier absichtlich abgeschafft wird —   */
/* die Journal-Zustandsabdeckung liegt seit #505 bei den Routinen-Specs). */
/* -------------------------------------------------------------------------- */

/** Top edge of `locator`'s box — the vertical anchor the order tests compare. */
async function topOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Element muss für den Reihenfolge-Vergleich sichtbar sein');
  return box.y;
}

test('/uebersicht zeigt bei aktivem Journal-Modul keinen Journal-Block mehr — Nav-Tab und Route bleiben (issue #506 AC1+AC2)', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  await expect(page.locator('.journal-today-section')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Journal' })).toHaveCount(0);

  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await nav.getByRole('link', { name: 'Journal' }).click();
  await expect(page).toHaveURL(/\/journal$/);
  // Titel „Wie war dein Tag?“ seit issue #868 — der Nav-Tab heißt weiterhin „Journal“.
  await expect(page.getByRole('heading', { name: 'Wie war dein Tag?', level: 1 })).toBeVisible();
});

test('die verbleibenden Übersichts-Sektionen behalten ihre Reihenfolge Wetter → Aufgaben → Routinen, ohne Journal dazwischen (issue #506 AC1)', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  // Der Aktivitäten-Streifen zwischen Aufgaben und Routinen erscheint nur mit
  // gesyncten Garmin-Daten (er rendert sonst nichts) — sein Platz in der Reihenfolge
  // ist in aktivitaeten.spec.ts abgedeckt. Hier zählen die drei Sektionen, die auf
  // /uebersicht immer stehen; entscheidend für #506 ist, dass die Journal-Kachel aus
  // ihrer Mitte verschwindet, ohne die übrige Reihenfolge zu verschieben.
  const wetter = page.locator('.weather-forecast');
  const aufgaben = page.getByRole('heading', { name: 'Aufgaben', level: 2 });
  const routinen = page.getByRole('heading', { name: 'Routinen', level: 2 });
  await expect(wetter).toBeVisible();
  await expect(aufgaben).toBeVisible();
  await expect(routinen).toBeVisible();

  const [yWetter, yAufgaben, yRoutinen] = await Promise.all([
    topOf(wetter),
    topOf(aufgaben),
    topOf(routinen),
  ]);
  expect(
    yWetter < yAufgaben && yAufgaben < yRoutinen,
    `Reihenfolge Wetter ${yWetter} → Aufgaben ${yAufgaben} → Routinen ${yRoutinen}`,
  ).toBe(true);

  // Kein Journal-Block irgendwo zwischen den Sektionen.
  await expect(page.locator('.journal-today-section')).toHaveCount(0);
});

test('das Journal-Modul behält seinen Nav-Tab und seine Route — /journal rendert direkt (issue #506 AC2)', async ({
  page,
}) => {
  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await page.goto('/uebersicht');
  await expect(nav.getByRole('link', { name: 'Journal' })).toHaveAttribute('href', '/journal');

  // Direkter Aufruf der Route (kein Klick) — die Route gehört weiterhin dem Modul.
  await page.goto('/journal');
  await expect(page).toHaveURL(/\/journal$/);
  // Titel „Wie war dein Tag?“ seit issue #868 — der Nav-Tab heißt weiterhin „Journal“.
  await expect(page.getByRole('heading', { name: 'Wie war dein Tag?', level: 1 })).toBeVisible();
});

test('das Journal-Modul behält sein Einstellungen-Panel (issue #506 AC2)', async ({ page }) => {
  await page.goto('/einstellungen');

  // Der Modul-Schalter (Journal an/aus) bleibt …
  await expect(page.getByRole('switch', { name: 'Journal' })).toBeVisible();
  // … und das eigene Einstellungen-Panel (SectionCard "Journal", eine echte h2).
  await expect(page.getByRole('heading', { name: 'Journal', level: 2 })).toBeVisible();
  await expect(page.getByText('Auf diesem Gerät entsperrt lassen').first()).toBeVisible();
});

test('nur die OverviewSection entfällt — wird das Journal-Modul abgeschaltet, verschwindet sein Nav-Tab wie zuvor (issue #506 AC2)', async ({
  page,
}) => {
  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await page.goto('/uebersicht');
  await expect(nav.getByRole('link', { name: 'Journal' })).toBeVisible();

  await page.goto('/einstellungen');
  await page.getByRole('switch', { name: 'Journal' }).click();

  await page.goto('/uebersicht');
  await expect(nav.getByRole('link', { name: 'Journal' })).toHaveCount(0);
  // Weiterhin kein Journal-Block — das Abschalten ändert daran nichts.
  await expect(page.locator('.journal-today-section')).toHaveCount(0);

  // Wieder an: der Nav-Tab kommt zurück, die Route ist wieder erreichbar.
  await page.goto('/einstellungen');
  await page.getByRole('switch', { name: 'Journal' }).click();
  await page.goto('/uebersicht');
  await expect(nav.getByRole('link', { name: 'Journal' })).toBeVisible();
});

test('auf /uebersicht hängt der Name "Journal" nicht mehr doppelt an zwei Links — nur der Nav-Tab trägt ihn (Nachfolge #363 AC2)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await expect(page.getByRole('heading', { name: 'Routinen', level: 2 })).toBeVisible();

  // Vor #506 trug die Übersichts-Kachel denselben zugänglichen Namen wie der
  // Nav-Eintrag (der Fund aus #363). Ohne die Kachel bleibt genau ein "Journal"-Link:
  // der Nav-Tab.
  await expect(page.getByRole('link', { name: 'Journal', exact: true })).toHaveCount(1);
});

test('kein Journal-Block auf der Übersicht — auf Mobile (375px) wie auf Desktop (1280px), Reihenfolge bleibt (issue #506 AC1)', async ({
  page,
}) => {
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/uebersicht');

    await expect(page.locator('.journal-today-section')).toHaveCount(0);
    const aufgaben = page.getByRole('heading', { name: 'Aufgaben', level: 2 });
    const routinen = page.getByRole('heading', { name: 'Routinen', level: 2 });
    await expect(aufgaben).toBeVisible();
    await expect(routinen).toBeVisible();
    expect(await topOf(aufgaben), `Aufgaben über Routinen bei ${width}px`).toBeLessThan(
      await topOf(routinen),
    );
  }
});

test('die Übersicht bleibt ohne Journal-Block auch im Dark Mode mit reduzierter Bewegung nutzbar (issue #506 AC1)', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('/uebersicht');

  await expect(page.locator('.journal-today-section')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Aufgaben', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Routinen', level: 2 })).toBeVisible();

  // Die Seite ist bedienbar: der Journal-Nav-Tab führt weiterhin zur Route.
  await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Journal' }).click();
  await expect(page).toHaveURL(/\/journal$/);
});

test('der Übersichts-Inhalt selbst verlinkt nicht mehr aufs Journal — der Weg dorthin ist allein der Nav-Tab (issue #506 AC1)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await expect(page.getByRole('heading', { name: 'Routinen', level: 2 })).toBeVisible();

  // Die frühere Journal-Kachel war ein Link ins Journal *innerhalb* des
  // Seiteninhalts (main), zusätzlich zum Nav-Tab im eigenen Landmark. Ohne die
  // Kachel enthält der Inhalt keinen Journal-Link mehr.
  const main = page.getByRole('main');
  await expect(main.getByRole('link', { name: 'Journal' })).toHaveCount(0);
  await expect(main.locator('a[href="/journal"]')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* issue #559 (S8 von #473): Übersicht-Sektion "Nächster Termin"              */
/* -------------------------------------------------------------------------- */

test('der nächste Termin heute steht groß mit Countdown-Text (issue #559 AC1)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  // NOW = 12:00 UTC = 14:00 Berlin (CEST). +40 Min -> 14:40 Berlin.
  await seedEvent(page, {
    title: 'Zahnarzt',
    allDay: false,
    startsAt: '2026-07-18T12:40:00.000Z',
    endsAt: '2026-07-18T13:10:00.000Z',
    startDate: null,
    endDate: null,
    category: null,
  });

  const next = page.locator('.events-overview__next');
  await expect(next).toBeVisible();
  await expect(next).toContainText('in 40 Min');
  await expect(next).toContainText('Zahnarzt');
});

test('weitere Termine am selben Tag stehen darunter als dünne Zeilen, nicht gleichwertig groß (issue #559 AC2)', async ({
  page,
}) => {
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
  await seedEvent(page, {
    title: 'Teammeeting',
    allDay: false,
    startsAt: '2026-07-18T15:00:00.000Z',
    endsAt: '2026-07-18T16:00:00.000Z',
    startDate: null,
    endDate: null,
    category: null,
  });

  const next = page.locator('.events-overview__next');
  await expect(next).toContainText('Zahnarzt');
  await expect(next).not.toContainText('Teammeeting');

  const restItems = page.locator('.events-overview__rest-item');
  await expect(restItems).toHaveCount(1);
  await expect(restItems.first()).toContainText('Teammeeting');
  await expect(restItems.first()).toContainText('17:00'); // 15:00 UTC = 17:00 Berlin

  // Deutlich kleinere Schrift als die große Anzeige des nächsten Termins.
  const [nextFontSize, restFontSize] = await Promise.all([
    next.locator('.events-overview__next-countdown').evaluate((el) => getComputedStyle(el).fontSize),
    restItems.first().evaluate((el) => getComputedStyle(el).fontSize),
  ]);
  expect(parseFloat(nextFontSize)).toBeGreaterThan(parseFloat(restFontSize));
});

test('ohne weitere Termine heute zeigt die Sektion einen erkennbaren Leerzustand (issue #559 AC3)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  // Ein Termin, der schon vorbei ist, zählt nicht als "weiterer Termin heute".
  await seedEvent(page, {
    title: 'Vorbei',
    allDay: false,
    startsAt: '2026-07-18T09:00:00.000Z',
    endsAt: '2026-07-18T10:00:00.000Z',
    startDate: null,
    endDate: null,
    category: null,
  });

  await expect(page.locator('.events-overview__empty')).toBeVisible();
  await expect(page.getByText('Keine weiteren Termine heute')).toBeVisible();
  await expect(page.locator('.events-overview__next')).toHaveCount(0);
});

test('der Countdown aktualisiert sich mit der Zeit, ohne dass die Seite neu lädt (issue #559 AC4)', async ({
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

test('die Übersicht-Sektion "Nächster Termin" funktioniert auf Mobile (375px) und Desktop (1280px), Dark Mode (issue #559 AC5)', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });

  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/uebersicht');
    const id = await seedEvent(page, {
      title: 'Zahnarzt',
      allDay: false,
      startsAt: '2026-07-18T12:40:00.000Z',
      endsAt: '2026-07-18T13:10:00.000Z',
      startDate: null,
      endDate: null,
      category: null,
    });

    const heading = page.getByRole('heading', { name: 'Termine', level: 2 });
    const next = page.locator('.events-overview__next');
    await expect(heading).toBeVisible();
    await expect(next).toBeVisible();
    await expect(next).toContainText('in 40 Min');

    await page.evaluate(
      (rowId) => window.__starship.mutate({ table: 'events', rowId, op: 'delete' }),
      id,
    );
    await expect(page.locator('.events-overview__empty')).toBeVisible();
  }
});

test('AC4 (issue #651): die Titelzeile trägt den 32px-Titel bei 375px einzeilig, ohne Überlauf', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/uebersicht');

  const h1 = page.locator('.uebersicht__title-row h1');
  await expect(h1).toBeVisible();

  const { clientHeight, lineHeight } = await h1.evaluate((el) => ({
    clientHeight: el.clientHeight,
    lineHeight: parseFloat(getComputedStyle(el).lineHeight),
  }));
  expect(Math.round(clientHeight / lineHeight)).toBe(1);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});

// Ein Test je Route statt einer Schleife in einem Test: jede Navigation bekommt
// ihr eigenes 30s-Zeitbudget (im Dev-Server kompiliert jede Route beim ersten
// Aufruf on-demand) und ein roter Screen ist sofort namentlich zuzuordnen.
for (const path of [
  '/uebersicht',
  '/einstellungen',
  '/aufgaben',
  '/kalender',
  '/journal',
  '/aktivitaeten',
  '/routinen',
]) {
  test(`AC6 (issue #651): ${path} bekommt keinen horizontalen Überlauf bei 375px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} hat horizontalen Überlauf`).toBe(0);
  });
}
