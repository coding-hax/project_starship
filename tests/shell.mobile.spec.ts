import { expect, test } from '@playwright/test';
import { registerPasskey, resetDatabase } from './helpers';

/**
 * Shell assertions that only hold in the mobile layout.
 *
 * Playwright routes this file to the `mobile` project alone (playwright.config.ts),
 * which is the framework's own mechanism for viewport-scoped specs. The alternative —
 * keeping one shared file and bailing out at runtime when the project name does not
 * match — is a runtime skip, and `test-integrity` rejects those on sight: it cannot
 * tell a scoped test apart from a disabled one, and that bluntness is the point
 * (CLAUDE.md Regel 5).
 *
 * The desktop counterparts live in shell.desktop.spec.ts. Anything true in *both*
 * layouts belongs in shell.spec.ts, which keeps running in both projects.
 */

// Drives the auth UI itself and asserts the never-registered state, so it opts out of
// the shared owner session and keeps the full reset (#115).
test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(async () => {
  await resetDatabase();
});

test('the settings entry point sits inline on Heute and on none of the other four screens (issue #126 AC1+AC2)', async ({
  page,
}) => {
  await registerPasskey(page);

  const heuteSettings = page.getByRole('link', { name: 'Einstellungen' });
  await expect(heuteSettings).toBeVisible();

  for (const path of ['/aufgaben', '/gewohnheiten', '/kalender', '/journal']) {
    await page.goto(path);
    await expect(page.getByRole('link', { name: 'Einstellungen' })).toHaveCount(0);
  }
});

test('/heute rückt näher an die Statusleiste heran, ohne unter sie zu rutschen (issue #137 AC3+AC4)', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/heute');

  const main = page.locator('main.shell__main');
  const paddingTop = await main.evaluate((el) => getComputedStyle(el).paddingTop);
  // var(--space-4) + env(safe-area-inset-top); the test browser has no notch, so the
  // inset resolves to 0 and the computed value is the bare token.
  expect(paddingTop).toBe('16px');
});

test('das Einstellungen-Symbol auf /heute steht auf einer Linie mit "Heute", rechtsbündig, mit vollem Touch-Ziel (issue #137 AC5)', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/heute');

  const heading = page.getByRole('heading', { name: 'Heute', level: 1 });
  const settings = page.getByRole('link', { name: 'Einstellungen' });
  const main = page.locator('main.shell__main');
  const [headingBox, settingsBox, mainBox, mainPaddingRight] = await Promise.all([
    heading.boundingBox(),
    settings.boundingBox(),
    main.boundingBox(),
    main.evaluate((el) => parseFloat(getComputedStyle(el).paddingRight)),
  ]);
  expect(headingBox).not.toBeNull();
  expect(settingsBox).not.toBeNull();
  expect(mainBox).not.toBeNull();

  const headingCenter = headingBox!.y + headingBox!.height / 2;
  const settingsCenter = settingsBox!.y + settingsBox!.height / 2;
  expect(Math.abs(headingCenter - settingsCenter)).toBeLessThan(2);

  // main's own box includes its padding, so the content column's right edge —
  // where "right-aligned" content actually sits — is inset by padding-right.
  const contentRightEdge = mainBox!.x + mainBox!.width - mainPaddingRight;
  expect(Math.abs(settingsBox!.x + settingsBox!.width - contentRightEdge)).toBeLessThan(2);
  expect(settingsBox!.width).toBeGreaterThanOrEqual(44);
  expect(settingsBox!.height).toBeGreaterThanOrEqual(44);
});
