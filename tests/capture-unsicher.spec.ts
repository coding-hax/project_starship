import { expect, test, type Page } from '@playwright/test';
import { installClockAt, registerPasskey, resetAppData } from './helpers';

/**
 * Unsicher erkannte Felder im Bestätigen-Dialog markieren (issue #691, Teil 4 des
 * Parser-Umbaus, Epic #617). Alle Tests dieses Tickets in einer Datei
 * (45-Minuten-Fenster, CLAUDE.md) — die Feld-Konfidenz selbst (welche Regel welchen
 * Grundtext liefert) läuft erschöpfend als Vitest-Korpus (corpus.ts,
 * local-recognizer.test.ts); hier geht es um das sichtbare Verhalten je AK.
 *
 * Eigener Bezugspunkt statt `FIXED_NOW` aus helpers.ts: Montag 10:00 Berlin, wie der
 * Bezugspunkt des Tickets selbst — "Dienstag um 3" löst dann wie im Ticket beschrieben
 * auf, unabhängig davon, dass die Feld-Konfidenz seit #691 nicht mehr vom Nachtfenster
 * abhängt (anders als `needsConfirmation`).
 */
const NOW = '2026-07-20T08:00:00.000Z'; // Montag, 20.07.2026, 10:00 Berlin (CEST)

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

function taskItems(page: Page) {
  return page.getByRole('list', { name: 'Aufgaben' }).getByRole('listitem');
}

async function submitUebersichtCapture(page: Page, text: string) {
  await captureButton(page).click();
  await captureTitleField(page).fill(text);
  await page.getByRole('button', { name: 'Hinzufügen' }).click();
}

async function submitQuickAdd(page: Page, text: string) {
  await captureButton(page).click();
  await captureTitleField(page).fill(text);
  await page.getByRole('button', { name: 'Hinzufügen' }).click();
}

async function resolveColorToken(page: Page, token: string): Promise<string> {
  return page.evaluate((cssVar) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${cssVar})`;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // Weder Aufgaben- noch Termin-Pfad dürfen je direkt fetchen (CLAUDE.md Regel 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await installClockAt(page, NOW);
  await registerPasskey(page);
});

test('AK1: geratenes Feld ist markiert, sicheres Feld bleibt unmarkiert', async ({ page }) => {
  await page.goto('/aufgaben');

  // "Dienstag" (blanker Wochentag) + "um 3" (Tageshälfte aus dem Sprechzeitpunkt) —
  // beide geraten, der Titel "Zahnarzt" bleibt unangetastet.
  await submitQuickAdd(page, 'Dienstag um 3 Zahnarzt');
  let dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Titel der Aufgabe' })).toHaveValue('Zahnarzt');
  // Genau eine Markierung — unter Fälligkeit, keine am Titel.
  await expect(dialog.locator('.field-hint')).toHaveCount(1);
  await expect(dialog.locator('.field-hint')).toContainText('Wochentag ohne Datum');
  await expect(dialog.locator('.field-hint')).toContainText('Tageshälfte geraten');
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(dialog).toBeHidden();

  // "morgen 14:30" ist ein relativer Tag + eine ausgeschriebene Uhrzeit — beides sicher.
  await submitQuickAdd(page, 'morgen 14:30 Zahnarzt');
  dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.field-hint')).toHaveCount(0);
});

test('AK2: der Grund steht als Satzfragment bei der Markierung, kein generisches "unsicher"', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await submitQuickAdd(page, 'Dienstag um 3 Zahnarzt');

  const hint = confirmDialog(page).locator('.field-hint');
  await expect(hint).toHaveText('Wochentag ohne Datum · Tageshälfte geraten');
  await expect(hint).not.toContainText('unsicher');
});

test('AK3: derselbe Termin markiert dieselben Felder nach denselben Regeln im Kalender-Editor', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  // Explizite Uhrzeit -> event (der Pfad, über den jeder erkannte Termin läuft).
  await submitUebersichtCapture(page, 'Dienstag um 3 Zahnarzt');

  await page.waitForURL('**/kalender');
  const dialog = eventDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Titel')).toHaveValue('Zahnarzt');
  await expect(dialog.locator('.field-hint')).toHaveCount(1);
  await expect(dialog.locator('.field-hint')).toHaveText('Wochentag ohne Datum · Tageshälfte geraten');
});

test('AK4: Anfassen eines markierten Feldes räumt seine Markierung weg', async ({ page }) => {
  // Fälligkeit im Aufgaben-Bestätigen-Dialog.
  await page.goto('/aufgaben');
  await submitQuickAdd(page, 'Dienstag um 3 Zahnarzt');
  const taskDialog = confirmDialog(page);
  await expect(taskDialog.locator('.field-hint')).toHaveCount(1);

  await taskDialog.getByLabel('Fälligkeit').fill('2026-07-22T09:00');
  await expect(taskDialog.locator('.field-hint')).toHaveCount(0);
  await taskDialog.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(taskDialog).toBeHidden();

  // Titel im Termin-Editor — "morgen um 12" hat nach Abzug aller Spans keinen Titel-Rest
  // mehr; Mittag ist der Zwölf-Fixpunkt, also bleiben Datum/Uhrzeit hier unmarkiert.
  await page.goto('/uebersicht');
  await submitUebersichtCapture(page, 'morgen um 12');
  await page.waitForURL('**/kalender');
  const eventDlg = eventDialog(page);
  await expect(eventDlg.locator('.field-hint')).toHaveCount(1);
  await expect(eventDlg.locator('.field-hint')).toHaveText('kein Titel erkannt');

  await eventDlg.getByLabel('Titel').fill('Zahnarzt');
  await expect(eventDlg.locator('.field-hint')).toHaveCount(0);
});

test('AK5: kein Fehlerzustand — Warnfarbe statt Gefahr, kein blockierter Speichern-Knopf, kein Icon', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await submitQuickAdd(page, 'Dienstag um 3 Zahnarzt');
  const dialog = confirmDialog(page);
  const hint = dialog.locator('.field-hint');
  await expect(hint).toBeVisible();

  const [hintColor, warningColor, dangerColor] = await Promise.all([
    hint.evaluate((el) => getComputedStyle(el).color),
    resolveColorToken(page, '--color-warning'),
    resolveColorToken(page, '--color-danger'),
  ]);
  expect(hintColor).toBe(warningColor);
  expect(hintColor).not.toBe(dangerColor);

  // Kein Icon in oder neben der Markierung — nur der Grundtext.
  await expect(hint.locator('svg')).toHaveCount(0);

  // Die Vermutung blockiert nichts — der Knopf legt trotz Markierung an.
  const submit = dialog.getByRole('button', { name: 'Anlegen' });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(dialog).toBeHidden();
  await expect(taskItems(page).filter({ hasText: 'Zahnarzt' })).toBeVisible();
});

test('AK6: Design-Pflicht — Dark Mode, prefers-reduced-motion, iPhone 12 mini ohne Zeilenumbruch', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/aufgaben');

  // Referenz: Höhe der (einzeiligen) Titelzeile ganz ohne Markierung.
  await submitQuickAdd(page, 'morgen 14:30 Zahnarzt');
  let dialog = confirmDialog(page);
  const unmarkedHeight = (
    await dialog.getByRole('textbox', { name: 'Titel der Aufgabe' }).boundingBox()
  )?.height;
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(dialog).toBeHidden();

  // Derselbe Fall, aber mit Markierung — die Titelzeile bleibt exakt gleich hoch,
  // die Markierung selbst hängt als eigene Zeile darunter, bricht keine bestehende um.
  await submitQuickAdd(page, 'Dienstag um 3 Zahnarzt');
  dialog = confirmDialog(page);
  const markedHeight = (
    await dialog.getByRole('textbox', { name: 'Titel der Aufgabe' }).boundingBox()
  )?.height;
  expect(markedHeight).toBe(unmarkedHeight);

  const hint = dialog.locator('.field-hint');
  await expect(hint).toBeVisible();

  // Keine Bewegung — statische, tokenbasierte Farbe braucht keinen Übergang.
  await expect
    .poll(() => hint.evaluate((el) => getComputedStyle(el).transitionProperty))
    .toBe('none');

  // Dark Mode: derselbe Token, nur sein dunkler Wert.
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const [darkHintColor, darkWarningColor] = await Promise.all([
    hint.evaluate((el) => getComputedStyle(el).color),
    resolveColorToken(page, '--color-warning'),
  ]);
  expect(darkHintColor).toBe(darkWarningColor);
});
