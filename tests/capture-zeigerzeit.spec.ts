import { expect, test, type Page } from '@playwright/test';
import { installClockAt, registerPasskey, resetAppData } from './helpers';

/**
 * Deutsche Zeigerzeit — "halb", "viertel vor/nach", zusammengesetzte Minutenangaben,
 * Tageshälften (issue #688, Teil 2 von 3 des Parser-Umbaus, Epic #617). Alle Tests dieses
 * Tickets in einer Datei (45-Minuten-Fenster, siehe CLAUDE.md).
 *
 * Eigener, fester Bezugspunkt statt `FIXED_NOW` aus helpers.ts (14:00 Berlin, immer
 * Nachmittagslesart): Montag 10:00 Berlin, wie der Bezugspunkt des Tickets selbst
 * (Vormittagslesart) — sonst ließe sich die Vormittags/Nachmittags-Heuristik (R2) hier
 * gar nicht zeigen. Juli, weit weg von Mitternacht/DST, wie FIXED_NOW selbst begründet.
 */
const ZEIGERZEIT_NOW = '2026-07-20T08:00:00.000Z'; // Montag, 10:00 Berlin (CEST)

const CAPTURE_LABEL = 'Aufgabe erfassen';
const CONFIRM_LABEL = 'Aufgabe bestätigen';

function captureTitleField(page: Page) {
  return page.getByRole('textbox', { name: 'Titel der Aufgabe' });
}

function confirmDialog(page: Page) {
  return page.getByRole('dialog', { name: CONFIRM_LABEL });
}

function taskItems(page: Page) {
  return page.getByRole('list', { name: 'Aufgaben' }).getByRole('listitem');
}

async function submitQuickAdd(page: Page, text: string) {
  await page.getByRole('button', { name: CAPTURE_LABEL }).click();
  await captureTitleField(page).fill(text);
  await page.getByRole('button', { name: 'Anlegen' }).click();
}

async function enableDirectCapture(page: Page) {
  await page.goto('/einstellungen');
  await page.getByRole('switch', { name: 'Ohne Bestätigung direkt anlegen' }).click();
}

/** Tag relativ zum jeweiligen Bezugspunkt dieser Datei — nie hart codiert. */
function expectedDueAt(now: string, daysFromNow: number, hours: number, minutes: number): Date {
  const date = new Date(now);
  date.setDate(date.getDate() + daysFromNow);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

/** `datetime-local` arbeitet in der lokalen Zeit des Browsers, ohne Zeitzonen-Suffix. */
function isoToLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatSummary(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}. ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // Weder Aufgaben- noch Termin-Pfad dürfen je direkt fetchen (CLAUDE.md Regel 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await installClockAt(page, ZEIGERZEIT_NOW);
  // No target: every test in this file opens with its own goto, so loading
  // /uebersicht here would only be thrown away (issue #1075).
  await registerPasskey(page, null);
});

test('AK3+AK4: eine geratene Nachtzeit oder eine regionale Kurzform erzwingt das Bestätigungs-Sheet auf dem Aufgaben-Pfad, auch bei eingeschalteter Direkt-Erfassung', async ({
  page,
}) => {
  await enableDirectCapture(page);
  await page.goto('/aufgaben');

  const halbEins = expectedDueAt(ZEIGERZEIT_NOW, 1, 0, 30);
  // Kein Mahlzeitwort: „Mittagessen" nennt seit dem 03.09.26 die Tageshälfte und macht
  // aus „halb eins" 12:30 — dann liegt die Zeit nicht mehr im Nachtfenster, das dieser
  // Test prüft. „Bericht" trägt keine Tageshälfte.
  await submitQuickAdd(page, 'morgen halb eins Bericht');

  let dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Titel der Aufgabe' })).toHaveValue('Bericht');
  await expect(dialog.getByLabel('Fälligkeit')).toHaveValue(isoToLocalInput(halbEins));
  await expect(dialog.locator('.capture-confirm__summary')).toHaveText(formatSummary(halbEins));
  await dialog.getByRole('button', { name: 'Anlegen' }).click();
  await expect(dialog).toBeHidden();
  await expect(taskItems(page).filter({ hasText: 'Bericht' })).toBeVisible();

  // Regionale Kurzform ("dreiviertel H" ohne vor/nach) — nicht im Nachtfenster, aber
  // wegen der Verwechslungsgefahr mit "viertel nach H" trotzdem bestätigungspflichtig.
  const dreiviertelZwoelf = expectedDueAt(ZEIGERZEIT_NOW, 1, 11, 45);
  await submitQuickAdd(page, 'morgen dreiviertel zwölf Abgabe');

  dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Fälligkeit')).toHaveValue(isoToLocalInput(dreiviertelZwoelf));
  await dialog.getByRole('button', { name: 'Anlegen' }).click();
  await expect(dialog).toBeHidden();
  await expect(taskItems(page).filter({ hasText: 'Abgabe' })).toBeVisible();
});
