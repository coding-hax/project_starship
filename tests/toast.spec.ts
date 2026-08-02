import { expect, test, type Locator, type Page } from '@playwright/test';
import { freezeClock, resetAppData } from './helpers';

/** Mirrors use-delete-task.ts's / use-archive-habit.ts's own UNDO_TIMEOUT_MS. */
const UNDO_TIMEOUT_MS = 5000;

test.beforeEach(async () => {
  await resetAppData();
});

async function seedTask(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: p }),
    payload,
  );
}

/** Scoped to the task list — a page-wide listitem query also matches the nav tabs. */
function taskItems(page: Page) {
  return page.getByRole('list', { name: 'Aufgaben' }).getByRole('listitem');
}

/** Mirrors tasks.spec.ts's own gesture helper — drives the real Pointer Events the
 * swipe-to-delete row listens to. */
async function swipeLeft(locator: Locator, distancePx: number) {
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

/** Swipe-left alone tombstones the task and fires the undo toast — no inline
 * confirm step (issue #432). */
async function deleteTaskByTitle(page: Page, title: string) {
  const item = taskItems(page).filter({ hasText: title });
  await swipeLeft(item, 120);
}

/** Mirrors sync.spec.ts AC2 — five failed pushes in a row cross SYNC_ERROR_THRESHOLD
 * and surface the sticky error toast via sync-status.tsx. */
async function triggerSyncErrorToast(page: Page) {
  await page.route('**/api/sync/push', (route) => route.fulfill({ status: 500, body: '{}' }));
  await page.evaluate(() =>
    window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: { title: 'Bleibt hängen' } }),
  );
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.__starship.sync());
  }
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

function toastItems(page: Page) {
  return page.locator('.toast-host .toast');
}

test('AC1/AC2: zwei gleichzeitige Toasts stapeln sich sichtbar über genau einer aria-live-Region', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Wird gelöscht' });

  await triggerSyncErrorToast(page);
  await expect(page.locator('.toast--error')).toBeVisible();

  await deleteTaskByTitle(page, 'Wird gelöscht');
  await expect(page.getByRole('status').filter({ hasText: 'gelöscht' })).toBeVisible();

  // AC2: genau eine aria-live-Region für die Toasts — nicht mehr eine pro
  // Aufrufstelle —, beide hängen als Nachfahren daran. Scoped auf `.toast-host`, nicht
  // `[aria-live]` allein: Next.js' eigener Route-Announcer trägt ebenfalls aria-live
  // und würde die Zählung sonst verfälschen (kein Element dieses Features).
  await expect(page.locator('.toast-host[aria-live]')).toHaveCount(1);
  await expect(page.locator('.toast-host[aria-live] .toast')).toHaveCount(2);

  // AC1: sichtbar gestapelt, die Bounding-Boxen überlappen sich nicht.
  const rects = await toastItems(page).evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    }),
  );
  expect(rects).toHaveLength(2);
  const [a, b] = rects;
  const overlapsVertically = a.top < b.bottom && b.top < a.bottom;
  expect(overlapsVertically).toBe(false);
});

test('AC3: die Fehler-Variante behält role="alert" + --danger, die Bestätigung role="status"', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Wird gelöscht' });

  await triggerSyncErrorToast(page);
  const errorToast = page.locator('.toast--error');
  await expect(errorToast).toHaveAttribute('role', 'alert');
  const errorBorder = await errorToast.evaluate((el) => getComputedStyle(el).borderColor);
  expect(errorBorder).toBe(await resolveColorToken(page, '--danger'));

  // Not getByRole('alert') for the confirmation check — Next's route announcer also
  // carries role="alert" (see sync.spec.ts AC2) and the error toast above is a second
  // one; the confirmation toast is unambiguous via its own role and text instead.
  await deleteTaskByTitle(page, 'Wird gelöscht');
  const confirmationToast = page.getByRole('status').filter({ hasText: 'gelöscht' });
  await expect(confirmationToast).toBeVisible();
});

test('AC4: Rückgängig stellt die gelöschte Zeile wieder her', async ({ page }) => {
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Toast A' });

  await deleteTaskByTitle(page, 'Toast A');
  await expect(taskItems(page).filter({ hasText: 'Toast A' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Rückgängig' }).click();
  await expect(taskItems(page).filter({ hasText: 'Toast A' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeHidden();
});

test('AC4: manuelles Schließen räumt nur die Benachrichtigung ab, nicht die Löschung', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Toast B' });

  await deleteTaskByTitle(page, 'Toast B');
  await expect(page.getByRole('status').filter({ hasText: 'gelöscht' })).toBeVisible();
  await page.getByRole('button', { name: 'Schließen' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'gelöscht' })).toBeHidden();
  await expect(taskItems(page).filter({ hasText: 'Toast B' })).toHaveCount(0);
});

test('AC4: Auto-Dismiss räumt den Toast nach UNDO_TIMEOUT_MS ohne Interaktion ab', async ({
  page,
}) => {
  // Must be installed before the delete — the undo toast's setTimeout(UNDO_TIMEOUT_MS)
  // is registered on whatever clock is active at that moment, so a mock installed
  // afterwards would never intercept it (an earlier version of this test proved that).
  await page.clock.install();
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Toast C' });

  await deleteTaskByTitle(page, 'Toast C');
  await expect(page.getByRole('status').filter({ hasText: 'gelöscht' })).toBeVisible();

  await freezeClock(page);
  await page.clock.fastForward(UNDO_TIMEOUT_MS + 100);
  await expect(page.getByRole('status').filter({ hasText: 'gelöscht' })).toBeHidden();
});

test('AC6: der Toast blendet normal per Slide+Fade ein, bei reduzierter Bewegung nur per Opacity', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Normal' });
  await deleteTaskByTitle(page, 'Normal');
  const normalToast = toastItems(page);
  await expect(normalToast).toBeVisible();
  expect(await normalToast.evaluate((el) => getComputedStyle(el).animationName)).toBe('toast-in');
  await page.getByRole('button', { name: 'Rückgängig' }).click();

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await seedTask(page, { title: 'Reduziert' });
  await deleteTaskByTitle(page, 'Reduziert');
  const reducedToast = toastItems(page);
  await expect(reducedToast).toBeVisible();
  expect(await reducedToast.evaluate((el) => getComputedStyle(el).animationName)).toBe(
    'toast-in-fade',
  );
});

test('AC7: der Toast liegt als Overlay über der Seite, kein Layout-Shift darunter', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Verschieb-Test' });
  const main = page.locator('main.shell__main');
  const before = await main.boundingBox();

  await deleteTaskByTitle(page, 'Verschieb-Test');
  await expect(page.getByRole('status').filter({ hasText: 'gelöscht' })).toBeVisible();

  const after = await main.boundingBox();
  expect(after).toEqual(before);
});

test('AC8: der Toast bleibt im Viewport, überlappt die Nav nicht — 375px und 1280px', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Viewport-Test' });
  await deleteTaskByTitle(page, 'Viewport-Test');

  const toast = toastItems(page);
  await expect(toast).toBeVisible();

  const viewport = page.viewportSize();
  if (!viewport) throw new Error('AC8: missing viewport size');
  const box = await toast.boundingBox();
  if (!box) throw new Error('AC8: toast has no bounding box');

  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);

  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  const navBox = await nav.boundingBox();
  if (navBox) {
    const overlapsNav =
      box.x < navBox.x + navBox.width &&
      navBox.x < box.x + box.width &&
      box.y < navBox.y + navBox.height &&
      navBox.y < box.y + box.height;
    expect(overlapsNav).toBe(false);
  }
});

test('AC8: Dark Mode ändert die Toast-Farbe über den Surface-Token, kein Rohwert', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Dark-Test' });
  await deleteTaskByTitle(page, 'Dark-Test');
  const toast = page.getByRole('status').filter({ hasText: 'gelöscht' });
  await expect(toast).toBeVisible();
  const lightBg = await toast.evaluate((el) => getComputedStyle(el).backgroundColor);

  // Not combined with reducedMotion here (unlike the AC6 test above): flipping
  // reduced-motion at the same time switches this element's own `animation-name`
  // (toast-in -> toast-in-fade), and reading `backgroundColor` in the same tick as
  // that restart intermittently observes a stale pre-recalc value in Chromium. AC6
  // already covers the reduced-motion branch on its own; this test is scoped to the
  // colour token alone, like reminder-prefs.spec.ts's "nutzt den --surface-Token".
  await page.emulateMedia({ colorScheme: 'dark' });
  const darkBg = await toast.evaluate((el) => getComputedStyle(el).backgroundColor);

  expect(darkBg).not.toBe(lightBg);
  expect(darkBg).toBe(await resolveColorToken(page, '--surface-raised'));
});
