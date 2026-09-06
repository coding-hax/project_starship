import { expect, test, type Page } from '@playwright/test';
import { FIXED_NOW, installClockAt, registerPasskey, resetAppData, skewClock, withDb } from './helpers';

const CAPTURE_LABEL = 'Aufgabe erfassen';
const RECURRENCE_TEXT = 'Termin Arzt jede Woche';
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function captureButton(page: Page) {
  return page.getByRole('button', { name: CAPTURE_LABEL });
}

function captureTitleField(page: Page) {
  return page.getByRole('textbox', { name: 'Titel der Aufgabe' });
}

/** Nur der Chip-Körper — `/^Wiederholung/` allein matcht auch den Verwerfen-Knopf
 * ("Wiederholung verwerfen"), das Komma grenzt auf den Wert-Button ein (gleiches
 * Muster wie capture-uebersicht.spec.ts's `/^Fälligkeit,/`). */
function recurrenceChip(page: Page) {
  return page.getByRole('button', { name: /^Wiederholung,/ });
}

function eventCard(page: Page, title: string) {
  return page.locator('.event-agenda__item').filter({ hasText: title });
}

async function typeCapture(page: Page, text: string) {
  await captureButton(page).click();
  await captureTitleField(page).fill(text);
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // Der Erfassungspfad darf nie direkt gegen /api sprechen (CLAUDE.md Regel 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await installClockAt(page);
  // Kein Ziel: jeder Test hier navigiert selbst (issue #1075).
  await registerPasskey(page, null);
});

test('AK4: eine erkannte Wiederholung zeigt vor dem Anlegen einen Klartext-Chip', async ({ page }) => {
  await page.goto('/uebersicht');
  await typeCapture(page, RECURRENCE_TEXT);

  await expect(recurrenceChip(page)).toHaveText('Jede Woche');
});

test('AK4: ohne erkannte Wiederholung erscheint der Chip gar nicht', async ({ page }) => {
  await page.goto('/uebersicht');
  await typeCapture(page, 'Termin Arzt morgen 12 Uhr');

  await expect(recurrenceChip(page)).toHaveCount(0);
});

test('AK5: der Wiederholungs-Chip laesst sich verwerfen — danach legt "Anlegen" einen einzelnen Termin ohne Wiederholung an', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await typeCapture(page, RECURRENCE_TEXT);
  // Erst übernehmen (Enter leert die Eingabezeile) — sonst leitet die reaktive
  // Vorschau-Merge (issue #716) die Wiederholung aus dem weiterhin getippten Text
  // sofort wieder her, sobald das Verwerfen den übernommenen Stand nullt (gleiches
  // Muster wie tasks.spec.ts's Fälligkeit-Verwerfen-Test).
  await captureTitleField(page).press('Enter');
  await expect(recurrenceChip(page)).toBeVisible();

  await page.getByRole('button', { name: 'Wiederholung verwerfen' }).click();
  await expect(recurrenceChip(page)).toHaveCount(0);

  await page.getByRole('button', { name: 'Anlegen' }).click();
  await expect(page).toHaveURL(/\/uebersicht$/);

  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.find((entry) => entry.table === 'events');
  expect(created?.payload.recurrence).toBeNull();
});

test('AK6: „Termin Arzt jede Woche" legt einen wiederkehrenden Termin an — er erscheint diese und die Folgewoche am selben Wochentag', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await typeCapture(page, RECURRENCE_TEXT);
  await expect(recurrenceChip(page)).toHaveText('Jede Woche');
  await page.getByRole('button', { name: 'Anlegen' }).click();
  await expect(page).toHaveURL(/\/uebersicht$/);

  await page.goto('/kalender');
  await expect(eventCard(page, 'Arzt')).toBeVisible();

  // Eine Woche später, gleicher Wochentag — die Serie punktet weiter (vgl.
  // kalender.spec.ts's eigene woechentliche-Serie-Tests, gleiches Muster).
  const nextWeek = new Date(new Date(FIXED_NOW).getTime() + ONE_WEEK_MS).toISOString();
  await skewClock(page, nextWeek);
  await page.reload();
  await expect(eventCard(page, 'Arzt')).toBeVisible();
});

test('AK7 Offline: derselbe Satz offline erfasst erreicht online die Datenbank mit seiner Wiederholung', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  // beforeEach hat die Sync-Endpunkte bereits gekappt — das ist der Tunnel-Fall.
  await typeCapture(page, RECURRENCE_TEXT);
  await page.getByRole('button', { name: 'Anlegen' }).click();

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  const row = await withDb((client) =>
    client.query('SELECT recurrence FROM events WHERE title = $1', ['Termin Arzt']),
  );
  expect(row.rowCount).toBe(1);
  expect(row.rows[0].recurrence).toEqual({ freq: 'weekly', interval: 1 });
});
