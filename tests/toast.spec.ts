import { expect, test, type Locator, type Page } from '@playwright/test';
import { resetAppData, selectView } from './helpers';

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

/** Swipe-left alone tombstones the task, sofort und ohne Rückgängig-Popup
 * (issue #432, #797). */
async function deleteTaskByTitle(page: Page, title: string) {
  const item = taskItems(page).filter({ hasText: title });
  await swipeLeft(item, 120);
}

/** Mirrors sync.spec.ts AC2 — five failed pushes in a row cross SYNC_ERROR_THRESHOLD
 * and surface the sticky error toast via sync-status.tsx. Seit #797 der einzige
 * verbleibende Toast im Produkt. */
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

test('AC2: der Fehler-Toast hängt in genau einer aria-live-Region', async ({ page }) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');

  await triggerSyncErrorToast(page);
  await expect(page.locator('.toast--error')).toBeVisible();

  // Scoped auf `.toast-host`, nicht `[aria-live]` allein: Next.js' eigener
  // Route-Announcer trägt ebenfalls aria-live und würde die Zählung sonst
  // verfälschen (kein Element dieses Features).
  await expect(page.locator('.toast-host[aria-live]')).toHaveCount(1);
  await expect(page.locator('.toast-host[aria-live] .toast')).toHaveCount(1);
});

test('AC3: der Fehler-Toast trägt role="alert" und die --danger-Randfarbe', async ({ page }) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');

  await triggerSyncErrorToast(page);
  const errorToast = page.locator('.toast--error');
  await expect(errorToast).toHaveAttribute('role', 'alert');
  const errorBorder = await errorToast.evaluate((el) => getComputedStyle(el).borderColor);
  expect(errorBorder).toBe(await resolveColorToken(page, '--danger'));
});

test('AC4: nach dem Löschen erscheint kein Rückgängig-Popup, die Zeile bleibt gelöscht', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await seedTask(page, { title: 'Toast A' });

  await deleteTaskByTitle(page, 'Toast A');
  await expect(taskItems(page).filter({ hasText: 'Toast A' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeHidden();
});

test('AC4: manuelles Schließen räumt nur die Anzeige ab, der Sync-Fehler bleibt in der Outbox', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');

  await triggerSyncErrorToast(page);
  await expect(page.locator('.toast--error')).toBeVisible();
  await page.getByRole('button', { name: 'Schließen' }).click();
  await expect(page.locator('.toast--error')).toBeHidden();

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBeGreaterThan(0);
});

test('AC4: der Fehler-Toast verschwindet automatisch, sobald der Sync-Fehler behoben ist', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');

  await triggerSyncErrorToast(page);
  await expect(page.locator('.toast--error')).toBeVisible();

  // Kein Klick auf „Schließen" — sync-status.tsx räumt sich selbst ab, sobald
  // `overSyncErrorThreshold` wieder falsch wird (die einzige verbliebene Form
  // von „automatisch abräumen", seit der zeitgesteuerte Undo-Toast weg ist).
  await page.unroute('**/api/sync/push');
  await page.evaluate(() => window.__starship.sync());

  await expect(page.locator('.toast--error')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
});

test('AC6: der Toast blendet normal per Slide+Fade ein, bei reduzierter Bewegung nur per Opacity', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');

  await triggerSyncErrorToast(page);
  const normalToast = toastItems(page);
  await expect(normalToast).toBeVisible();
  expect(await normalToast.evaluate((el) => getComputedStyle(el).animationName)).toBe('toast-in');

  // Resolve the error first, not just dismiss it — sync-status.tsx only clears its
  // own `dismissed` flag on a fresh rising edge (`over && !wasOverRef.current`), so
  // a second trigger needs a real fall-below-threshold in between to remount the
  // Toast and observe its animation from a clean start, same as the original two
  // independent undo toasts did.
  await page.unroute('**/api/sync/push');
  await page.evaluate(() => window.__starship.sync());
  await expect(page.locator('.toast--error')).toBeHidden();

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await triggerSyncErrorToast(page);
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
  await selectView(page, 'Alle');
  const main = page.locator('main.shell__main');
  const before = await main.boundingBox();

  await triggerSyncErrorToast(page);
  await expect(page.locator('.toast--error')).toBeVisible();

  const after = await main.boundingBox();
  expect(after).toEqual(before);
});

test('AC8: der Toast bleibt im Viewport, überlappt die Nav nicht — 375px und 1280px', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');
  await triggerSyncErrorToast(page);

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
  await selectView(page, 'Alle');
  await triggerSyncErrorToast(page);
  const toast = page.locator('.toast--error');
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
