import { expect, test, type Page } from '@playwright/test';
import { FIXED_NOW, installClockAt, registerPasskey, resetAppData } from './helpers';

const CAPTURE_LABEL = 'Aufgabe erfassen';

function captureButton(page: Page) {
  return page.getByRole('button', { name: CAPTURE_LABEL });
}

function captureDialog(page: Page) {
  return page.getByRole('dialog', { name: CAPTURE_LABEL });
}

function captureTitleField(page: Page) {
  return page.getByRole('textbox', { name: 'Titel der Aufgabe' });
}

function artChip(page: Page, label: string) {
  return page.getByRole('button', { name: `Art, ${label}` });
}

async function submitCapture(page: Page, text: string) {
  await captureButton(page).click();
  await captureTitleField(page).fill(text);
  await page.getByRole('button', { name: 'Anlegen' }).click();
}

/** Mirrors parse-task-input.ts's own default time (09:00), computed at run time —
 * never hard-coded (helpers.ts pattern used elsewhere). */
function expectedDueAt(daysFromNow: number, hours: number, minutes: number): Date {
  const date = new Date(FIXED_NOW);
  date.setDate(date.getDate() + daysFromNow);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

/** Renders `var(--area-*)` on a throwaway element to read its resolved color —
 * the same value the sheet's accent-driven surfaces (action button, chips)
 * resolve to once `--accent` points at that area token (issue #715 AK2). */
async function resolvedAreaColor(
  page: Page,
  areaVar: '--area-tasks' | '--area-events' | '--area-habits',
): Promise<string> {
  return page.evaluate((varName) => {
    const probe = document.createElement('div');
    probe.style.color = `var(${varName})`;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, areaVar);
}

function sheetActionButton(page: Page) {
  return page.locator('.sheet__action');
}

async function actionButtonBackground(page: Page): Promise<string> {
  return sheetActionButton(page).evaluate((el) => getComputedStyle(el).backgroundColor);
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // Kein Absenden in dieser Suite — trotzdem abgesperrt, damit ein versehentlicher
  // Fetch (CLAUDE.md Regel 8) sofort auffiele statt still durchzulaufen.
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await installClockAt(page);
  await registerPasskey(page);
});

test('AK1: der Art-Chip zeigt die erkannte Art, bevor angelegt wird', async ({ page }) => {
  await page.goto('/uebersicht');
  await captureButton(page).click();

  // Leeres Feld: der sichere Rückfall des Erkenners ist „Aufgabe" (local-recognizer.ts).
  await expect(artChip(page, 'Aufgabe')).toBeVisible();

  await captureTitleField(page).fill('morgen 12 Uhr Zahnarzt');
  await expect(artChip(page, 'Termin')).toBeVisible();
});

test('AK1: Antippen des Art-Chips wechselt die Art von Hand', async ({ page }) => {
  await page.goto('/uebersicht');
  await captureButton(page).click();
  await captureTitleField(page).fill('morgen 12 Uhr Zahnarzt');
  await expect(artChip(page, 'Termin')).toBeVisible();

  await artChip(page, 'Termin').click();
  await page.getByRole('radio', { name: 'Aufgabe' }).click();

  await expect(artChip(page, 'Aufgabe')).toBeVisible();
});

test('AK2: der Akzent des Sheets folgt der erkannten Art', async ({ page }) => {
  await page.goto('/uebersicht');
  const taskColor = await resolvedAreaColor(page, '--area-tasks');
  const eventColor = await resolvedAreaColor(page, '--area-events');
  expect(taskColor).not.toBe(eventColor);

  await captureButton(page).click();
  await expect(sheetActionButton(page)).toBeVisible();
  await expect.poll(() => actionButtonBackground(page)).toBe(taskColor);

  await captureTitleField(page).fill('morgen 12 Uhr Zahnarzt');
  await expect.poll(() => actionButtonBackground(page)).toBe(eventColor);

  await artChip(page, 'Termin').click();
  await page.getByRole('radio', { name: 'Aufgabe' }).click();
  await expect.poll(() => actionButtonBackground(page)).toBe(taskColor);
});

test('AK1: die Routine "hake Sport ab" zeigt den Art-Chip "Routine"', async ({ page }) => {
  await page.goto('/uebersicht');
  await page.evaluate(() =>
    window.__starship.mutate({
      table: 'habits',
      op: 'upsert',
      payload: { name: 'Sport', schedule: 'daily', color: null, archivedAt: null },
    }),
  );
  await page.goto('/uebersicht');
  await captureButton(page).click();

  await captureTitleField(page).fill('hake Sport ab');

  await expect(artChip(page, 'Routine')).toBeVisible();
});

test('AK3: "Wäsche waschen" legt die Aufgabe in-place an, kein Navigieren', async ({ page }) => {
  await page.goto('/uebersicht');

  await submitCapture(page, 'Wäsche waschen');

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(captureDialog(page)).toBeHidden();
  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.find((entry) => entry.table === 'tasks');
  expect(created?.payload).toMatchObject({ title: 'Wäsche waschen' });
});

test('AK3: "morgen 12 Uhr Zahnarzt" legt den Termin in-place an, kein Navigieren', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const due = expectedDueAt(1, 12, 0);

  await submitCapture(page, 'morgen 12 Uhr Zahnarzt');

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(captureDialog(page)).toBeHidden();
  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.filter((entry) => entry.table === 'events');
  expect(created).toHaveLength(1);
  expect(created[0].payload).toMatchObject({
    title: 'Zahnarzt',
    allDay: false,
    startsAt: due.toISOString(),
  });
  expect(new Date(created[0].payload.endsAt as string).getTime() - due.getTime()).toBe(
    60 * 60 * 1000,
  );
});

test('AK4-Kernfeld: ohne erkannte Uhrzeit bekommt der Termin 09:00 des heutigen Tages als Von', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  await submitCapture(page, 'Meeting mit Chef');

  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.find((entry) => entry.table === 'events');
  expect(created?.payload).toMatchObject({ title: 'Meeting mit Chef', allDay: false });
  const startsAt = new Date(created?.payload.startsAt as string);
  expect(startsAt.getHours()).toBe(9);
  expect(startsAt.getMinutes()).toBe(0);
});

test('AK4-Kernfeld: die Priorität-Chip-Auswahl übernimmt in die angelegte Aufgabe', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await captureButton(page).click();
  await captureTitleField(page).fill('Müll rausbringen');

  await page.getByRole('button', { name: 'Priorität' }).click();
  await page.getByRole('radio', { name: 'Hoch' }).click();
  await page.getByRole('button', { name: 'Anlegen' }).click();

  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.find((entry) => entry.table === 'tasks');
  expect(created?.payload).toMatchObject({ title: 'Müll rausbringen', priority: 1 });
});
