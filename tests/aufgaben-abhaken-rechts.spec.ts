import { expect, test, type Locator, type Page } from '@playwright/test';
import { installClockAt, registerPasskey, resetAppData, selectView } from './helpers';

/** /uebersicht fires a forecast fetch on load (weather.spec.ts's own pattern) —
 *  aborted here so the /uebersicht-visiting tests below don't hit the network. */
const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';

/** Same day as `installClockAt`'s default (FIXED_NOW) — one calendar day earlier,
 *  so a task due here always lands in the "Überfällig" bucket. */
const YESTERDAY = '2026-07-17T09:00:00.000Z';
/** Later on the frozen "today" — due, but not yet overdue (issue #705 AK7's
 *  "heute erledigt bleibt" case for AK8 below). */
const LATER_TODAY = '2026-07-18T18:00:00.000Z';

function taskItems(page: Page) {
  return page.getByRole('list', { name: 'Aufgaben' }).getByRole('listitem');
}

function taskRowFor(page: Page, title: string) {
  return taskItems(page).filter({ hasText: title });
}

function checkboxFor(page: Page, title: string) {
  return page.getByRole('checkbox', { name: `${title} als erledigt markieren` });
}

async function seedTask(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: p }),
    payload,
  );
}

function disclosureFor(page: Page, title: string) {
  return taskRowFor(page, title).getByRole('button', { name: /Unteraufgaben/ });
}

async function expandParent(page: Page, title: string) {
  const disclosure = disclosureFor(page, title);
  await disclosure.click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
}

/** The row's own content box, inside its `padding-inline` — what AK1/AK2/AK3/AK4
 *  actually measure against, not the row's outer (padding-including) edges. */
async function contentEdges(row: Locator): Promise<{ left: number; right: number }> {
  const box = await row.boundingBox();
  if (!box) throw new Error('row has no bounding box');
  const padding = await row.evaluate((el) => {
    const style = getComputedStyle(el);
    return { left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight) };
  });
  return { left: box.x + padding.left, right: box.x + box.width - padding.right };
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // Before the first navigation (installClockAt's own contract) — every test in
  // this file needs a stable "today" for its bucket/overdue assertions.
  await installClockAt(page);
  // The list must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await page.route(OPEN_METEO_PATTERN, (route) => route.abort('failed'));
  // No target: some tests land on /aufgaben, others on /uebersicht.
  await registerPasskey(page, null);
});

test('AK1: /aufgaben — der Abhak-Button ist das letzte Element der Zeile, bündig mit der rechten Inhaltskante', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, {
    title: 'Eltern mit Fortschritt und Fälligkeit',
    dueAt: '2026-08-01T09:00:00.000Z',
  });
  await seedTask(page, { title: 'Kind', parentId });

  const row = taskRowFor(page, 'Eltern mit Fortschritt und Fälligkeit');
  const { right } = await contentEdges(row);
  const checkboxBox = await row.locator('.task-list__checkbox-wrap').boundingBox();
  if (!checkboxBox) throw new Error('checkbox-wrap has no bounding box');
  expect(Math.abs(right - (checkboxBox.x + checkboxBox.width))).toBeLessThanOrEqual(1);

  const titleBox = await row.locator('.task-list__title').boundingBox();
  const progressBox = await row.locator('.task-list__progress').boundingBox();
  const dueBox = await row.locator('.task-list__due').boundingBox();
  for (const box of [titleBox, progressBox, dueBox]) {
    if (!box) throw new Error('expected element has no bounding box');
    expect(box.x + box.width).toBeLessThanOrEqual(checkboxBox.x + 1);
  }
});

test('AK2: /uebersicht — dieselbe Anordnung bei einer überfälligen Aufgabe in der Karte „Überfällig"', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedTask(page, { title: 'Überfällige Randprobe', dueAt: YESTERDAY });

  await expect(page.getByText('Überfällig')).toBeVisible();
  const row = taskRowFor(page, 'Überfällige Randprobe');
  const { right } = await contentEdges(row);
  const checkboxBox = await row.locator('.task-list__checkbox-wrap').boundingBox();
  if (!checkboxBox) throw new Error('checkbox-wrap has no bounding box');
  expect(Math.abs(right - (checkboxBox.x + checkboxBox.width))).toBeLessThanOrEqual(1);

  const titleBox = await row.locator('.task-list__title').boundingBox();
  const dueBox = await row.locator('.task-list__due').boundingBox();
  if (!titleBox || !dueBox) throw new Error('expected element has no bounding box');
  expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(checkboxBox.x + 1);
  expect(dueBox.x + dueBox.width).toBeLessThanOrEqual(checkboxBox.x + 1);
});

test('AK3: Reihenfolge links nach rechts — Aufklapp-Pfeil, Titel, Fortschritt, Fälligkeit, Abhak-Button; der Pfeil bleibt am linken Rand', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, {
    title: 'Reihenfolge-Eltern',
    dueAt: '2026-08-01T09:00:00.000Z',
  });
  await seedTask(page, { title: 'Reihenfolge-Kind', parentId });

  const row = taskRowFor(page, 'Reihenfolge-Eltern');
  const disclosureBox = await disclosureFor(page, 'Reihenfolge-Eltern').boundingBox();
  const titleBox = await row.locator('.task-list__title').boundingBox();
  const progressBox = await row.locator('.task-list__progress').boundingBox();
  const dueBox = await row.locator('.task-list__due').boundingBox();
  const checkboxBox = await row.locator('.task-list__checkbox-wrap').boundingBox();
  if (!disclosureBox || !titleBox || !progressBox || !dueBox || !checkboxBox) {
    throw new Error('expected element has no bounding box');
  }

  expect(disclosureBox.x).toBeLessThan(titleBox.x);
  expect(titleBox.x).toBeLessThan(progressBox.x);
  expect(progressBox.x).toBeLessThan(dueBox.x);
  expect(dueBox.x).toBeLessThan(checkboxBox.x);

  const { left } = await contentEdges(row);
  expect(Math.abs(disclosureBox.x - left)).toBeLessThanOrEqual(1);
});

test('AK4: eine Aufgabe ohne Aufklapp-Pfeil beginnt mit dem Titel an der linken Inhaltskante — keine Lücke mehr', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Ohne Kinder' });

  const row = taskRowFor(page, 'Ohne Kinder');
  await expect(disclosureFor(page, 'Ohne Kinder')).toHaveCount(0);
  const { left } = await contentEdges(row);
  const titleBox = await row.locator('.task-list__title').boundingBox();
  if (!titleBox) throw new Error('title has no bounding box');
  expect(Math.abs(titleBox.x - left)).toBeLessThanOrEqual(1);
});

test('AK5: der Abhak-Button bleibt vertikal zentriert, auch wenn der Titel zweizeilig umbricht', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Kurz' });
  const longTitle =
    'Ein sehr langer Aufgabentitel der garantiert an dieser schmalen Spalte über eine einzige Zeile hinaus in die zweite Zeile umbricht und damit die Zeilenhöhe erkennbar vergrößert';
  await seedTask(page, { title: longTitle });

  const shortRow = taskRowFor(page, 'Kurz');
  const longRow = taskRowFor(page, longTitle);
  const shortBox = await shortRow.boundingBox();
  const longBox = await longRow.boundingBox();
  if (!shortBox || !longBox) throw new Error('row has no bounding box');
  // Proves the title actually wrapped — a still-single-line row would match the
  // short row's height, pinned by `--task-card-height` (task-list.css).
  expect(longBox.height).toBeGreaterThan(shortBox.height + 10);

  const checkboxBox = await longRow.locator('.task-list__checkbox-wrap').boundingBox();
  if (!checkboxBox) throw new Error('checkbox-wrap has no bounding box');
  const rowCenter = longBox.y + longBox.height / 2;
  const checkboxCenter = checkboxBox.y + checkboxBox.height / 2;
  expect(Math.abs(rowCenter - checkboxCenter)).toBeLessThanOrEqual(2);
});

test('AK6: die Zustands-Lasche (Priorität/Überfällig) bleibt am linken Rand der Zeile', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Dringende Randprobe', priority: 2 });

  const row = taskRowFor(page, 'Dringende Randprobe');
  await expect(row).toHaveAttribute('data-edge', 'priority');
  const insetStart = await row.evaluate((el) => getComputedStyle(el, '::before').insetInlineStart);
  expect(insetStart).toBe('0px');
});

test('AK7: bei ausgeklappten Unteraufgaben fluchtet der Abhak-Button der Unteraufgabe mit dem der Elternaufgabe, der Einzug bleibt', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  const parentId = await seedTask(page, { title: 'Eltern mit Kindern' });
  await seedTask(page, { title: 'Kind eins', parentId });
  await expandParent(page, 'Eltern mit Kindern');

  const parentRow = taskRowFor(page, 'Eltern mit Kindern');
  const childRow = taskRowFor(page, 'Kind eins');
  const parentCheckboxBox = await parentRow.locator('.task-list__checkbox-wrap').boundingBox();
  const childCheckboxBox = await childRow.locator('.task-list__checkbox-wrap').boundingBox();
  if (!parentCheckboxBox || !childCheckboxBox) throw new Error('checkbox-wrap has no bounding box');
  expect(
    Math.abs(
      parentCheckboxBox.x + parentCheckboxBox.width - (childCheckboxBox.x + childCheckboxBox.width),
    ),
  ).toBeLessThanOrEqual(1);

  const parentRowBox = await parentRow.boundingBox();
  const childRowBox = await childRow.boundingBox();
  if (!parentRowBox || !childRowBox) throw new Error('row has no bounding box');
  expect(childRowBox.x).toBeGreaterThan(parentRowBox.x);
});

test('AK8: der Abhak-Button springt beim Abhaken nicht seitlich — „Woche" behält eine heute erledigte Aufgabe, „Alle" blendet sie aus', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  // "7 Tage" (internally "woche") is the default view on a fresh navigation.
  const title = 'Heute fällig';
  await seedTask(page, { title, dueAt: LATER_TODAY });

  const row = taskRowFor(page, title);
  const checkboxBoxBefore = await row.locator('.task-list__checkbox-wrap').boundingBox();
  if (!checkboxBoxBefore) throw new Error('checkbox-wrap has no bounding box');

  await checkboxFor(page, title).click();
  await expect(checkboxFor(page, title)).toBeChecked();

  // Stays in "Woche" (issue #705 AK7: done-today survives the window filter).
  await expect(row).toBeVisible();
  const checkboxBoxAfter = await row.locator('.task-list__checkbox-wrap').boundingBox();
  if (!checkboxBoxAfter) throw new Error('checkbox-wrap has no bounding box');
  expect(Math.abs(checkboxBoxAfter.x - checkboxBoxBefore.x)).toBeLessThanOrEqual(1);

  await selectView(page, 'Alle');
  await expect(taskItems(page).filter({ hasText: title })).toHaveCount(0);
});

test('AK10: die Checkbox steht im DOM hinter Titel und Fälligkeit — keine Umsortierung per CSS-order', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'DOM-Reihenfolge', dueAt: '2026-08-01T09:00:00.000Z' });

  const row = taskRowFor(page, 'DOM-Reihenfolge');
  const { classNames, orders } = await row.evaluate((el) => ({
    classNames: Array.from(el.children).map((child) => child.className),
    orders: Array.from(el.children).map((child) => getComputedStyle(child).order),
  }));

  const titleIndex = classNames.findIndex((c) => c.includes('task-list__title'));
  const dueIndex = classNames.findIndex((c) => c.includes('task-list__due'));
  const checkboxIndex = classNames.findIndex((c) => c.includes('task-list__checkbox-wrap'));
  expect(titleIndex).toBeGreaterThanOrEqual(0);
  expect(dueIndex).toBeGreaterThan(titleIndex);
  expect(checkboxIndex).toBe(classNames.length - 1);
  expect(checkboxIndex).toBeGreaterThan(dueIndex);
  // The initial value of `order` is `0` on every child — no reordering trick.
  expect(orders.every((order) => order === '0')).toBe(true);
});
