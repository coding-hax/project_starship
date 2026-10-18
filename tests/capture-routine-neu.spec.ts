import { expect, test, type Page } from '@playwright/test';
import { installClockAt, registerPasskey, resetAppData } from './helpers';

/**
 * issue #758: trifft die Spracherfassung auf `/uebersicht` bei Art „Routine" keine
 * bestehende Gewohnheit, kann die Routine-Auswahl jetzt explizit eine **neue**
 * Routine mit dem eingegebenen/erkannten Namen anlegen (analog Aufgabe/Termin) —
 * ein Test je AK1–AK7, Muster aus `tests/capture-art.spec.ts`.
 */

const CAPTURE_LABEL = 'Aufgabe erfassen';

function captureButton(page: Page) {
  return page.getByRole('button', { name: CAPTURE_LABEL });
}

// issue #1083: der Sheet-Kopf folgt der erkannten Art statt fest "Aufgabe
// erfassen" zu heißen — das eine, dauerhaft gemountete Titelfeld dieses Sheets
// identifiziert es unabhängig vom aktuellen Kopf-Label.
function captureDialog(page: Page) {
  return page
    .locator('dialog.sheet')
    .filter({ has: page.getByRole('textbox', { name: 'Titel der Aufgabe' }) });
}

function captureTitleField(page: Page) {
  return page.getByRole('textbox', { name: 'Titel der Aufgabe' });
}

function artChip(page: Page, label: string) {
  return page.getByRole('button', { name: `Art, ${label}` });
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // Kein echtes Absenden nötig: Anlegen läuft lokal-first über die Outbox
  // (CLAUDE.md Regel 8) — abgesperrt, damit ein versehentlicher Fetch sofort
  // auffiele statt still durchzulaufen. Nur der Offline-Test (AK7) hebt das
  // gezielt wieder auf.
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await installClockAt(page);
  // No target: every test in this file opens with its own goto, so loading
  // /uebersicht here would only be thrown away (issue #1075).
  await registerPasskey(page, null);
});

/**
 * issue #780: derselbe "Neue Routine anlegen"-Zweig, jetzt automatisch über den
 * Erkenner (`routineIntent`-Signal in local-recognizer.ts) statt nur über den
 * Art-Chip von Hand (#758, Tests oben) — ein Test je AK1–AK6 des Tickets.
 */

function newRoutineChip(page: Page, name: string) {
  return page.getByRole('button', { name: `Routine, Neu: „${name}"` });
}

test('#780 AK3/AK4: "Routine Wasser trinken" wird ohne Handwechsel als neue Routine erkannt, der Name trägt das Intent-Wort nicht', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await captureButton(page).click();
  await captureTitleField(page).fill('Routine Wasser trinken');

  await expect(artChip(page, 'Routine')).toBeVisible();
  await expect(newRoutineChip(page, 'Wasser trinken')).toBeVisible();

  await page.getByRole('button', { name: 'Anlegen' }).click();

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(captureDialog(page)).toBeHidden();
  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.filter((entry) => entry.table === 'habits');
  expect(created).toHaveLength(1);
  expect(created[0].payload).toMatchObject({
    name: 'Wasser trinken',
    schedule: 'daily',
    target: 1,
  });
});
