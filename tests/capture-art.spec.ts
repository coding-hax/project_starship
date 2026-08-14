import { expect, test, type Page } from '@playwright/test';
import { installClockAt, registerPasskey, resetAppData } from './helpers';

const CAPTURE_LABEL = 'Aufgabe erfassen';

function captureButton(page: Page) {
  return page.getByRole('button', { name: CAPTURE_LABEL });
}

function captureTitleField(page: Page) {
  return page.getByRole('textbox', { name: 'Titel der Aufgabe' });
}

function artChip(page: Page, label: string) {
  return page.getByRole('button', { name: `Art, ${label}` });
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
