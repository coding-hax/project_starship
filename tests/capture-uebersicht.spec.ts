import { expect, test, type Page } from '@playwright/test';
import { formatDueLabel } from '@/features/tasks/datetime-local';
import { FIXED_NOW, installClockAt, registerPasskey, resetAppData, withDb } from './helpers';

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

/** issue #1089: der Fälligkeits-Chip der Aufgabe — leer zeigt nur "Fälligkeit"
 * (kein Komma), gesetzt "Fälligkeit, …" (dieselbe Regel wie `quickAddChip` in
 * tasks.spec.ts). */
function dueChip(page: Page) {
  return captureDialog(page).getByRole('button', { name: /^Fälligkeit(,|$)/ });
}

/** issue #1089: der Zeit-Chip des Termins, Pendant zu `dueChip`. */
function zeitChip(page: Page) {
  return captureDialog(page).getByRole('button', { name: /^Zeit(,|$)/ });
}

function captureDuePicker(page: Page) {
  return captureDialog(page).locator('.due-picker');
}

function dueQuickSelect(page: Page, label: 'Heute' | 'Morgen' | 'Nächste Woche') {
  return captureDuePicker(page).getByRole('button', { name: label, exact: true });
}

/** A calendar day cell by its full a11y label, e.g. `"Montag, 20."`. */
function dueCalendarDay(page: Page, label: string) {
  return captureDuePicker(page).getByRole('button', { name: label });
}

function dueTimeInput(page: Page) {
  return captureDuePicker(page).getByLabel('Uhrzeit');
}

function selectedDuePickerDay(page: Page) {
  return captureDuePicker(page).locator('.due-picker__day[aria-pressed="true"]');
}

/** Sets a due date+time through the picker the same way a person would: tap
 * the day, then optionally type a time (mirrors tasks.spec.ts's helper). */
async function setDueViaCalendar(page: Page, dayLabel: string, time?: string) {
  await dueCalendarDay(page, dayLabel).click();
  if (time) await dueTimeInput(page).fill(time);
}

/** issue #1089: der `DuePicker` hat keinen einzelnen Feldwert mehr (anders als
 * das abgelöste `datetime-local`) — die Zusicherung geht über den markierten
 * Kalendertag + das getrennte Uhrzeitfeld. */
async function expectDuePickerValue(page: Page, expected: Date) {
  await expect(selectedDuePickerDay(page)).toHaveText(String(expected.getDate()));
  await expect(dueTimeInput(page)).toHaveValue(isoToLocalInput(expected).slice(11));
}

async function enableDirectCapture(page: Page) {
  await page.goto('/einstellungen');
  await page.getByRole('switch', { name: 'Ohne Bestätigung direkt anlegen' }).click();
}

async function seedHabit(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'habits', op: 'upsert', payload: p }),
    payload,
  );
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

test('AC1: der Erfassungsknopf ist auf /uebersicht sichtbar, öffnet das Sheet, der Cursor steht im Feld', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  await expect(captureButton(page)).toBeVisible();
  await captureButton(page).click();

  await expect(captureTitleField(page)).toBeVisible();
  await expect(captureTitleField(page)).toBeFocused();
});

test('AC2: Freitext mit Datum zeigt die geratene Fälligkeit inline im Kern-Sheet, kein Bestätigen-Dialog mehr (issue #715 AK3)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  // Kein "um 12" mehr: seit #619 macht eine explizite Uhrzeit daraus einen Termin
  // (siehe capture-router.spec.ts) — reines Datum ohne Uhrzeit bleibt task, genau
  // was dieser Test hier prüfen will.
  const due = expectedDueAt(1, 9, 0);

  await captureButton(page).click();
  await captureTitleField(page).fill('Arzt anrufen morgen');

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(page.getByRole('dialog', { name: 'Aufgabe bestätigen' })).toHaveCount(0);
  await expect(dueChip(page)).toBeVisible();
  await dueChip(page).click();
  await expectDuePickerValue(page, due);
});

test('AC3: "Anlegen" legt die Aufgabe direkt an, sie erscheint in der Liste', async ({ page }) => {
  await page.goto('/uebersicht');

  await submitUebersichtCapture(page, 'Arzt anrufen morgen');

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(captureDialog(page)).toBeHidden();
  await page.goto('/aufgaben');
  await expect(taskItems(page).filter({ hasText: 'Arzt anrufen' })).toBeVisible();
});

test('AC4: Freitext ohne Datum legt die Aufgabe ohne Fälligkeit sofort an, kein Sheet', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await submitUebersichtCapture(page, 'Wäsche waschen');

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(captureDialog(page)).toBeHidden();
  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.find((entry) => entry.table === 'tasks');
  expect(created?.payload).toMatchObject({ title: 'Wäsche waschen' });
  expect(created?.payload.dueAt).toBeUndefined();
});

test('AC5: "ohne Bestätigung direkt anlegen" hat auf der Übersicht keine Wirkung mehr — es gibt dort ohnehin nie einen Zwischenschritt (issue #715 AK3)', async ({
  page,
}) => {
  await enableDirectCapture(page);
  await page.goto('/uebersicht');

  // Keine explizite Uhrzeit (siehe AC2-Kommentar oben) — bleibt task.
  await submitUebersichtCapture(page, 'Übergabe morgen');

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(captureDialog(page)).toBeHidden();
  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.find((entry) => entry.table === 'tasks');
  expect(created?.payload).toMatchObject({ title: 'Übergabe' });
});

test('AC6: offline auf der Übersicht erfasst, erreicht online die Datenbank', async ({ page }) => {
  await page.goto('/uebersicht');
  // beforeEach already cut the sync endpoints — that's what a train tunnel looks
  // like to the outbox. Keine explizite Uhrzeit (siehe AC2-Kommentar oben) — bleibt task.
  await submitUebersichtCapture(page, 'Im Zug notiert morgen');

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(captureDialog(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  const row = await withDb((client) =>
    client.query('SELECT due_at FROM tasks WHERE title = $1', ['Im Zug notiert']),
  );
  expect(row.rowCount).toBe(1);
  expect(row.rows[0].due_at).not.toBeNull();
});

test('AC9 (issue #920 AK5): bei 375px und erhöhter --font-scale bleibt der Kopf ohne Überlauf, der FAB überdeckt keine Bedienelemente der untersten Sektion', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const habitId = await seedHabit(page, {
    name: 'AC9 Routine',
    schedule: 'daily',
    color: null,
    archivedAt: null,
  });
  expect(habitId).toBeTruthy();
  await page.evaluate(() => localStorage.setItem('starship:text-scale', '1.25'));
  await page.reload();

  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--font-scale'),
      ),
    )
    .toBe('1.25');

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);

  // Seit issue #920 lebt der Erfassungsknopf nicht mehr in der Titelzeile
  // (der Knopf ist jetzt ein `position: fixed`-FAB) — die Kopfzeile selbst darf
  // dennoch nicht überlaufen (AK5).
  const header = page.locator('.page-head');
  const { scrollHeight, clientHeight } = await header.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(
    scrollHeight,
    `Kopf: scrollHeight ${scrollHeight} vs. clientHeight ${clientHeight}`,
  ).toBeLessThanOrEqual(clientHeight);

  // Der FAB darf keine Bedienelemente der untersten Sektion verdecken — dasselbe
  // Kriterium wie auf /aufgaben (grundfarbe-vollfarbe.spec.ts).
  const fab = captureButton(page);
  await expect(fab).toBeVisible();
  const lastHabitRow = page.locator('.habit-today__item').last();
  await expect(lastHabitRow).toBeVisible();

  const [fabBox, rowBox] = await Promise.all([fab.boundingBox(), lastHabitRow.boundingBox()]);
  expect(fabBox, 'FAB hat eine Bounding-Box').not.toBeNull();
  expect(rowBox, 'letzte Routinen-Zeile hat eine Bounding-Box').not.toBeNull();
  if (fabBox && rowBox) {
    const overlapsVertically = fabBox.y < rowBox.y + rowBox.height && fabBox.y + fabBox.height > rowBox.y;
    const overlapsHorizontally =
      fabBox.x < rowBox.x + rowBox.width && fabBox.x + fabBox.width > rowBox.x;
    expect(
      overlapsVertically && overlapsHorizontally,
      'FAB überlappt die letzte Routinen-Zeile nicht',
    ).toBe(false);
  }
});

test('AK7 (issue #920): der Erfassungs-FAB atmet ohne Reduce-Motion, hält per OS-Präferenz an und bleibt im Dark Mode sichtbar', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/uebersicht');
  await expect(captureButton(page)).toBeVisible();

  const animationName = () =>
    page.evaluate(() => getComputedStyle(document.querySelector('.fab__icon')!).animationName);
  expect(await animationName(), 'atmet ohne Reduce-Motion').toBe('breathe');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  expect(await animationName(), 'hält per OS-Präferenz an').toBe('none');

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' });
  await page.reload();
  await expect(captureButton(page)).toBeVisible();
  await expect(captureButton(page).locator('.fab__label')).toHaveText('Erfassen');
});

test('AC7+AC8 Durchstich: iOS-Satzzeichen und ausgeschriebene Uhrzeit ergeben einen sauberen Titel und das richtige absolute Datum — als Termin in-place angelegt (issue #715 AK3)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const due = expectedDueAt(1, 12, 0);

  await submitUebersichtCapture(page, 'Zahnarzttermin morgen um zwölf.');

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(captureDialog(page)).toBeHidden();
  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.find((entry) => entry.table === 'events');
  expect(created?.payload).toMatchObject({ title: 'Zahnarzttermin', startsAt: due.toISOString() });
});

test('das Titelfeld trägt einen neutralen Platzhalter, keine Art vorweg (issue #650 AK2, #780 E5)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await captureButton(page).click();

  // #780: "Todo Titel" sagte dieselbe vorschnelle Art wie der Art-Chip vor dem
  // ersten Signal — der Platzhalter nennt jetzt alle drei Arten gleichrangig.
  await expect(captureTitleField(page)).toHaveAttribute(
    'placeholder',
    'Aufgabe, Termin, Routine …',
  );
});

/**
 * Mehrfaches Einsprechen führt zusammen (issue #716): der Stand lebt in den Chips
 * statt im Text, jede Äußerung ist eine eigene, vollständige Eingabe. Ein Test je
 * Akzeptanzkriterium, plus der Offline-Pfad — die Testanzahl darf nicht sinken.
 */
async function typeAndCommit(page: Page, text: string) {
  await captureTitleField(page).fill(text);
  await captureTitleField(page).press('Enter');
}

test('AK1: die Eingabezeile leert sich nach der Übernahme, der Stand lebt im Titel-Chip', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await captureButton(page).click();

  await typeAndCommit(page, 'Zahnarzt');

  await expect(captureTitleField(page)).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Titel, Zahnarzt', exact: true })).toBeVisible();
});

test('AK2: eine genannte Fälligkeit überschreibt die vorherige', async ({ page }) => {
  await page.goto('/uebersicht');
  const tomorrow = expectedDueAt(1, 9, 0);
  const dayAfterTomorrow = expectedDueAt(2, 9, 0);

  await captureButton(page).click();
  await typeAndCommit(page, 'Einkaufen');
  await typeAndCommit(page, 'morgen');

  await dueChip(page).click();
  await expectDuePickerValue(page, tomorrow);

  await typeAndCommit(page, 'übermorgen');
  await expectDuePickerValue(page, dayAfterTomorrow);
});

test('AK3: was eine Äußerung nicht nennt, bleibt unangetastet stehen — auch der Titel (Füllwort-Schutz)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await captureButton(page).click();

  await typeAndCommit(page, 'Einkaufen morgen');
  await expect(page.getByRole('button', { name: 'Titel, Einkaufen', exact: true })).toBeVisible();

  await typeAndCommit(page, 'um 15 Uhr');
  await expect(page.getByRole('button', { name: 'Titel, Einkaufen', exact: true })).toBeVisible();
  await dueChip(page).click();
  await expect(dueTimeInput(page)).toHaveValue('15:00');

  await typeAndCommit(page, 'eher');
  await expect(page.getByRole('button', { name: 'Titel, Einkaufen', exact: true })).toBeVisible();
});

test('AK4: ein übernommenes Feld behält seine Konfidenz, bis es erneut genannt wird', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await captureButton(page).click();

  await typeAndCommit(page, 'Zahnarzt morgen');
  await expect(page.getByRole('button', { name: 'Fälligkeit verwerfen' })).toBeVisible();

  await typeAndCommit(page, 'Titel Zahntermin');
  await expect(page.getByRole('button', { name: 'Fälligkeit verwerfen' })).toBeVisible();

  await typeAndCommit(page, 'um 15 Uhr');
  await expect(page.getByRole('button', { name: 'Fälligkeit verwerfen' })).toHaveCount(0);
});

test('AK5: eine Übernahme markiert die geänderten Chips und sagt die Änderung in einem Satz an', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await captureButton(page).click();

  await typeAndCommit(page, 'Einkaufen');
  await typeAndCommit(page, 'morgen um 15 Uhr');

  const dueChipContainer = page
    .locator('.chip')
    .filter({ has: page.getByRole('button', { name: /^Fälligkeit,/ }) });
  await expect(dueChipContainer).toHaveAttribute('data-changed', 'true');
  await expect(page.getByRole('status').filter({ hasText: 'aktualisiert' })).toBeVisible();
});

test('AK6: ein Artwechsel hebt Felder ohne Gegenstück aus der Anzeige und bringt sie beim Zurückwechseln wieder', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await captureButton(page).click();

  await typeAndCommit(page, 'Einkaufen');
  await page.getByRole('button', { name: 'Priorität' }).click();
  await page.getByRole('radio', { name: 'Hoch' }).click();

  // #780: "Einkaufen" trägt kein Art-Signal — der Art-Chip zeigt seinen
  // Leerzustand ("Art"), nicht den sicheren Rückfall "Aufgabe".
  await page.getByRole('button', { name: 'Art', exact: true }).click();
  await page.getByRole('radio', { name: 'Termin' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Priorität entfällt' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Priorität' })).toHaveCount(0);

  // Art-Chip blieb seit Zeile 313 offen (dieselbe Radio-Panel-Semantik wie bei
  // Priorität/Routine: Auswahl schließt das Panel nicht) — ein erneuter Klick
  // auf den Chip-Button würde toggeln und es schließen.
  await expect(page.getByRole('button', { name: 'Art, Termin', exact: true })).toBeVisible();
  await page.getByRole('radio', { name: 'Aufgabe' }).click();

  await expect(page.getByRole('button', { name: 'Priorität, Hoch', exact: true })).toBeVisible();
});

test('Offline (DoD): über zwei Äußerungen erfasst, erreicht online die Datenbank', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const due = expectedDueAt(1, 12, 0);

  await captureButton(page).click();
  // "Termin" alleine trägt schon das Art-Vokabular (local-recognizer.ts) — die
  // zweite Äußerung liefert Titel + Datum + Uhrzeit dazu, ohne die (seit der
  // ersten Übernahme fixe, Entscheidung C des Plans) Art erneut zu bestimmen.
  await typeAndCommit(page, 'Termin');
  await typeAndCommit(page, 'Zahnarzt morgen 12 Uhr');
  await expect(page.getByRole('button', { name: 'Art, Termin', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Anlegen' }).click();

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(captureDialog(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  const row = await withDb((client) =>
    client.query('SELECT starts_at FROM events WHERE title = $1', ['Zahnarzt']),
  );
  expect(row.rowCount).toBe(1);
  expect(new Date(row.rows[0].starts_at as string).getTime()).toBe(due.getTime());
});

/**
 * issue #1083: der Sheet-Kopf log bisher immer "Aufgabe erfassen", auch wenn der
 * Art-Chip längst "Termin" zeigte — und der 09:00-Rückfall einer ungenannten
 * Startzeit stand ungekennzeichnet neben einer wirklich geratenen Zeit.
 */
test('AK1–AK3 (#1083): der Sheet-Kopf folgt der erkannten Art und bleibt neutral, solange sie vorläufig ist', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  // AK2: vor jedem Signal ist die Art `provisional` — der Kopf behauptet keine.
  await captureButton(page).click();
  await expect(page.getByRole('dialog', { name: 'Erfassen', exact: true })).toBeVisible();

  // AK1: "Termin" allein trägt schon das Art-Vokabular (local-recognizer.ts).
  await captureTitleField(page).fill('Termin Arzt');
  await expect(page.getByRole('dialog', { name: 'Termin erfassen', exact: true })).toBeVisible();

  // AK3: der Art-Chip wechselt die Art von Hand — der Kopf zieht mit.
  await page.getByRole('button', { name: 'Art, Termin', exact: true }).click();
  await page.getByRole('radio', { name: 'Aufgabe' }).click();
  await expect(page.getByRole('dialog', { name: 'Aufgabe erfassen', exact: true })).toBeVisible();
});

test('AK4+AK5 (#1083): der 09:00-Rückfall einer ungenannten Startzeit ist geraten, eine sicher gelesene oder selbst gesetzte Zeit nicht', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  // AK4: kein Zeit-Signal -> der Zeit-Chip zeigt den 09:00-Rückfall als geraten.
  await captureButton(page).click();
  await captureTitleField(page).fill('Termin Arzt');
  await expect(page.getByRole('button', { name: 'Zeit verwerfen' })).toBeVisible();

  // AK5: "Verwerfen" übernimmt den Rückfall bewusst — die Startzeit bleibt stehen
  // (ein Termin braucht sie), nur die Geraten-Markierung fällt weg.
  await page.getByRole('button', { name: 'Zeit verwerfen' }).click();
  await expect(page.getByRole('button', { name: 'Zeit verwerfen' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Zeit,/ })).toBeVisible();

  // Sheet schließen, bevor der FAB erneut geöffnet wird — offen bleibend blockiert
  // dessen Klick (das Sheet fängt als Modal alle Zeiger-Events außerhalb ab).
  await page.getByRole('button', { name: 'Abbrechen' }).click();

  // AK5: eine vom Erkenner sicher gelesene Zeit ist von Anfang an ungekennzeichnet.
  await captureButton(page).click();
  await captureTitleField(page).fill('Termin morgen 14 Uhr Zahnarzt');
  await expect(page.getByRole('button', { name: 'Zeit verwerfen' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Zeit,/ })).toBeVisible();
});

/**
 * issue #1089: der Fälligkeits-/Zeit-Chip öffnete bisher ein nacktes
 * `input[type="datetime-local"]` ohne Rahmen/Fläche/Höhe (tote Klasse
 * `quick-add__due`, seit #722 ohne CSS-Regel) — ersetzt durch denselben
 * `DuePicker` wie im Aufgaben-Sheet (quick-add.tsx).
 */
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

test('AK1+AK5 (#1089): der Fälligkeits-Chip einer Aufgabe öffnet den DuePicker (Schnellwahl, Monatskalender, Uhrzeit), kein datetime-local/quick-add__due mehr im DOM', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await captureButton(page).click();
  await captureTitleField(page).fill('Einkaufen');
  await dueChip(page).click();

  await expect(captureDuePicker(page)).toBeVisible();
  await expect(dueQuickSelect(page, 'Heute')).toBeVisible();
  await expect(dueQuickSelect(page, 'Morgen')).toBeVisible();
  await expect(dueQuickSelect(page, 'Nächste Woche')).toBeVisible();
  await expect(captureDuePicker(page).getByRole('button', { name: 'Voriger Monat' })).toBeVisible();
  await expect(captureDuePicker(page).getByRole('button', { name: 'Nächster Monat' })).toBeVisible();
  await expect(dueTimeInput(page)).toBeVisible();
  await expect(captureDialog(page).locator('input[type="datetime-local"]')).toHaveCount(0);
  await expect(captureDialog(page).locator('.quick-add__due')).toHaveCount(0);
});

test('AK2 (#1089): der Zeit-Chip eines Termins öffnet denselben Picker ohne „Kein Datum"-Knopf, die Aufgabe behält ihn', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  // Termin: `startsAt` wird nie leer (`defaultEventStart`-Rückfall) — kein
  // "Kein Datum"-Knopf im Panel.
  await captureButton(page).click();
  await captureTitleField(page).fill('Termin Zahnarzt');
  await zeitChip(page).click();
  await expect(captureDuePicker(page)).toBeVisible();
  await expect(captureDuePicker(page).getByRole('button', { name: 'Kein Datum' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Abbrechen' }).click();

  // Aufgabe: der Knopf bleibt, eine Fälligkeit darf leer sein.
  await captureButton(page).click();
  await captureTitleField(page).fill('Einkaufen morgen');
  await dueChip(page).click();
  await expect(captureDuePicker(page).getByRole('button', { name: 'Kein Datum' })).toBeVisible();
});

test('AK3 (#1089): im Picker gewählter Tag + Uhrzeit stehen am zugeklappten Chip und landen unverändert in der Outbox — Aufgabe (dueAt) und Termin (startsAt), offline geprüft', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  // beforeEach hat die Sync-Endpunkte schon gekappt (AC6/Offline(DoD)-Muster).

  await captureButton(page).click();
  await captureTitleField(page).fill('Wäsche');
  await dueChip(page).click();
  await setDueViaCalendar(page, 'Mittwoch, 22.', '16:15');
  await expect(dueChip(page)).toHaveAccessibleName(
    `Fälligkeit, ${formatDueLabel('2026-07-22T16:15')}`,
  );
  await page.getByRole('button', { name: 'Anlegen' }).click();
  await expect(captureDialog(page)).toBeHidden();

  await captureButton(page).click();
  await captureTitleField(page).fill('Termin Zahnarzt');
  await zeitChip(page).click();
  await setDueViaCalendar(page, 'Donnerstag, 23.', '11:30');
  await expect(zeitChip(page)).toHaveAccessibleName(`Zeit, ${formatDueLabel('2026-07-23T11:30')}`);
  await page.getByRole('button', { name: 'Anlegen' }).click();
  await expect(captureDialog(page)).toBeHidden();

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(2);
  const entries = await page.evaluate(() => window.__starship.pending());
  const task = entries.find((entry) => entry.table === 'tasks');
  const eventEntry = entries.find((entry) => entry.table === 'events');
  expect(task?.payload.dueAt).toBe(new Date('2026-07-22T16:15').toISOString());
  expect(eventEntry?.payload.startsAt).toBe(new Date('2026-07-23T11:30').toISOString());

  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const taskRow = await withDb((client) =>
    client.query('SELECT due_at FROM tasks WHERE title = $1', ['Wäsche']),
  );
  expect(new Date(taskRow.rows[0].due_at as string).toISOString()).toBe(
    new Date('2026-07-22T16:15').toISOString(),
  );
  // local-recognizer.ts (R3): Art-Vokabular bleibt im Titel stehen — "Termin"
  // fällt hier nicht weg wie bei einer separat committeten Äußerung.
  const eventRow = await withDb((client) =>
    client.query('SELECT starts_at FROM events WHERE title = $1', ['Termin Zahnarzt']),
  );
  expect(new Date(eventRow.rows[0].starts_at as string).toISOString()).toBe(
    new Date('2026-07-23T11:30').toISOString(),
  );
});

test('AK4 (#1089): der Picker öffnet auf dem vom Erkenner geratenen Tag (aria-pressed) und eine Auswahl räumt die Geraten-Markierung des Chips weg', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const due = expectedDueAt(1, 9, 0);

  await captureButton(page).click();
  await captureTitleField(page).fill('Einkaufen morgen');
  await expect(page.getByRole('button', { name: 'Fälligkeit verwerfen' })).toBeVisible();

  await dueChip(page).click();
  await expect(selectedDuePickerDay(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(selectedDuePickerDay(page)).toHaveText(String(due.getDate()));

  await dueQuickSelect(page, 'Heute').click();
  await expect(page.getByRole('button', { name: 'Fälligkeit verwerfen' })).toHaveCount(0);
});

test('AK6 (#1089): der Chip zeigt per aria-controls aufs offene Panel, das Panel ist per Tastatur erreichbar — Dark Mode und reduzierte Bewegung wie im Aufgaben-Sheet', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/uebersicht');
  await captureButton(page).click();
  await captureTitleField(page).fill('Einkaufen');

  await expect(dueChip(page)).toHaveAttribute('aria-controls', 'uebersicht-capture-panel-wann');
  await dueChip(page).click();
  await expect(dueChip(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#uebersicht-capture-panel-wann')).toBeVisible();

  const today = dueCalendarDay(page, 'Samstag, 18.');
  // Der vorangegangene dueChip-Klick setzt die Eingabe-Modalität des Dokuments auf
  // Maus — Chromiums :focus-visible bleibt dann auch bei einem script-`.focus()`
  // aus, bis irgendein Tastendruck sie zurück auf Tastatur stellt (deshalb hier ein
  // Tab, unabhängig davon, wo er landet; `.focus()` überschreibt den Fokus danach).
  await page.keyboard.press('Tab');
  await today.focus();
  await expect(today).toHaveCSS('outline-style', 'solid');
  const durationString = await today.evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(parseFloat(durationString)).toBeLessThan(0.001);

  await page.emulateMedia({ colorScheme: 'dark' });
  await today.click();
  await expect(today).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() => today.evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(await resolveColorToken(page, '--accent'));
});
