import { expect, test, type Page } from '@playwright/test';
import { installClockAt, registerPasskey, resetAppData } from './helpers';

const CAPTURE_LABEL = 'Aufgabe erfassen';

/** issue #1089: der FAB heißt immer `CAPTURE_LABEL` (#1083 AK-Kommentar in
 * uebersicht-capture.tsx), der Sheet-Kopf selbst folgt seit #1083 der erkannten
 * Art — "Erfassen" (provisorisch, großes E) oder "Aufgabe erfassen"/"Termin
 * erfassen"/"Routine erfassen" (klein, zusammengesetztes Wort — SHEET_LABEL in
 * uebersicht-capture.tsx). `captureDialog` muss alle vier treffen, sonst laufen
 * Locator-Scopes wie `dueChip`/`zeitChip` bei jedem Termin oder vor dem ersten
 * Signal ins Leere. */
const SHEET_LABEL_PATTERN = /^(Aufgabe |Termin |Routine )?[Ee]rfassen$/;

function captureButton(page: Page) {
  return page.getByRole('button', { name: CAPTURE_LABEL });
}

function captureDialog(page: Page) {
  return page.getByRole('dialog', { name: SHEET_LABEL_PATTERN });
}

function captureTitleField(page: Page) {
  return page.getByRole('textbox', { name: 'Titel der Aufgabe' });
}

/** Scoped to the full list on `/aufgaben` — the undo toast's own message
 * embeds the title too, and `/uebersicht`'s own Aufgaben-Sektion carries a
 * differently worded `aria-label` ("Aufgaben der nächsten 7 Tage", issue
 * #979 AK3), still matched by the "Aufgaben" substring. */
function taskItems(page: Page) {
  return page.getByRole('list', { name: 'Aufgaben' }).getByRole('listitem');
}

async function submitUebersichtCapture(page: Page, text: string) {
  await captureButton(page).click();
  await captureTitleField(page).fill(text);
  await page.getByRole('button', { name: 'Anlegen' }).click();
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // The list must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await installClockAt(page);
  // No target: every test in this file opens with its own goto, so loading
  // /uebersicht here would only be thrown away (issue #1075).
  await registerPasskey(page, null);
});

test('AC3: "Anlegen" legt die Aufgabe direkt an, sie erscheint in der Liste', async ({ page }) => {
  await page.goto('/uebersicht');

  await submitUebersichtCapture(page, 'Arzt anrufen morgen');

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(captureDialog(page)).toBeHidden();
  await page.goto('/aufgaben');
  await expect(taskItems(page).filter({ hasText: 'Arzt anrufen' })).toBeVisible();
});

