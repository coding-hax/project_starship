import { test as setup } from '@playwright/test';
import { AUTH_STATE, registerPasskey, resetDatabase } from './helpers';

/**
 * Registers the owner's passkey once per run and saves the session (#115).
 *
 * Every project depends on this and starts from the resulting `storageState`, so the
 * WebAuthn ceremony runs once instead of in all ~140 tests × 2 viewports. The real
 * ceremony still runs here — nothing about auth is mocked, it just stops being repeated.
 */
setup('authenticate once', async ({ page }) => {
  // From zero: "Passkey einrichten" only appears while no credential exists.
  await resetDatabase();
  await registerPasskey(page);
  await page.context().storageState({ path: AUTH_STATE });
});
