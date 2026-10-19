import { createHash, randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/server';
import {
  createRegistrationCredential,
  currentAccountId,
  enableVirtualAuthenticator,
  registerPasskey,
  resetDatabase,
  withDb,
} from './helpers';

/**
 * Issue #476 (Fund F3, Deep Review 02.08.26). `register/options` used to burn the
 * recovery code the moment it was checked — before the WebAuthn ceremony that
 * follows even started. An aborted ceremony (wrong PIN, closed dialog, no
 * authenticator on this device) left the owner permanently locked out with no new
 * passkey to show for it. Now `options` only checks the code (`usedAt` stays
 * null); `verify` burns it, atomically with the credential insert, and only once
 * it knows — via the challenge it stored, never via a code resent by the client —
 * that this ceremony is recovery-backed.
 */

const RECOVERY_CODE = 'AC476-RECOVERY-CODE';

function recoveryCodeHash(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}

/**
 * The code belongs to the account the existing passkey belongs to (#1200): a
 * recovery code is presented without a session, so it has to carry the identity
 * itself — that is how `register/options` learns which account the new passkey
 * joins instead of creating a second one.
 */
async function seedRecoveryCode(code: string): Promise<void> {
  const userId = await currentAccountId();
  await withDb((client) =>
    client.query('INSERT INTO recovery_codes (id, user_id, code_hash) VALUES ($1, $2, $3)', [
      randomUUID(),
      userId,
      recoveryCodeHash(code),
    ]),
  );
}

async function recoveryCodeUsedAt(code: string): Promise<Date | null> {
  const result = await withDb((client) =>
    client.query('SELECT used_at FROM recovery_codes WHERE code_hash = $1', [
      recoveryCodeHash(code),
    ]),
  );
  return (result.rows[0] as { used_at: Date | null } | undefined)?.used_at ?? null;
}

async function credentialCount(): Promise<number> {
  const result = await withDb((client) =>
    client.query('SELECT count(*)::int AS count FROM credentials'),
  );
  return (result.rows[0] as { count: number }).count;
}

async function logout(page: Page): Promise<void> {
  const response = await page.request.post('/api/auth/logout');
  expect(response.ok()).toBe(true);
}

/** Seeds one existing credential (firstSetup=false) via `page` — the ceremony
 *  helpers below never touch `page` again, since recovery always runs from a
 *  different device (see `openRecoveryDevice`). */
async function seedExistingCredential(page: Page): Promise<void> {
  await resetDatabase();
  await registerPasskey(page); // real ceremony; its own recovery code is unused here
  await seedRecoveryCode(RECOVERY_CODE);
}

/**
 * A recovery code exists precisely because the *original* device/authenticator
 * is unavailable — reusing `page`'s authenticator here would make the server
 * correctly refuse a second resident credential for the same account
 * (`excludeCredentials` matches it, InvalidStateError). A fresh context with its
 * own virtual authenticator is what recovery is actually exercising: a new
 * device, no session cookie, no existing credential of its own.
 *
 * `browser.newContext()` alone is not enough for that last part: the `mobile`
 * project sets `storageState: AUTH_STATE` (issue #115), and Playwright's test
 * `browser` fixture applies a project's `use` options as defaults to *every*
 * `newContext()` call, not just the built-in `page`/`context` fixtures — so a
 * bare call silently signs the "new device" in as the owner. An explicit empty
 * storage state is what actually produces a signed-out context.
 */
async function openRecoveryDevice(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const devicePage = await context.newPage();
  await enableVirtualAuthenticator(devicePage);
  await devicePage.goto('/anmelden');
  return devicePage;
}

async function requestOptions(page: Page, recoveryCode?: string) {
  return page.request.post('/api/auth/register/options', {
    data: recoveryCode ? { recoveryCode } : {},
  });
}

async function fullRecoveryCeremony(page: Page, recoveryCode: string) {
  const optionsRes = await requestOptions(page, recoveryCode);
  expect(optionsRes.status()).toBe(200);
  const options = (await optionsRes.json()) as PublicKeyCredentialCreationOptionsJSON;

  const response = await createRegistrationCredential(page, options);
  const verifyRes = await page.request.post('/api/auth/register/verify', {
    data: { response, challenge: options.challenge },
  });
  return { verifyRes, verifyBody: await verifyRes.json() };
}

test.beforeEach(async ({ page }) => {
  await seedExistingCredential(page);
});

/**
 * Every test here wipes the database and mints its own session, which
 * `registerPasskey` writes into the shared AUTH_STATE — and #856 AK2 below
 * signs that session out while the account stays. The next spec's
 * `registerPasskey` cannot heal that state (the setup ceremony only exists on
 * an empty database), so whichever test runs last here must not leave it
 * behind. Hand over what `auth.setup.ts` would: a fresh account and a live
 * shared session.
 */
test.afterEach(async ({ browser }) => {
  await resetDatabase();
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await registerPasskey(await context.newPage(), null);
  await context.close();
});

test('AK2: nach erfolgreichem verify ist usedAt gesetzt, derselbe Code wird beim naechsten options mit 403 abgewiesen', async ({
  browser,
}) => {
  const before = await credentialCount();
  const devicePage = await openRecoveryDevice(browser);

  const { verifyRes, verifyBody } = await fullRecoveryCeremony(devicePage, RECOVERY_CODE);
  expect(verifyRes.status()).toBe(200);
  expect(verifyBody.verified).toBe(true);
  expect(await credentialCount()).toBe(before + 1);
  expect(await recoveryCodeUsedAt(RECOVERY_CODE)).not.toBeNull();

  // A successful verify signs the caller in (createSession) — log out again so the
  // next options call is rejected for the code, not merely allowed because the
  // caller now happens to be authenticated.
  await logout(devicePage);
  const secondOptionsRes = await requestOptions(devicePage, RECOVERY_CODE);
  expect(secondOptionsRes.status()).toBe(403);
});

test('AK3: eine abgebrochene Zeremonie laesst den Code gueltig, ein zweiter Anlauf erzeugt den Passkey', async ({
  browser,
}) => {
  const before = await credentialCount();
  const devicePage = await openRecoveryDevice(browser);

  // Abgebrochen: eine options-Runde, aber kein verify danach.
  const optionsRes = await requestOptions(devicePage, RECOVERY_CODE);
  expect(optionsRes.status()).toBe(200);
  expect(await recoveryCodeUsedAt(RECOVERY_CODE)).toBeNull();

  // Zweiter Anlauf mit demselben, noch gueltigen Code fuehrt zum Passkey.
  const { verifyRes } = await fullRecoveryCeremony(devicePage, RECOVERY_CODE);
  expect(verifyRes.status()).toBe(200);
  expect(await credentialCount()).toBe(before + 1);
  expect(await recoveryCodeUsedAt(RECOVERY_CODE)).not.toBeNull();
});

test('AK4: verify ohne vorangegangene recovery-gestuetzte options-Runde kann keinen Passkey anlegen', async ({
  page,
}) => {
  const before = await credentialCount();

  // Eine erfundene/abgelaufene Challenge trägt keine Recovery-Bindung — ein
  // client-seitig mitgeschickter Code wird ignoriert, es zaehlt nur, was
  // `options` serverseitig an der Challenge hinterlegt hat.
  const verifyRes = await page.request.post('/api/auth/register/verify', {
    data: {
      response: {},
      challenge: 'erfundene-oder-abgelaufene-challenge',
      recoveryCode: RECOVERY_CODE,
    },
  });

  expect(verifyRes.status()).toBe(400);
  expect(await credentialCount()).toBe(before);
  expect(await recoveryCodeUsedAt(RECOVERY_CODE)).toBeNull();
});

/**
 * #856 (S3 von #851): der Recovery-Weg bekommt eine Oberfläche unter `/anmelden`.
 * Die vier Tests oben bleiben (Server unverändert) — diese fahren dieselbe
 * Zeremonie durch die UI, inklusive der beiden Fehlerpfade, die vorher gar keine
 * eigene Meldung hatten (#851 Fund 1/8).
 */
test.describe('#856: Recovery-Formular unter /anmelden', () => {
  test('AK1 (UI): ein echtes neues Gerät meldet sich über das Formular an und legt einen zweiten Passkey an', async ({
    browser,
  }) => {
    const before = await credentialCount();
    const devicePage = await openRecoveryDevice(browser);

    await devicePage
      .getByRole('button', { name: 'Neues Gerät? Mit Recovery-Code anmelden' })
      .click();
    await devicePage.getByLabel('Recovery-Code').fill(RECOVERY_CODE);
    await devicePage.getByRole('button', { name: 'Gerät anmelden' }).click();

    await devicePage.waitForURL('**/uebersicht');
    expect(await credentialCount()).toBe(before + 1);
    expect(await recoveryCodeUsedAt(RECOVERY_CODE)).not.toBeNull();
  });

  test('AK2: hält dieses Gerät den Passkey schon, erscheint die eigene Meldung, kein zweiter Passkey, Code bleibt gültig', async ({
    page,
  }) => {
    const before = await credentialCount();
    // Unmounts the still-live app shell from `beforeEach`'s registerPasskey first —
    // otherwise its `SyncBoot` keeps polling, and the account-isolation 401 it hits
    // right after `logout()` fires the very same hard redirect (sync.ts's
    // `onUnauthorized`) that this test issues explicitly below. Two navigations to
    // the identical `/anmelden` URL race, and Playwright's own `goto` loses with
    // `net::ERR_ABORTED` (CI shard 2, 19.10.26). Going through `about:blank` first
    // tears down that interval/listener before `logout()` can ever race it.
    await page.goto('about:blank');
    await logout(page);
    await page.goto('/anmelden');

    await page.getByRole('button', { name: 'Neues Gerät? Mit Recovery-Code anmelden' }).click();
    await page.getByLabel('Recovery-Code').fill(RECOVERY_CODE);
    await page.getByRole('button', { name: 'Gerät anmelden' }).click();

    await expect(page.locator('.auth__error')).toHaveText(
      'Auf diesem Gerät gibt es den Passkey schon.',
    );
    expect(await credentialCount()).toBe(before);
    expect(await recoveryCodeUsedAt(RECOVERY_CODE)).toBeNull();
  });
});
