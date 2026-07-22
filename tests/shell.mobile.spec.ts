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
