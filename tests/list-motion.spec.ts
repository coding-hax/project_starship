import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData } from './helpers';

/**
 * Enter/exit for the three lists (issue #430, #418 decision A: CSS-only).
 * `use-list-presence.ts` + `motion.css`'s `list-motion-item` are the shared
 * mechanism across tasks/habits/journal — the per-list tests below prove the
 * wiring in each feature; the keyframe-property test proves the "only
 * transform/opacity, never height/top/margin" contract once, for the CSS
 * itself, rather than three times over for a mechanism that isn't per-list.
 */

async function seedTask(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: p }),
    payload,
  );
}

async function seedHabit(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'habits', op: 'upsert', payload: p }),
    payload,
  );
}

function taskItems(page: Page) {
  return page.getByRole('list', { name: 'Aufgaben' }).getByRole('listitem');
}

function habitItems(page: Page) {
  return page.getByRole('list', { name: 'Gewohnheiten', exact: true }).getByRole('listitem');
}

async function swipeLeft(locator: ReturnType<typeof taskItems>, distancePx: number) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('swipeLeft: target has no bounding box');
  const clientY = box.y + box.height / 2;
  const startX = box.x + box.width - 20;
  await locator.dispatchEvent('pointerdown', {
    pointerId: 1,
    clientX: startX,
    clientY,
    button: 0,
    bubbles: true,
  });
  await locator.dispatchEvent('pointermove', {
    pointerId: 1,
    clientX: startX - distancePx,
    clientY,
    bubbles: true,
  });
  await locator.dispatchEvent('pointerup', {
    pointerId: 1,
    clientX: startX - distancePx,
    clientY,
    bubbles: true,
  });
}

const EDITOR_PASSPHRASE = 'list motion editor passphrase';

/** Mirrors journal.spec.ts's own setUpEditor. */
async function setUpEditor(page: Page): Promise<void> {
  await registerPasskey(page);
  await page.goto('/journal');
  await page.getByLabel('Passphrase', { exact: true }).fill(EDITOR_PASSPHRASE);
  await page.getByLabel('Passphrase wiederholen').fill(EDITOR_PASSPHRASE);
  await page.getByRole('button', { name: 'Einrichten' }).click();
  await page.getByTestId('journal-recovery-key').waitFor();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();
}

async function submitJournalEntry(page: Page, text: string): Promise<void> {
  await page.getByLabel('Journal-Text').fill(text);
  await page.getByRole('button', { name: 'Absenden' }).click();
}

function journalEntries(page: Page) {
  return page.locator('.journal-editor__entry');
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // The lists must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
});

/* -------------------------------------------------------------------------- */
/* Aufgaben                                                                    */
/* -------------------------------------------------------------------------- */

test.describe('Aufgaben', () => {
  test.beforeEach(async ({ page }) => {
    await registerPasskey(page);
  });

  test('AC1: ein neu angelegtes Element blendet ein, das vorhandene nicht', async ({ page }) => {
    await page.goto('/aufgaben');
    await seedTask(page, { title: 'Bestehende Aufgabe' });
    await expect(taskItems(page)).toHaveCount(1);
    const existing = taskItems(page).filter({ hasText: 'Bestehende Aufgabe' });
    await expect(existing).toHaveAttribute('data-entering', 'false');

    await seedTask(page, { title: 'Neue Aufgabe' });
    const created = taskItems(page).filter({ hasText: 'Neue Aufgabe' });
    await expect(created).toHaveAttribute('data-entering', 'true');
    expect(await created.evaluate((el) => getComputedStyle(el).animationName)).toBe('list-enter');

    // The pre-existing row must never join the enter animation (DESIGN_SYSTEM.md:
    // motion must not nag on every use, only on an actual creation).
    await expect(existing).toHaveAttribute('data-entering', 'false');
  });

  test('AC2: ein gelöschtes Element blendet aus, bevor es aus dem DOM verschwindet', async ({
    page,
  }) => {
    await page.goto('/aufgaben');
    await seedTask(page, { title: 'Wird gelöscht' });
    const item = taskItems(page).filter({ hasText: 'Wird gelöscht' });
    await expect(item).toHaveAttribute('data-entering', 'false');

    await swipeLeft(item, 120);
    await page.getByRole('button', { name: 'Löschen' }).click();

    await expect(item).toHaveAttribute('data-leaving', 'true');
    expect(await item.evaluate((el) => getComputedStyle(el).animationName)).toBe('list-exit');
    await expect(item).toHaveCount(0);
  });

  test('AC4: kein Layout-Shift — eine bestehende Zeile bleibt stehen, wenn darunter eine neue erscheint', async ({
    page,
  }) => {
    await page.goto('/aufgaben');
    await seedTask(page, { title: 'Item A' });
    const itemA = taskItems(page).filter({ hasText: 'Item A' });
    await expect(itemA).toBeVisible();
    const before = await itemA.boundingBox();

    await seedTask(page, { title: 'Item B' });
    await expect(taskItems(page)).toHaveCount(2);
    const after = await itemA.boundingBox();

    expect(after).toEqual(before);
  });
});

/* -------------------------------------------------------------------------- */
/* Gewohnheiten                                                                */
/* -------------------------------------------------------------------------- */

test.describe('Gewohnheiten', () => {
  test.beforeEach(async ({ page }) => {
    await registerPasskey(page);
  });

  test('AC1: eine neu angelegte Gewohnheit blendet ein, die vorhandene nicht', async ({ page }) => {
    await page.goto('/gewohnheiten');
    await seedHabit(page, { name: 'Joggen', schedule: 'daily', color: null, archivedAt: null });
    await expect(habitItems(page)).toHaveCount(1);
    const existing = habitItems(page).filter({ hasText: 'Joggen' });
    await expect(existing).toHaveAttribute('data-entering', 'false');

    await seedHabit(page, { name: 'Lesen', schedule: 'daily', color: null, archivedAt: null });
    const created = habitItems(page).filter({ hasText: 'Lesen' });
    await expect(created).toHaveAttribute('data-entering', 'true');
    expect(await created.evaluate((el) => getComputedStyle(el).animationName)).toBe('list-enter');
    await expect(existing).toHaveAttribute('data-entering', 'false');
  });

  test('AC2: Archivieren blendet die Zeile aus der aktiven Liste aus, bevor sie verschwindet', async ({
    page,
  }) => {
    await page.goto('/gewohnheiten');
    await seedHabit(page, { name: 'Tagebuch', schedule: 'daily', color: null, archivedAt: null });
    const item = habitItems(page).filter({ hasText: 'Tagebuch' });
    await expect(item).toHaveAttribute('data-entering', 'false');

    await item.getByRole('button', { name: 'Archivieren', exact: true }).click();

    await expect(item).toHaveAttribute('data-leaving', 'true');
    expect(await item.evaluate((el) => getComputedStyle(el).animationName)).toBe('list-exit');
    await expect(item).toHaveCount(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Journal                                                                     */
/* -------------------------------------------------------------------------- */

test.describe('Journal', () => {
  test('AC1: ein neu abgesendeter Eintrag blendet ein, der vorhandene nicht', async ({ page }) => {
    await setUpEditor(page);
    await submitJournalEntry(page, 'Erster Eintrag');
    await expect(journalEntries(page)).toHaveCount(1);
    const existing = journalEntries(page).filter({ hasText: 'Erster Eintrag' });
    await expect(existing).toHaveAttribute('data-entering', 'false');

    await submitJournalEntry(page, 'Zweiter Eintrag');
    const created = journalEntries(page).filter({ hasText: 'Zweiter Eintrag' });
    await expect(created).toHaveAttribute('data-entering', 'true');
    expect(await created.evaluate((el) => getComputedStyle(el).animationName)).toBe('list-enter');
    await expect(existing).toHaveAttribute('data-entering', 'false');
  });

  test('AC2: ein gelöschter Eintrag blendet aus, bevor er aus dem DOM verschwindet', async ({
    page,
  }) => {
    await setUpEditor(page);
    await submitJournalEntry(page, 'Wird gelöscht');
    const entry = journalEntries(page).filter({ hasText: 'Wird gelöscht' });
    await expect(entry).toHaveAttribute('data-entering', 'false');

    await entry.getByRole('button', { name: 'Eintrag löschen' }).click();

    await expect(entry).toHaveAttribute('data-leaving', 'true');
    expect(await entry.evaluate((el) => getComputedStyle(el).animationName)).toBe('list-exit');
    await expect(entry).toHaveCount(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Gemeinsamer Mechanismus — motion.css                                       */
/* -------------------------------------------------------------------------- */

/** Reads the actual CSS keyframe rule rather than trusting the source file —
 * proves "only transform/opacity, never height/top/margin" for real, once for
 * the mechanism all three lists share (AC4). */
async function keyframeProperties(page: Page, name: string): Promise<string[]> {
  return page.evaluate((keyframeName) => {
    const props = new Set<string>();
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSKeyframesRule && rule.name === keyframeName) {
          for (const keyframe of Array.from(rule.cssRules)) {
            const style = (keyframe as CSSKeyframeRule).style;
            for (let i = 0; i < style.length; i++) props.add(style.item(i));
          }
        }
      }
    }
    return Array.from(props);
  }, name);
}

test('AC4: die Enter/Exit-Keyframes fassen nur transform/opacity an, nie height/top/margin', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/aufgaben');

  for (const name of ['list-enter', 'list-exit']) {
    const props = await keyframeProperties(page, name);
    expect(props.sort()).toEqual(['opacity', 'transform']);
  }
  for (const name of ['list-enter-fade', 'list-exit-fade']) {
    const props = await keyframeProperties(page, name);
    expect(props).toEqual(['opacity']);
  }
});

/**
 * A detached probe element instead of a real seeded/deleted row — under
 * reduced motion, `tokens.css` zeroes every `animation-duration` to 0.01ms
 * (issue #430's own global rule, not something this ticket can loosen), so a
 * real row's `entering`/`leaving` window closes before an assertion could
 * reliably observe it mid-flight. Setting the attribute directly and reading
 * `getComputedStyle` in the same script proves the exact same selector/rule
 * the real rows use, without racing our own `onAnimationEnd` cleanup.
 */
async function computedAnimationNameFor(page: Page, attribute: string): Promise<string> {
  return page.evaluate((attr) => {
    const el = document.createElement('li');
    el.className = 'list-motion-item';
    el.setAttribute(attr, 'true');
    document.body.appendChild(el);
    const name = getComputedStyle(el).animationName;
    el.remove();
    return name;
  }, attribute);
}

test('AC3: prefers-reduced-motion schwenkt auf die Fade-Varianten (nur Opacity, kein transform)', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/aufgaben');

  expect(await computedAnimationNameFor(page, 'data-entering')).toBe('list-enter');
  expect(await computedAnimationNameFor(page, 'data-leaving')).toBe('list-exit');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await computedAnimationNameFor(page, 'data-entering')).toBe('list-enter-fade');
  expect(await computedAnimationNameFor(page, 'data-leaving')).toBe('list-exit-fade');
});

/* -------------------------------------------------------------------------- */
/* 375px / 1280px, Dark Mode                                                   */
/* -------------------------------------------------------------------------- */

for (const viewport of [
  { width: 375, height: 667 },
  { width: 1280, height: 1024 },
]) {
  test(`AC5: Enter/Exit funktionieren bei ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await registerPasskey(page);
    await page.goto('/aufgaben');
    await seedTask(page, { title: 'Baseline' });
    await expect(taskItems(page)).toHaveCount(1);

    await seedTask(page, { title: `Neu ${viewport.width}` });
    const created = taskItems(page).filter({ hasText: `Neu ${viewport.width}` });
    expect(await created.evaluate((el) => getComputedStyle(el).animationName)).toBe('list-enter');

    await swipeLeft(created, 120);
    await page.getByRole('button', { name: 'Löschen' }).click();
    await expect(created).toHaveAttribute('data-leaving', 'true');
    await expect(created).toHaveCount(0);
  });
}

test('AC5: Dark Mode — die Enter-Animation läuft unverändert (reines Motion, farbunabhängig)', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Baseline' });
  await expect(taskItems(page)).toHaveCount(1);

  await seedTask(page, { title: 'Dunkel' });
  const created = taskItems(page).filter({ hasText: 'Dunkel' });
  await expect(created).toHaveAttribute('data-entering', 'true');
  expect(await created.evaluate((el) => getComputedStyle(el).animationName)).toBe('list-enter');
});
