import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  freezeClock,
  openMeteoForecastBody,
  registerPasskey,
  resetAppData,
  skewClock,
  withDb,
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
  // Own `aria-label` "Aufgaben der nächsten 7 Tage" (issue #979 AK3), matched
  // here by the "Aufgaben" substring (issue #157). A group card's outer `<li>`
  // renders `role="presentation"` (task-list.tsx, issue #866), so it never
  // counts as a `listitem` here — only the task rows nested inside it do.
  return page.getByRole('list', { name: 'Aufgaben' }).getByRole('listitem');
}

/** A group card's title (issue #866) — "Überfällig"/"Heute"/"7 Tage". */
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

/** Content anchor for the Aufgaben section (issue #972 AK3: the module `<h2>`
 * is visually hidden) — whichever of list/empty-state is actually rendered. */
function aufgabenContent(page: Page): Locator {
  return page.locator('.task-list, .task-list__empty');
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
  await expect(page.getByText('Heute erledigt', { exact: true })).toBeVisible();
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

test('AK3: /uebersicht zeigt denselben Bucket-Kopf „7 Tage" wie /aufgaben, kein „heute"-Versprechen im Abschnittstitel (issue #979)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'In 3 Tagen', dueAt: WITHIN_WEEK });

  await expect(groupTitles(page)).toHaveText(['7 Tage']);
  // Der Abschnittstitel bleibt "Aufgaben" (visuell versteckt, issue #972 AK3) —
  // kein "heute", wo sieben Tage gemeint sind.
  await expect(page.locator('#uebersicht-aufgaben-heading')).toHaveText('Aufgaben');
  // Weiterhin per Teilstring über "Aufgaben" auffindbar (issue #157).
  await expect(dueTaskItems(page)).toHaveCount(1);
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

test('die eingeklappte „ohne Datum"-Fläche auf /uebersicht misst höchstens 52px statt der vollen Kartenhöhe (issue #931 AK1)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Ohne Datum A' });
  await seedTask(page, { title: 'Ohne Datum B' });
  await seedTask(page, { title: 'Ohne Datum C' });

  const card = undatedCard(page);
  await expect(card).toHaveText('3 Aufgaben ohne Datum');
  const box = await card.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeLessThanOrEqual(52);
});

test('der Umschalter der „ohne Datum"-Fläche bleibt ein volles Tap-Target und spiegelt aria-expanded (issue #931 AK2)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Ohne Datum' });

  const card = undatedCard(page);
  const box = await card.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await expect(card).toHaveAttribute('aria-expanded', 'false');
  await card.click();
  await expect(card).toHaveAttribute('aria-expanded', 'true');
});

test('Antippen der „ohne Datum"-Fläche zeigt alle undatierten Zeilen, erneutes Antippen klappt sie wieder ein (issue #931 AK3)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Ohne Datum A' });
  await seedTask(page, { title: 'Ohne Datum B' });

  const card = undatedCard(page);
  await card.click();
  await expect(page.getByText('Ohne Datum A')).toBeVisible();
  await expect(page.getByText('Ohne Datum B')).toBeVisible();

  await card.click();
  await expect(card).toHaveAttribute('aria-expanded', 'false');
  const contentId = await card.getAttribute('aria-controls');
  await expect(page.locator(`[id="${contentId}"]`)).toBeHidden();
});

test('die „ohne Datum"-Fläche bleibt in Dark Mode mit reduzierter Bewegung bedienbar (issue #931 AK5)', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Ohne Datum A' });
  await seedTask(page, { title: 'Ohne Datum B' });

  const card = undatedCard(page);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('aria-expanded', 'false');
  await card.click();
  await expect(card).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Ohne Datum A')).toBeVisible();
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

    const content = aufgabenContent(page);
    await expect(page.getByText('Nichts fällig. Genieß den Tag.')).toBeVisible();
    const emptyBox = await content.boundingBox();
    if (!emptyBox) throw new Error('Der Aufgaben-Leerzustand muss sichtbar sein');

    const id = await seedTask(page, { title: 'Eine Aufgabe', dueAt: YESTERDAY_MORNING });
    await expect(dueTaskItems(page)).toHaveCount(1);
    const filledBox = await content.boundingBox();
    if (!filledBox) throw new Error('Die Aufgabenliste muss sichtbar sein');

    // The empty state reserves one group card's worth of box — its own padding, a
    // header line, one task row (issue #762, card since issue #866) — so a filled
    // "Woche" list is never just a bare row anymore, and its height barely grows.
    // Anything beyond that is the hole issue #228 fixed reopening — the numbers
    // travel in the message, so a red run says how far off it is.
    expect(
      Math.abs(emptyBox.height - filledBox.height),
      `leer ${emptyBox.height}px vs. mit Aufgabe ${filledBox.height}px bei ${width}px`,
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
    page.getByRole('heading', { name: 'Routinen', level: 1 }),
  ).toBeVisible();
});

test('die Aufgaben-Überschrift bleibt im DOM für Screenreader, ist aber visuell verborgen (issue #157 AC5, jetzt #972 AK3)', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  const aufgabenHeading = page.getByRole('heading', { name: 'Aufgaben', level: 2 });
  await expect(aufgabenHeading).toHaveCount(1);
  await expect(aufgabenHeading).toHaveClass(/visually-hidden/);

  // `toBeVisible()` reicht hier nicht: eine 1×1px-Box mit `clip-path` gilt für
  // Playwright als "sichtbar" (nicht leer, kein `visibility:hidden`) — die
  // eigentliche Prüfung ist die Bounding-Box-Größe (issue #972 AK3).
  const box = await aufgabenHeading.boundingBox();
  if (!box) throw new Error('Die verborgene Überschrift muss trotzdem einen Layout-Ort haben');
  expect(box.width, 'die Überschrift darf keine sichtbare Fläche einnehmen').toBeLessThanOrEqual(1);
  expect(box.height, 'die Überschrift darf keine sichtbare Fläche einnehmen').toBeLessThanOrEqual(1);
});

test('der sichtbare Text über der Aufgabenliste kommt aus dem Bucket-Kopf, nicht mehr aus der Modulüberschrift (issue #157 AC5, jetzt #972 AK3)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Heute fällig', dueAt: TODAY_EVENING });

  await expect(groupTitles(page).filter({ hasText: 'Heute' })).toBeVisible();
});

test('die Aufgabenliste trägt ihr eigenes aria-label „Aufgaben der nächsten 7 Tage" statt der Modulüberschrift (issue #157 AC6, jetzt #979 AK3)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Heute fällig', dueAt: TODAY_EVENING });

  // Vor #979 war die Liste per `aria-labelledby` an die (identische) Modul-
  // überschrift "Aufgaben" gebunden, um doppelte Ansage zu vermeiden. Die
  // Texte sind jetzt unterschiedlich ("Aufgaben" vs. "Aufgaben der nächsten
  // 7 Tage") — `aria-labelledby` würde den Zusatz "der nächsten 7 Tage"
  // stillschweigend verschlucken, die Liste trägt ihn deshalb selbst.
  const list = page.getByRole('list', { name: 'Aufgaben' });
  await expect(list).toBeVisible();
  await expect(list).toHaveAttribute('aria-label', 'Aufgaben der nächsten 7 Tage');
  expect(await list.getAttribute('aria-labelledby')).toBeNull();
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
  const aufgaben = aufgabenContent(page);
  const routinen = routinenHead(page);
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
    const aufgaben = aufgabenContent(page);
    const routinen = routinenHead(page);
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
  await expect(aufgabenContent(page)).toBeVisible();
  await expect(routinenHead(page)).toBeVisible();

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
/* issue #974 (T3 von #971): "Nächster Termin" im Blatt-Aufbau — die Uhrzeit  */
/* trägt die Zeile. Ersetzt den #559-Aufbau (Countdown oben, Zeitraum unten). */
/* -------------------------------------------------------------------------- */

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

/**
 * getComputedStyle can serialize a color-mix()/oklch()-sourced colour back in a
 * form a naive "rgb(r, g, b)" regex would misparse — a 1×1 canvas sidesteps
 * that (same technique as grundfarbe.spec.ts/kalender.spec.ts).
 */
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

test('AK1: die Startzeit trägt die Zeile groß in --font-display, Titel und eine gedämpfte Metazeile stehen daneben (issue #974)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  // NOW = 12:00 UTC = 14:00 Berlin (CEST). +40 Min -> 14:40 Berlin.
  await seedEvent(page, {
    title: 'Standup',
    allDay: false,
    startsAt: '2026-07-18T12:40:00.000Z',
    endsAt: '2026-07-18T13:10:00.000Z',
    startDate: null,
    endDate: null,
    category: 'arbeit',
  });

  const next = page.locator('.events-overview__next');
  const time = next.locator('.events-overview__next-time');
  const title = next.locator('.events-overview__next-title');
  await expect(time).toHaveText('14:40');
  await expect(title).toHaveText('Standup');

  const timeStyle = await time.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      fontSize: parseFloat(style.fontSize),
      fontVariant: style.fontVariantNumeric,
      fontFamily: style.fontFamily.toLowerCase(),
    };
  });
  expect(timeStyle.fontSize).toBeCloseTo(26, 0);
  expect(timeStyle.fontVariant).toBe('tabular-nums');
  expect(timeStyle.fontFamily).toMatch(/ui-rounded|nunito/);

  expect(await title.evaluate((el) => getComputedStyle(el).fontWeight)).toBe('600');

  // Titel + Metazeile stehen als eigener Block rechts neben der Uhrzeit, nicht
  // in eigenen vollbreiten Zeilen darüber/darunter.
  const [timeBox, bodyBox] = await Promise.all([
    time.boundingBox(),
    next.locator('.events-overview__next-body').boundingBox(),
  ]);
  expect(bodyBox!.x).toBeGreaterThan(timeBox!.x + timeBox!.width - 1);
});

test('AK2: die Metazeile zeigt Countdown und Kategorie in einer Zeile, der Zeitraum entfällt (issue #974)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedEvent(page, {
    title: 'Standup',
    allDay: false,
    startsAt: '2026-07-18T12:40:00.000Z',
    endsAt: '2026-07-18T13:10:00.000Z',
    startDate: null,
    endDate: null,
    category: 'arbeit',
  });

  const next = page.locator('.events-overview__next');
  await expect(next.locator('.events-overview__next-meta')).toHaveText('in 40 Min · Arbeit');
  // Zeitraum "12:40–13:10" UTC = "14:40–15:10" Berlin — die Endzeit steht nirgends mehr.
  await expect(next).not.toContainText('15:10');
});

test('AK2: ohne Kategorie zeigt die Metazeile nur den Countdown, ohne baumelndes Trennzeichen (issue #974)', async ({
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

  await expect(page.locator('.events-overview__next-meta')).toHaveText('in 40 Min');
});

test('AK3: die linke Kategorie-Kante entfällt, die Uhrzeit trägt jetzt die Kategoriefarbe (issue #974)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedEvent(page, {
    title: 'Standup',
    allDay: false,
    startsAt: '2026-07-18T12:40:00.000Z',
    endsAt: '2026-07-18T13:10:00.000Z',
    startDate: null,
    endDate: null,
    category: 'arbeit',
  });

  const next = page.locator('.events-overview__next');
  expect(await next.evaluate((el) => getComputedStyle(el).borderInlineStartWidth)).toBe('0px');

  const [timeColor, titleColor] = await Promise.all([
    next.locator('.events-overview__next-time').evaluate((el) => getComputedStyle(el).color),
    next.locator('.events-overview__next-title').evaluate((el) => getComputedStyle(el).color),
  ]);
  expect(timeColor).not.toBe(titleColor);
});

test('AK4: die Startzeit erreicht 4,5:1 gegen die Kartenfläche, mit Kategorie, hell und dunkel (issue #974)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedEvent(page, {
    title: 'Standup',
    allDay: false,
    startsAt: '2026-07-18T12:40:00.000Z',
    endsAt: '2026-07-18T13:10:00.000Z',
    startDate: null,
    endDate: null,
    // familie liegt mit 55%-Mix am nächsten an der 4,5:1-Schwelle (ADR-0028-
    // Nachmessung) — der strengste der fünf Vorgabefarben-Fälle.
    category: 'familie',
  });

  const time = page.locator('.events-overview__next-time');
  const card = page.locator('.events-overview__next');
  async function measure(): Promise<number> {
    const [timeColor, cardBg] = await Promise.all([
      time.evaluate((el) => getComputedStyle(el).color),
      card.evaluate((el) => getComputedStyle(el).backgroundColor),
    ]);
    return contrastRatio(await toRgb(page, timeColor), await toRgb(page, cardBg));
  }

  await expect(time).toBeVisible();
  expect(await measure(), 'hell').toBeGreaterThanOrEqual(4.5);

  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await measure(), 'dunkel').toBeGreaterThanOrEqual(4.5);
});

test('AK4: die Startzeit ohne Kategorie erreicht 4,5:1 gegen die Kartenfläche, hell und dunkel (issue #974)', async ({
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

  const time = page.locator('.events-overview__next-time');
  const card = page.locator('.events-overview__next');
  async function measure(): Promise<number> {
    const [timeColor, cardBg] = await Promise.all([
      time.evaluate((el) => getComputedStyle(el).color),
      card.evaluate((el) => getComputedStyle(el).backgroundColor),
    ]);
    return contrastRatio(await toRgb(page, timeColor), await toRgb(page, cardBg));
  }

  await expect(time).toBeVisible();
  expect(await measure(), 'hell').toBeGreaterThanOrEqual(4.5);

  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await measure(), 'dunkel').toBeGreaterThanOrEqual(4.5);
});

test('AK5: weitere Termine am selben Tag stehen darunter als dünne Zeilen, deutlich kleiner als die große Startzeit (issue #974, vormals #559 AC2)', async ({
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

  // Deutlich kleinere Schrift als die große Startzeit des nächsten Termins.
  const [nextFontSize, restFontSize] = await Promise.all([
    next.locator('.events-overview__next-time').evaluate((el) => getComputedStyle(el).fontSize),
    restItems.first().evaluate((el) => getComputedStyle(el).fontSize),
  ]);
  expect(parseFloat(nextFontSize)).toBeGreaterThan(parseFloat(restFontSize));
});

test('AK6: ohne weitere Termine heute zeigt die Sektion einen erkennbaren Leerzustand (issue #974, vormals #559 AC3)', async ({
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

test('AK6: der Countdown in der Metazeile aktualisiert sich mit der Zeit, ohne dass die Seite neu lädt (issue #974, vormals #559 AC4)', async ({
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

  const meta = page.locator('.events-overview__next-meta');
  await expect(meta).toHaveText('in 40 Min');

  await freezeClock(page);
  await page.clock.fastForward(10 * 60 * 1000);

  await expect(meta).toHaveText('in 30 Min');
});

test('die Übersicht-Sektion "Nächster Termin" funktioniert auf Mobile (375px) und Desktop (1280px), Dark Mode (issue #974, vormals #559 AC5)', async ({
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

    const heading = page.getByRole('heading', { name: 'Nächster Termin', level: 2 });
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

test('AK8: bei 375×812 kürzt ein langer Termintitel einzeilig, die Uhrzeit bleibt vollständig — Dark Mode, reduzierte Bewegung, kein waagerechter Überlauf (issue #974)', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/uebersicht');
  await seedEvent(page, {
    title: 'Ein sehr langer Terminname, der eigentlich nicht mehr in eine einzige Zeile passt',
    allDay: false,
    startsAt: '2026-07-18T12:40:00.000Z',
    endsAt: '2026-07-18T13:10:00.000Z',
    startDate: null,
    endDate: null,
    category: 'arbeit',
  });

  const next = page.locator('.events-overview__next');
  const time = next.locator('.events-overview__next-time');
  const title = next.locator('.events-overview__next-title');
  await expect(time).toHaveText('14:40');

  const [titleTruncates, timeFits] = await Promise.all([
    title.evaluate((el) => el.scrollWidth > el.clientWidth),
    time.evaluate((el) => el.scrollWidth <= el.clientWidth),
  ]);
  expect(titleTruncates, 'Titel kürzt einzeilig statt zu umbrechen').toBe(true);
  expect(timeFits, 'Uhrzeit bleibt vollständig, ohne zu kürzen').toBe(true);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'kein waagerechter Überlauf').toBe(0);
});

test('AK9: ein offline angelegter Termin erscheint sofort in der Karte und erreicht nach dem Onlinegehen die echte Datenbank (issue #974)', async ({
  page,
  context,
}) => {
  await page.goto('/uebersicht');
  await context.setOffline(true);
  await seedEvent(page, {
    title: 'Im Zug erfasst',
    allDay: false,
    startsAt: '2026-07-18T12:40:00.000Z',
    endsAt: '2026-07-18T13:10:00.000Z',
    startDate: null,
    endDate: null,
    category: 'arbeit',
  });

  const next = page.locator('.events-overview__next');
  await expect(next).toContainText('Im Zug erfasst');
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  // beforeEach blockt /api/sync/** (route.abort) — hier aufheben, damit die
  // gequeuete Mutation den echten Server erreichen kann.
  await page.unroute('**/api/sync/**');
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  // Weiterhin sichtbar, ohne Reload (die Karte kommt aus derselben Live-Query).
  await expect(next).toContainText('Im Zug erfasst');

  const row = await withDb((client) =>
    client.query('SELECT title FROM events WHERE title = $1', ['Im Zug erfasst']),
  );
  expect(row.rowCount).toBe(1);
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
