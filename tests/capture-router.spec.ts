import { expect, test, type Page } from '@playwright/test';
import {
  installClockAt,
  registerPasskey,
  resetAppData,
  withDb,
} from './helpers';

const CAPTURE_LABEL = 'Aufgabe erfassen';

function captureButton(page: Page) {
  return page.getByRole('button', { name: CAPTURE_LABEL });
}

function captureTitleField(page: Page) {
  return page.getByRole('textbox', { name: 'Titel der Aufgabe' });
}

async function submitUebersichtCapture(page: Page, text: string) {
  await captureButton(page).click();
  await captureTitleField(page).fill(text);
  await page.getByRole('button', { name: 'Anlegen' }).click();
}

async function seedHabit(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'habits', op: 'upsert', payload: p }),
    payload,
  );
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // Neither the task- nor the event-side of the router may ever fetch directly
  // (CLAUDE.md rule 8) — everything below must survive with sync cut off.
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await installClockAt(page);
  // No target: every test in this file opens with its own goto, so loading
  // /uebersicht here would only be thrown away (issue #1075).
  await registerPasskey(page, null);
});

test('AC3: "hake Sport ab" hakt die Gewohnheit für heute direkt ab, ohne Rückgängig-Popup — der Server landet abgehakt', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedHabit(page, { name: 'Sport', schedule: 'daily', color: null, archivedAt: null });

  await submitUebersichtCapture(page, 'hake Sport ab');

  // Kein Editor, keine Navigation — das Abhaken ist trivial (issue #619).
  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(page.getByRole('dialog', { name: CAPTURE_LABEL })).toBeHidden();

  const checkbox = page.getByRole('checkbox', { name: 'Sport für heute abhaken' });
  await expect(checkbox).toBeChecked();
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeHidden();

  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query(
      'SELECT l.done FROM habit_logs l JOIN habits h ON h.id = l.habit_id WHERE h.name = $1',
      ['Sport'],
    ),
  );
  expect(row.rowCount).toBe(1);
  expect(row.rows[0].done).toBe(true);
});
