import { expect, test, type Page } from '@playwright/test';
import {
  FIXED_NOW,
  installClockAt,
  registerPasskey,
  resetAppData,
  selectView,
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

/** Mirrors parse-task-input.ts's own default time (09:00), computed at run time —
 * never hard-coded (helpers.ts pattern used elsewhere). */
function expectedDueAt(daysFromNow: number, hours: number, minutes: number): Date {
  const date = new Date(FIXED_NOW);
  date.setDate(date.getDate() + daysFromNow);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function dateKeyOf(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `YYYY-MM-DD` of the fixed "now" — same calendar day in Berlin time. */
function todayKey(): string {
  return dateKeyOf(new Date(FIXED_NOW));
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // Neither the task- nor the event-side of the router may ever fetch directly
  // (CLAUDE.md rule 8) — everything below must survive with sync cut off.
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await installClockAt(page);
  await registerPasskey(page);
});

test('AC1: "morgen 12 Uhr Zahnarzt" legt den Termin in-place an, kein Kalender-Umweg mehr nötig (issue #715 AK3)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const due = expectedDueAt(1, 12, 0);

  await submitUebersichtCapture(page, 'Termin morgen 12 Uhr Zahnarzt');

  await expect(page).toHaveURL(/\/uebersicht$/);
  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.find((entry) => entry.table === 'events');
  expect(created?.payload).toMatchObject({
    title: 'Zahnarzt',
    allDay: false,
    startsAt: due.toISOString(),
  });
});

test('AC2: Freitext ohne erkanntes Datum ergibt einen Termin auf den heutigen Tag um 09:00 (issue #715 AK4)', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  await submitUebersichtCapture(page, 'Meeting mit Chef');

  await expect(page).toHaveURL(/\/uebersicht$/);
  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.find((entry) => entry.table === 'events');
  // "Meeting" bleibt im Titel stehen (R3, #687 AK3): nur Datum-/Zeit-Spans und
  // angrenzende Bindewörter werden entfernt, keine Vokabular-Blacklist mehr.
  // Ganztägig gibt es seit P1–P4 (#715) im Kern-Sheet nicht mehr — ohne
  // erkannte Uhrzeit fällt der Termin auf 09:00 des heutigen Tages zurück
  // (derselbe Default wie capture-art.spec.ts AK4-Kernfeld).
  expect(created?.payload).toMatchObject({ title: 'Meeting mit Chef', allDay: false });
  const startsAt = new Date(created?.payload.startsAt as string);
  expect(startsAt.getHours()).toBe(9);
  expect(startsAt.getMinutes()).toBe(0);
  expect(dateKeyOf(startsAt)).toBe(todayKey());
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

test('AC4: Gewohnheitsname ohne eindeutigen Treffer öffnet die Routine-Auswahl in-place, hakt nichts ab (issue #715 AK5)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedHabit(page, { name: 'Yoga', schedule: 'daily', color: null, archivedAt: null });
  await seedHabit(page, { name: 'Lauf', schedule: 'daily', color: null, archivedAt: null });

  await submitUebersichtCapture(page, 'hake Yoga Lauf ab');

  // Ohne Wahl legt "Anlegen" nichts an — das Sheet bleibt offen, die Auswahl
  // öffnet sich stattdessen (capture-art.spec.ts AK5), statt still nach
  // /routinen zu navigieren.
  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(page.getByRole('dialog', { name: CAPTURE_LABEL })).toBeVisible();

  const entries = await page.evaluate(() => window.__starship.pending());
  expect(entries.some((entry) => entry.table === 'habit_logs')).toBe(false);
});

test('AC5: Kalender-Modul abgeschaltet macht aus "Termin morgen 12 Uhr Zahnarzt" eine direkt angelegte Aufgabe (issue #715 AK3)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await page.evaluate(() =>
    localStorage.setItem('starship:modules-off', JSON.stringify(['kalender'])),
  );
  await page.goto('/uebersicht');
  const due = expectedDueAt(1, 12, 0);

  await submitUebersichtCapture(page, 'Termin morgen 12 Uhr Zahnarzt');

  await expect(page).toHaveURL(/\/uebersicht$/);
  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.find((entry) => entry.table === 'tasks');
  expect(created?.payload).toMatchObject({ title: 'Zahnarzt', dueAt: due.toISOString() });
});

test('AC6: der Aufgaben-Pfad aus #618 bleibt unverändert — Freitext ohne Termin-Signal landet weiter direkt in /aufgaben', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  await submitUebersichtCapture(page, 'Wäsche waschen');

  await expect(page).toHaveURL(/\/uebersicht$/);
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await expect(
    page
      .getByRole('list', { name: 'Aufgaben' })
      .getByRole('listitem')
      .filter({ hasText: 'Wäsche waschen' }),
  ).toBeVisible();
});

test('AC7: offline per Freitext erfasster Termin erreicht nach dem Onlinegehen die Datenbank', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  // beforeEach already cut the sync endpoints — that's what a train tunnel looks
  // like to the outbox (gleiches Muster wie capture-uebersicht.spec.ts AC6).
  const due = expectedDueAt(1, 12, 0);

  await submitUebersichtCapture(page, 'Termin morgen 12 Uhr Zahnarzt');

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  const row = await withDb((client) =>
    client.query('SELECT starts_at FROM events WHERE title = $1', ['Zahnarzt']),
  );
  expect(row.rowCount).toBe(1);
  expect(new Date(row.rows[0].starts_at).toISOString()).toBe(due.toISOString());
});
