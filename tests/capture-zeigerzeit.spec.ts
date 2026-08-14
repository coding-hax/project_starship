import { expect, test, type Locator, type Page } from '@playwright/test';
import { installClockAt, registerPasskey, resetAppData, withDb } from './helpers';

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
const ZEIGERZEIT_NOW_AFTERNOON = '2026-07-20T13:00:00.000Z'; // derselbe Montag, 15:00 Berlin

const CAPTURE_LABEL = 'Aufgabe erfassen';
const CONFIRM_LABEL = 'Aufgabe bestätigen';
const EVENT_LABEL = 'Termin erfassen';

function captureButton(page: Page) {
  return page.getByRole('button', { name: CAPTURE_LABEL });
}

function captureTitleField(page: Page) {
  return page.getByRole('textbox', { name: 'Titel der Aufgabe' });
}

function confirmDialog(page: Page) {
  return page.getByRole('dialog', { name: CONFIRM_LABEL });
}

function eventDialog(page: Page) {
  return page.getByRole('dialog', { name: EVENT_LABEL });
}

/** Von/Bis sitzen seit #712 hinter dem Wann-Chip — vor jedem Zugriff öffnen. */
function wannChip(scope: Page | Locator) {
  return scope.getByRole('button', { name: /^Wann/ });
}

function taskItems(page: Page) {
  return page.getByRole('list', { name: 'Aufgaben' }).getByRole('listitem');
}

async function submitUebersichtCapture(page: Page, text: string) {
  await captureButton(page).click();
  await captureTitleField(page).fill(text);
  await page.getByRole('button', { name: 'Anlegen' }).click();
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
  await registerPasskey(page);
});

test('AK1: Zeigerzeit-Grundformen ("halb H", "viertel nach/vor H") landen korrekt vorbefüllt im Termin-Editor', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const halbZwoelf = expectedDueAt(ZEIGERZEIT_NOW, 1, 11, 30);

  await submitUebersichtCapture(page, 'morgen halb zwölf Zahnarzt');

  await page.waitForURL('**/kalender');
  let dialog = eventDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Titel')).toHaveValue('Zahnarzt');
  await wannChip(dialog).click();
  await expect(dialog.getByLabel('Von')).toHaveValue(isoToLocalInput(halbZwoelf));
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // "um halb 12" (Ziffer statt Wort) ergibt dasselbe — "um" fällt als Bindewort.
  await page.goto('/uebersicht');
  await submitUebersichtCapture(page, 'morgen um halb 12 Zahnarzt');
  await page.waitForURL('**/kalender');
  dialog = eventDialog(page);
  await wannChip(dialog).click();
  await expect(dialog.getByLabel('Von')).toHaveValue(isoToLocalInput(halbZwoelf));
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // "viertel vor neun": die genannte Stunde (neun) entscheidet die Tageshälfte, nicht
  // die aufgelöste (acht) — R2 Regel 4.
  await page.goto('/uebersicht');
  const viertelVorNeun = expectedDueAt(ZEIGERZEIT_NOW, 1, 8, 45);
  await submitUebersichtCapture(page, 'morgen viertel vor neun Zahnarzt');
  await page.waitForURL('**/kalender');
  dialog = eventDialog(page);
  await expect(dialog.getByLabel('Titel')).toHaveValue('Zahnarzt');
  await wannChip(dialog).click();
  await expect(dialog.getByLabel('Von')).toHaveValue(isoToLocalInput(viertelVorNeun));
});

test('AK2: zusammengesetzte Minutenangabe ("M vor/nach halb H") korrekt vorbefüllt, auch im Nachtfenster', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const due = expectedDueAt(ZEIGERZEIT_NOW, 1, 2, 25);

  await submitUebersichtCapture(page, 'morgen fünf vor halb drei Call');

  // Der Termin-Pfad öffnet ohnehin immer den vorbefüllten Editor — "nicht direkt
  // anlegen" ist hier trivial erfüllt (siehe Ticket); prüfbar ist der korrekt
  // aufgelöste, vorbefüllte Zeitpunkt.
  await page.waitForURL('**/kalender');
  const dialog = eventDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Titel')).toHaveValue('Call');
  await wannChip(dialog).click();
  await expect(dialog.getByLabel('Von')).toHaveValue(isoToLocalInput(due));
});

test('AK3+AK4: eine geratene Nachtzeit oder eine regionale Kurzform erzwingt das Bestätigungs-Sheet auf dem Aufgaben-Pfad, auch bei eingeschalteter Direkt-Erfassung', async ({
  page,
}) => {
  await enableDirectCapture(page);
  await page.goto('/aufgaben');

  const halbEins = expectedDueAt(ZEIGERZEIT_NOW, 1, 0, 30);
  await submitQuickAdd(page, 'morgen halb eins Mittagessen');

  let dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Titel der Aufgabe' })).toHaveValue('Mittagessen');
  await expect(dialog.getByLabel('Fälligkeit')).toHaveValue(isoToLocalInput(halbEins));
  await expect(dialog.locator('.capture-confirm__summary')).toHaveText(formatSummary(halbEins));
  await dialog.getByRole('button', { name: 'Anlegen' }).click();
  await expect(dialog).toBeHidden();
  await expect(taskItems(page).filter({ hasText: 'Mittagessen' })).toBeVisible();

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

test('AK3 Gegenfall: eine geratene Zeit außerhalb des Nachtfensters respektiert weiter die Direkt-Erfassung', async ({
  page,
}) => {
  await enableDirectCapture(page);
  await page.goto('/aufgaben');
  const due = expectedDueAt(ZEIGERZEIT_NOW, 1, 6, 0);

  await submitQuickAdd(page, 'morgen um 6 Sport');

  await expect(confirmDialog(page)).toBeHidden();
  await expect(taskItems(page).filter({ hasText: 'Sport' })).toBeVisible();
  const entries = await page.evaluate(() => window.__starship.pending());
  expect(entries[entries.length - 1].payload).toMatchObject({ dueAt: due.toISOString() });
});

test('AK5: ein Tageszeitwort schlägt die Vormittags/Nachmittags-Heuristik immer', async ({ page }) => {
  await page.goto('/uebersicht');
  const abends = expectedDueAt(ZEIGERZEIT_NOW, 1, 20, 0);

  // Ohne Tageszeitwort läge "um 8" auf der Vormittagslesart (10:00 Bezugspunkt) —
  // "abends" schlägt das.
  await submitUebersichtCapture(page, 'morgen um 8 abends Kino');

  await page.waitForURL('**/kalender');
  const dialog = eventDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Titel')).toHaveValue('Kino');
  await wannChip(dialog).click();
  await expect(dialog.getByLabel('Von')).toHaveValue(isoToLocalInput(abends));
});

test('AK6: dieselbe Eingabe liest sich je nach Sprechzeitpunkt vormittags oder nachmittags', async ({ page }) => {
  await page.goto('/uebersicht');
  const vormittags = expectedDueAt(ZEIGERZEIT_NOW, 1, 8, 0);

  await submitUebersichtCapture(page, 'morgen um 8 Standup');
  await page.waitForURL('**/kalender');
  let dialog = eventDialog(page);
  await wannChip(dialog).click();
  await expect(dialog.getByLabel('Von')).toHaveValue(isoToLocalInput(vormittags));
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Derselbe Satz, aber gesprochen um 15:00 statt 10:00 — Nachmittagslesart.
  await installClockAt(page, ZEIGERZEIT_NOW_AFTERNOON);
  await page.goto('/uebersicht');
  const nachmittags = expectedDueAt(ZEIGERZEIT_NOW_AFTERNOON, 1, 20, 0);

  await submitUebersichtCapture(page, 'morgen um 8 Standup');
  await page.waitForURL('**/kalender');
  dialog = eventDialog(page);
  await wannChip(dialog).click();
  await expect(dialog.getByLabel('Von')).toHaveValue(isoToLocalInput(nachmittags));
});

test('Offline-Pfad: eine mit Zeigerzeit erfasste Aufgabe übersteht offline die Anlage und erreicht online die Datenbank', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  // beforeEach hat die Sync-Endpunkte bereits gekappt — das ist der Tunnel ohne Netz.
  const due = expectedDueAt(ZEIGERZEIT_NOW, 1, 8, 45);

  await submitQuickAdd(page, 'morgen viertel vor neun Zahnarzt');

  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Fälligkeit')).toHaveValue(isoToLocalInput(due));
  await dialog.getByRole('button', { name: 'Anlegen' }).click();

  await expect(taskItems(page).filter({ hasText: 'Zahnarzt' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  const row = await withDb((client) =>
    client.query('SELECT due_at FROM tasks WHERE title = $1', ['Zahnarzt']),
  );
  expect(row.rowCount).toBe(1);
  expect(new Date(row.rows[0].due_at).toISOString()).toBe(due.toISOString());
});
