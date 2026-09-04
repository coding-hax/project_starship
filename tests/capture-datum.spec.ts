import { expect, test, type Page } from '@playwright/test';
import { installClockAt, registerPasskey, resetAppData, selectView, withDb } from './helpers';

/**
 * Datumsvokabular, Tagesgrenze 04:00, rückwirkendes Abhaken (issue #689, Teil 3 von 3
 * des Parser-Umbaus, Epic #617). Alle Tests dieses Tickets in einer Datei
 * (45-Minuten-Fenster, CLAUDE.md) — die erschöpfende Datums-/Zeit-Arithmetik läuft als
 * Vitest-Korpus (corpus.ts, parse-task-input.test.ts); hier geht es um das
 * end-to-end sichtbare Verhalten je AK.
 *
 * Eigene Bezugspunkte statt `FIXED_NOW` aus helpers.ts: Montag 10:00 Berlin (wie der
 * Bezugspunkt des Tickets selbst) und, für AK5/AK6, Dienstag 01:30 Berlin — die Nacht
 * über die Tagesgrenze 04:00 hinweg, an der der logische Tag noch der Montag ist.
 * Januar, damit die Zeitzone durchgehend CET bleibt (kein DST-Wechsel mittendrin).
 */
const MO = new Date(2026, 0, 12, 10, 0, 0); // Montag, 12.01.2026, 10:00 Berlin
const NACHT = new Date(2026, 0, 13, 1, 30, 0); // Dienstag, 13.01.2026, 01:30 Berlin — logischer Tag: Montag

const CAPTURE_LABEL = 'Aufgabe erfassen';

function captureButton(page: Page) {
  return page.getByRole('button', { name: CAPTURE_LABEL });
}

function captureTitleField(page: Page) {
  return page.getByRole('textbox', { name: 'Titel der Aufgabe' });
}

function taskItems(page: Page) {
  return page.getByRole('list', { name: 'Aufgaben' }).getByRole('listitem');
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

/** Tag relativ zu `base`, nie hart codiert (Muster aus capture-zeigerzeit.spec.ts). */
function dueAt(base: Date, daysFromNow: number, hours: number, minutes: number): Date {
  const date = new Date(base);
  date.setDate(date.getDate() + daysFromNow);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function dateKeyOf(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function pendingHabitLogDates(page: Page): Promise<string[]> {
  const entries = await page.evaluate(() => window.__starship.pending());
  return entries
    .filter((entry) => entry.table === 'habit_logs')
    .map((entry) => entry.payload.logDate as string);
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // Weder Aufgaben- noch Termin-Pfad dürfen je direkt fetchen (CLAUDE.md Regel 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await installClockAt(page, MO.toISOString());
  // No target: every test in this file opens with its own goto, so loading
  // /uebersicht here would only be thrown away (issue #1075).
  await registerPasskey(page, null);
});

test('AK1: Monatsname löst auf, ein kalendarisch ungültiges Datum wird verworfen statt gerollt', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const due = new Date(2026, 7, 4, 9, 0, 0);

  // Seit P1–P4 (#715) legt "Anlegen" auf /uebersicht direkt über die Outbox an,
  // kein Bestätigen-Dialog mehr dazwischen — prüfbar ist der korrekt aufgelöste
  // Titel + Fälligkeit in der Outbox-Payload, danach die Sichtbarkeit in der Liste.
  await submitUebersichtCapture(page, 'am 4. August Zahnarzt');

  await expect(page).toHaveURL(/\/uebersicht$/);
  let entries = await page.evaluate(() => window.__starship.pending());
  expect(entries[entries.length - 1].payload).toMatchObject({
    title: 'Zahnarzt',
    dueAt: due.toISOString(),
  });
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await expect(taskItems(page).filter({ hasText: 'Zahnarzt' })).toBeVisible();

  // "31.6." existiert nicht — der Kandidat wird verworfen (kein Rollover auf den 1.
  // Juli), der Rohtext bleibt Titel. "Termin" im Satz ist reines Vokabular ohne Datum
  // -> ein Termin auf den heutigen (logischen) Tag um 09:00, derselbe Fallback wie
  // "Meeting mit Chef" (capture-art.spec.ts AK4-Kernfeld) — der Kern-Sheet-Pfad kennt
  // seit P1–P4 keinen ganztägigen Fall mehr, den gibt es nur noch im "Mehr"-Editor.
  await page.goto('/uebersicht');
  await submitUebersichtCapture(page, 'am 31.6. Termin');

  await expect(page).toHaveURL(/\/uebersicht$/);
  entries = await page.evaluate(() => window.__starship.pending());
  const eventEntry = entries.find((entry) => entry.table === 'events');
  expect(eventEntry?.payload).toMatchObject({ title: 'am 31.6. Termin', allDay: false });
  const startsAt = new Date(eventEntry?.payload.startsAt as string);
  expect(startsAt.getHours()).toBe(9);
  expect(startsAt.getMinutes()).toBe(0);
  expect(dateKeyOf(startsAt)).toBe(dateKeyOf(MO));
});

test('AK2: relative Spannen "in N Tagen"/"in einer Woche"', async ({ page }) => {
  await page.goto('/uebersicht');
  const in3Days = dueAt(MO, 3, 9, 0);

  await submitUebersichtCapture(page, 'in drei Tagen Rechnung zahlen');

  await expect(page).toHaveURL(/\/uebersicht$/);
  let entries = await page.evaluate(() => window.__starship.pending());
  expect(entries[entries.length - 1].payload).toMatchObject({
    title: 'Rechnung zahlen',
    dueAt: in3Days.toISOString(),
  });

  await page.goto('/uebersicht');
  const in1Week = dueAt(MO, 7, 9, 0);
  await submitUebersichtCapture(page, 'in einer Woche nachfassen');

  entries = await page.evaluate(() => window.__starship.pending());
  expect(entries[entries.length - 1].payload).toMatchObject({
    title: 'nachfassen',
    dueAt: in1Week.toISOString(),
  });
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await expect(taskItems(page).filter({ hasText: 'nachfassen' })).toBeVisible();
});

test('AK3: "nächsten" überspringt eine Woche gegenüber der bloßen Wochentagsform', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const bareDienstag = dueAt(MO, 1, 9, 0);

  await submitUebersichtCapture(page, 'Dienstag Steuer machen');

  await expect(page).toHaveURL(/\/uebersicht$/);
  let entries = await page.evaluate(() => window.__starship.pending());
  expect(entries[entries.length - 1].payload).toMatchObject({
    title: 'Steuer machen',
    dueAt: bareDienstag.toISOString(),
  });

  await page.goto('/uebersicht');
  const naechstenDienstag = dueAt(MO, 8, 9, 0);
  await submitUebersichtCapture(page, 'nächsten Dienstag Zahnarzt');

  entries = await page.evaluate(() => window.__starship.pending());
  expect(entries[entries.length - 1].payload).toMatchObject({
    title: 'Zahnarzt',
    dueAt: naechstenDienstag.toISOString(),
  });
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await expect(taskItems(page).filter({ hasText: 'Zahnarzt' })).toBeVisible();
});

test('AK4: der Satz aus #620 fällt lokal', async ({ page }) => {
  await page.goto('/uebersicht');
  const due = dueAt(MO, 8, 8, 45);

  await submitUebersichtCapture(
    page,
    'kannst du mir für nächsten Dienstag viertel vor neun einen Zahnarzttermin einstellen',
  );

  await expect(page).toHaveURL(/\/uebersicht$/);
  const entries = await page.evaluate(() => window.__starship.pending());
  expect(entries[entries.length - 1].payload).toMatchObject({
    title: 'Zahnarzttermin',
    startsAt: due.toISOString(),
  });
});

test('AK5: Tagesgrenze 04:00 — zwischen 00:00 und 03:59 zählt noch der vorherige Kalendertag als "heute"', async ({
  page,
}) => {
  await installClockAt(page, NACHT.toISOString());
  await page.goto('/uebersicht');
  const morgen14Uhr = dueAt(MO, 1, 14, 0);

  await submitUebersichtCapture(page, 'Termin morgen 14 Uhr Zahnarzt');

  await expect(page).toHaveURL(/\/uebersicht$/);
  let entries = await page.evaluate(() => window.__starship.pending());
  expect(entries[entries.length - 1].payload).toMatchObject({
    title: 'Zahnarzt',
    startsAt: morgen14Uhr.toISOString(),
  });

  // Reine Uhrzeit ohne Datum: "sonst morgen" rechnet ab dem logischen, nicht dem
  // realen Tag — 8 Uhr am logischen Montag ist um 01:30 Dienstag längst vorbei.
  await page.goto('/uebersicht');
  const umAcht = dueAt(MO, 1, 8, 0);
  await submitUebersichtCapture(page, 'Zahnarzttermin um 8');

  entries = await page.evaluate(() => window.__starship.pending());
  expect(entries[entries.length - 1].payload).toMatchObject({
    title: 'Zahnarzttermin',
    startsAt: umAcht.toISOString(),
  });
});

test('AK6: Abhaken folgt dem logischen Tag, nicht dem realen', async ({ page }) => {
  await installClockAt(page, NACHT.toISOString());
  await page.goto('/uebersicht');
  await seedHabit(page, { name: 'Sport', schedule: 'daily', color: null, archivedAt: null });

  await submitUebersichtCapture(page, 'Sport gemacht');

  await expect(page).toHaveURL(/\/uebersicht$/);
  // Kein Toast mehr, der das Abhaken bestätigt (issue #797) — auf den
  // tatsächlichen Outbox-Eintrag warten, statt auf seine frühere Anzeige.
  await expect.poll(async () => (await pendingHabitLogDates(page)).length).toBe(1);

  await page.goto('/uebersicht');
  await submitUebersichtCapture(page, 'gestern Sport gemacht');
  await expect.poll(async () => (await pendingHabitLogDates(page)).length).toBe(2);

  const logDates = (await pendingHabitLogDates(page)).sort();
  expect(logDates).toEqual([dateKeyOf(dueAt(MO, -1, 0, 0)), dateKeyOf(MO)].sort());
});

test('AK6/R7: ein genanntes Datum steuert bis 7 Tage rückwärts den Log-Tag, Zukunft wird ignoriert', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedHabit(page, { name: 'Sport', schedule: 'daily', color: null, archivedAt: null });

  await submitUebersichtCapture(page, 'Sport für gestern abhaken');
  // Kein Toast mehr, der das Abhaken bestätigt (issue #797) — auf den
  // tatsächlichen Outbox-Eintrag warten, statt auf seine frühere Anzeige.
  await expect.poll(async () => (await pendingHabitLogDates(page)).length).toBe(1);

  await page.goto('/uebersicht');
  await submitUebersichtCapture(page, 'Sport für morgen abhaken');
  await expect.poll(async () => (await pendingHabitLogDates(page)).length).toBe(2);

  const logDates = (await pendingHabitLogDates(page)).sort();
  expect(logDates).toEqual([dateKeyOf(dueAt(MO, -1, 0, 0)), dateKeyOf(MO)].sort());
});

test('Offline-Pfad: eine Erfassung mit relativem Datum offline erreicht online die Datenbank', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  // beforeEach hat die Sync-Endpunkte bereits gekappt — das ist der Tunnel ohne Netz.
  const due = dueAt(MO, 3, 9, 0);

  await submitUebersichtCapture(page, 'in drei Tagen Rechnung zahlen');

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  const row = await withDb((client) =>
    client.query('SELECT due_at FROM tasks WHERE title = $1', ['Rechnung zahlen']),
  );
  expect(row.rowCount).toBe(1);
  expect(new Date(row.rows[0].due_at).toISOString()).toBe(due.toISOString());
});
