import { expect, test, type Page } from '@playwright/test';
import { FIXED_NOW, installClockAt, registerPasskey, resetAppData } from './helpers';

const CAPTURE_LABEL = 'Aufgabe erfassen';

function captureButton(page: Page) {
  return page.getByRole('button', { name: CAPTURE_LABEL });
}

function captureDialog(page: Page) {
  return page.getByRole('dialog', { name: CAPTURE_LABEL });
}

function captureTitleField(page: Page) {
  return page.getByRole('textbox', { name: 'Titel der Aufgabe' });
}

function artChip(page: Page, label: string) {
  return page.getByRole('button', { name: `Art, ${label}` });
}

/** #780 AK1: solange keine Art erkannt ist, trägt der Chip kein Wert-Suffix mehr —
 * `exact: true`, sonst matcht "Art" auch als Substring von "Art, Aufgabe" etc. */
function artChipEmpty(page: Page) {
  return page.getByRole('button', { name: 'Art', exact: true });
}

/** `exact: true` matters here: "Routine" (unset) is otherwise a substring
 * match of the Art-Chip's own "Art, Routine". */
function routineChip(page: Page, label?: string) {
  return page.getByRole('button', { name: label ? `Routine, ${label}` : 'Routine', exact: true });
}

async function seedHabit(page: Page, name: string): Promise<void> {
  await page.evaluate(
    (habitName) =>
      window.__starship.mutate({
        table: 'habits',
        op: 'upsert',
        payload: { name: habitName, schedule: 'daily', color: null, archivedAt: null },
      }),
    name,
  );
}

async function submitCapture(page: Page, text: string) {
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

/** Renders `var(--area-*)` on a throwaway element to read its resolved color —
 * the same value the sheet's accent-driven surfaces (action button, chips)
 * resolve to once `--accent` points at that area token (issue #715 AK2). */
async function resolvedAreaColor(
  page: Page,
  areaVar: '--area-tasks' | '--area-events' | '--area-habits',
): Promise<string> {
  return page.evaluate((varName) => {
    const probe = document.createElement('div');
    probe.style.color = `var(${varName})`;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, areaVar);
}

/** `dialog[open]` matters since issue #715 P4: `/uebersicht` now also mounts a
 * (usually closed) `TaskEditor`/`EventEditor`, each with their own
 * `.sheet__action` in the DOM regardless of `open` — a bare class locator
 * would match all of them. */
function sheetActionButton(page: Page) {
  return page.locator('dialog[open] .sheet__action');
}

async function actionButtonBackground(page: Page): Promise<string> {
  return sheetActionButton(page).evaluate((el) => getComputedStyle(el).backgroundColor);
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // Kein Absenden in dieser Suite — trotzdem abgesperrt, damit ein versehentlicher
  // Fetch (CLAUDE.md Regel 8) sofort auffiele statt still durchzulaufen.
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await installClockAt(page);
  await registerPasskey(page);
});

test('AK1: der Art-Chip zeigt die erkannte Art, bevor angelegt wird', async ({ page }) => {
  await page.goto('/uebersicht');
  await captureButton(page).click();

  // #780: leeres Feld -> der Art-Chip zeigt seinen Leerzustand ("Art?"), nicht den
  // sicheren Rückfall "Aufgabe" — der ist erst mit "Anlegen" eine echte Entscheidung.
  await expect(artChipEmpty(page)).toBeVisible();

  await captureTitleField(page).fill('morgen 12 Uhr Zahnarzt');
  await expect(artChip(page, 'Termin')).toBeVisible();
});

test('#780 AK2: leeres Feld, nie berührt -> "Anlegen" legt trotzdem eine Aufgabe an', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  await captureButton(page).click();
  await expect(artChipEmpty(page)).toBeVisible();
  await captureTitleField(page).fill('Wäsche waschen');
  // Kein Datum/Vokabular-Signal -> der Art-Chip bleibt beim Leerzustand, auch nach
  // dem Tippen (der sichere Rückfall wird nie als vermeintliches Ergebnis gezeigt).
  await expect(artChipEmpty(page)).toBeVisible();

  await page.getByRole('button', { name: 'Anlegen' }).click();

  await expect(captureDialog(page)).toBeHidden();
  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.find((entry) => entry.table === 'tasks');
  expect(created?.payload).toMatchObject({ title: 'Wäsche waschen' });
});

test('AK1: Antippen des Art-Chips wechselt die Art von Hand', async ({ page }) => {
  await page.goto('/uebersicht');
  await captureButton(page).click();
  await captureTitleField(page).fill('morgen 12 Uhr Zahnarzt');
  await expect(artChip(page, 'Termin')).toBeVisible();

  await artChip(page, 'Termin').click();
  await page.getByRole('radio', { name: 'Aufgabe' }).click();

  await expect(artChip(page, 'Aufgabe')).toBeVisible();
});

test('AK2: der Akzent des Sheets folgt der erkannten Art', async ({ page }) => {
  await page.goto('/uebersicht');
  const taskColor = await resolvedAreaColor(page, '--area-tasks');
  const eventColor = await resolvedAreaColor(page, '--area-events');
  expect(taskColor).not.toBe(eventColor);

  await captureButton(page).click();
  await expect(sheetActionButton(page)).toBeVisible();
  // #780 E4: solange keine Art erkannt ist, bleibt der Akzent neutral — nicht der
  // Aufgaben-Akzent, der sonst "Aufgabe" flüstert, bevor irgendetwas entschieden ist.
  const initialColor = await actionButtonBackground(page);
  expect(initialColor).not.toBe(taskColor);
  expect(initialColor).not.toBe(eventColor);

  await captureTitleField(page).fill('morgen 12 Uhr Zahnarzt');
  await expect.poll(() => actionButtonBackground(page)).toBe(eventColor);

  await artChip(page, 'Termin').click();
  await page.getByRole('radio', { name: 'Aufgabe' }).click();
  await expect.poll(() => actionButtonBackground(page)).toBe(taskColor);
});

test('AK1: die Routine "hake Sport ab" zeigt den Art-Chip "Routine"', async ({ page }) => {
  await page.goto('/uebersicht');
  await page.evaluate(() =>
    window.__starship.mutate({
      table: 'habits',
      op: 'upsert',
      payload: { name: 'Sport', schedule: 'daily', color: null, archivedAt: null },
    }),
  );
  await page.goto('/uebersicht');
  await captureButton(page).click();

  await captureTitleField(page).fill('hake Sport ab');

  await expect(artChip(page, 'Routine')).toBeVisible();
});

test('AK3: "Wäsche waschen" legt die Aufgabe in-place an, kein Navigieren', async ({ page }) => {
  await page.goto('/uebersicht');

  await submitCapture(page, 'Wäsche waschen');

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(captureDialog(page)).toBeHidden();
  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.find((entry) => entry.table === 'tasks');
  expect(created?.payload).toMatchObject({ title: 'Wäsche waschen' });
});

test('AK3: "morgen 12 Uhr Zahnarzt" legt den Termin in-place an, kein Navigieren', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const due = expectedDueAt(1, 12, 0);

  await submitCapture(page, 'morgen 12 Uhr Zahnarzt');

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(captureDialog(page)).toBeHidden();
  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.filter((entry) => entry.table === 'events');
  expect(created).toHaveLength(1);
  expect(created[0].payload).toMatchObject({
    title: 'Zahnarzt',
    allDay: false,
    startsAt: due.toISOString(),
  });
  expect(new Date(created[0].payload.endsAt as string).getTime() - due.getTime()).toBe(
    60 * 60 * 1000,
  );
});

test('AK4-Kernfeld: ohne erkannte Uhrzeit bekommt der Termin 09:00 des heutigen Tages als Von', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  await submitCapture(page, 'Meeting mit Chef');

  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.find((entry) => entry.table === 'events');
  expect(created?.payload).toMatchObject({ title: 'Meeting mit Chef', allDay: false });
  const startsAt = new Date(created?.payload.startsAt as string);
  expect(startsAt.getHours()).toBe(9);
  expect(startsAt.getMinutes()).toBe(0);
});

test('AK4-Kernfeld: die Priorität-Chip-Auswahl übernimmt in die angelegte Aufgabe', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await captureButton(page).click();
  await captureTitleField(page).fill('Müll rausbringen');

  await page.getByRole('button', { name: 'Priorität' }).click();
  await page.getByRole('radio', { name: 'Hoch' }).click();
  await page.getByRole('button', { name: 'Anlegen' }).click();

  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.find((entry) => entry.table === 'tasks');
  expect(created?.payload).toMatchObject({ title: 'Müll rausbringen', priority: 1 });
});

test('AK5: eindeutiger Habit-Treffer zeigt den Routine-Chip vorbelegt, Anlegen hakt direkt ab', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedHabit(page, 'Sport');
  await page.goto('/uebersicht');

  await captureButton(page).click();
  await captureTitleField(page).fill('hake Sport ab');
  await expect(routineChip(page, 'Sport')).toBeVisible();

  await page.getByRole('button', { name: 'Anlegen' }).click();

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(captureDialog(page)).toBeHidden();
  // Kein Toast mehr, der das Abhaken bestätigt (issue #797) — der Checkbox-Zustand
  // selbst ist der Beleg.
  await expect(page.getByRole('checkbox', { name: 'Sport für heute abhaken' })).toBeChecked();
});

test('AK5: mehrdeutiger Habit-Treffer zeigt „Keiner Gewohnheit zugeordnet" mit Auswahl statt still zu navigieren', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedHabit(page, 'Yoga');
  await seedHabit(page, 'Lauf');
  await page.goto('/uebersicht');

  await captureButton(page).click();
  await captureTitleField(page).fill('hake Yoga Lauf ab');
  await expect(artChip(page, 'Routine')).toBeVisible();
  await expect(routineChip(page)).toBeVisible();

  // Ohne Wahl legt "Anlegen" nichts an — die Auswahl öffnet sich stattdessen.
  await page.getByRole('button', { name: 'Anlegen' }).click();
  await expect(captureDialog(page)).toBeVisible();
  // issue #758: exact:true, sonst matcht auch der neue "Neue Routine anlegen: …"-
  // Zweig, dessen Label den getippten Text (und damit "Yoga") als Teilstring enthält.
  await page.getByRole('radio', { name: 'Yoga', exact: true }).click();
  await expect(routineChip(page, 'Yoga')).toBeVisible();

  await page.getByRole('button', { name: 'Anlegen' }).click();
  await expect(captureDialog(page)).toBeHidden();
  await expect(page.getByRole('checkbox', { name: 'Yoga für heute abhaken' })).toBeChecked();
});

// issue #758 AK1 löst die alte Sperre ab: ohne wählbare Gewohnheit führte "Routine"
// früher in eine Sackgasse (deshalb gesperrt) — seit #758 bietet die Routine-Auswahl
// in diesem Fall den "Neue Routine anlegen"-Zweig, die Art ist deshalb wählbar.
test('AK5/#758 AK1: auch ohne wählbare Gewohnheit ist die Art-Option „Routine" wählbar', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  await captureButton(page).click();
  await artChipEmpty(page).click();

  await expect(page.getByRole('radio', { name: 'Routine' })).toBeEnabled();
});

test('AK4: "Mehr" bei Aufgabe öffnet das volle Modul-Sheet mit übernommenen Kernwerten, kein Seitenwechsel', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await captureButton(page).click();
  await captureTitleField(page).fill('Wäsche waschen morgen');
  await page.getByRole('button', { name: 'Priorität' }).click();
  await page.getByRole('radio', { name: 'Hoch' }).click();

  await page.getByRole('button', { name: 'Mehr' }).click();

  await expect(captureDialog(page)).toBeHidden();
  await expect(page).toHaveURL(/\/uebersicht$/);
  const dialog = page.getByRole('dialog', { name: 'Neue Aufgabe' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Titel')).toHaveValue('Wäsche waschen');
  await expect(dialog.getByRole('radio', { name: 'Hoch' })).toBeChecked();
  await expect(dialog.getByLabel('Notiz')).toBeVisible();
  await expect(dialog.getByLabel('Unteraufgabe von')).toBeVisible();

  await dialog.getByLabel('Notiz').fill('Extra Notiz');
  await dialog.getByRole('button', { name: 'Anlegen' }).click();

  await expect(dialog).toBeHidden();
  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.find((entry) => entry.table === 'tasks');
  expect(created?.payload).toMatchObject({
    title: 'Wäsche waschen',
    priority: 1,
    notes: 'Extra Notiz',
  });
});

test('AK4: "Mehr" bei Termin öffnet das volle Modul-Sheet mit übernommenen Kernwerten, kein Seitenwechsel', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const due = expectedDueAt(1, 12, 0);
  await captureButton(page).click();
  await captureTitleField(page).fill('morgen 12 Uhr Zahnarzt');
  await page.getByRole('button', { name: 'Kategorie' }).click();
  // Nicht `getByLabel('Kategorie')`: das immer gemountete (meist geschlossene)
  // `EventEditor` trägt sein eigenes gleichnamiges Feld unabhängig von `open`
  // im DOM — `getByLabel` filtert das anders als `getByRole` nicht heraus.
  await page.locator('#uebersicht-capture-panel-kategorie').selectOption('gesundheit');

  await page.getByRole('button', { name: 'Mehr' }).click();

  await expect(captureDialog(page)).toBeHidden();
  await expect(page).toHaveURL(/\/uebersicht$/);
  const dialog = page.getByRole('dialog', { name: 'Termin erfassen' });
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
