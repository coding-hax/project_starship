import { expect, test, type Page } from '@playwright/test';
import { FIXED_NOW, installClockAt, registerPasskey, resetAppData } from './helpers';

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

/** Mirrors parse-task-input.ts's own default time (09:00), computed at run time —
 * never hard-coded (helpers.ts pattern used elsewhere). */
function expectedDueAt(daysFromNow: number, hours: number, minutes: number): Date {
  const date = new Date(FIXED_NOW);
  date.setDate(date.getDate() + daysFromNow);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

/** `datetime-local` works in the browser's local time, with no timezone suffix. */
function isoToLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // Kein Absenden in dieser Suite — trotzdem abgesperrt, damit ein versehentlicher
  // Fetch (CLAUDE.md Regel 8) sofort auffiele statt still durchzulaufen.
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await installClockAt(page);
  // No target: every test in this file opens with its own goto, so loading
  // /uebersicht here would only be thrown away (issue #1075).
  await registerPasskey(page, null);
});

test('AK4: "Mehr" bei Termin öffnet das volle Modul-Sheet mit übernommenen Kernwerten, kein Seitenwechsel', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const due = expectedDueAt(1, 12, 0);
  await captureButton(page).click();
  await captureTitleField(page).fill('Termin morgen 12 Uhr Zahnarzt');
  await page.getByRole('button', { name: 'Kategorie' }).click();
  // Nicht `getByLabel('Kategorie')`: das immer gemountete (meist geschlossene)
  // `EventEditor` trägt sein eigenes gleichnamiges Feld unabhängig von `open`
  // im DOM — `getByLabel` filtert das anders als `getByRole` nicht heraus.
  await page.locator('#uebersicht-capture-panel-kategorie').selectOption('gesundheit');

  await page.getByRole('button', { name: 'Mehr' }).click();

  await expect(captureDialog(page)).toBeHidden();
  await expect(page).toHaveURL(/\/uebersicht$/);
  // issue #1083: während der Schließ-Transition des Kern-Sheets trägt es
  // denselben Namen wie der frisch geöffnete Termin-Editor — `[open]` filtert
  // das schließende Exemplar heraus.
  const dialog = page.getByRole('dialog', { name: 'Termin erfassen' }).and(page.locator('[open]'));
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Titel')).toHaveValue('Zahnarzt');
  // Ganztägig/Von/Bis sitzen seit #712 hinter dem Wann-Chip — vor jedem Zugriff öffnen.
  await dialog.getByRole('button', { name: /^Wann/ }).click();
  await expect(dialog.getByLabel('Von')).toHaveValue(isoToLocalInput(due));
  await expect(dialog.getByRole('switch', { name: 'Ganztägig' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  // Kategorie sitzt seit #712 ebenfalls hinter einem eigenen Chip (nur ein
  // Panel gleichzeitig offen). `exact: true`: der Chip-Button selbst trägt
  // "Kategorie, Gesundheit" als aria-label — eine Teilzeichenkette von
  // "Kategorie" — und würde sonst zusätzlich zum echten <select> matchen.
  await dialog.getByRole('button', { name: /^Kategorie/ }).click();
  await expect(dialog.getByLabel('Kategorie', { exact: true })).toHaveValue('gesundheit');
  await expect(dialog.getByRole('button', { name: /^Wiederholung/ })).toBeVisible();

  await dialog.getByRole('button', { name: 'Anlegen' }).click();

  await expect(dialog).toBeHidden();
  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.find((entry) => entry.table === 'events');
  expect(created?.payload).toMatchObject({
    title: 'Zahnarzt',
    category: 'gesundheit',
    startsAt: due.toISOString(),
  });
});
