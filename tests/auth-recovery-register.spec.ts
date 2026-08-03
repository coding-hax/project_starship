import { createHash, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/server';
import { createRegistrationCredential, registerPasskey, resetDatabase, withDb } from './helpers';

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

async function seedRecoveryCode(code: string): Promise<void> {
  await withDb((client) =>
    client.query('INSERT INTO recovery_codes (id, code_hash) VALUES ($1, $2)', [
      randomUUID(),
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

/** One existing credential (firstSetup=false) but no active session — the state
 *  an owner who lost their device/session is actually in when they reach for a
 *  recovery code. */
async function setUpLoggedOutOwner(page: Page): Promise<void> {
  await resetDatabase();
  await registerPasskey(page); // real ceremony; its own recovery code is unused here
  await seedRecoveryCode(RECOVERY_CODE);
  await logout(page);
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
  await setUpLoggedOutOwner(page);
});

test('AK1: ein options-Aufruf mit gueltigem Recovery-Code laesst usedAt null', async ({
  page,
}) => {
  const optionsRes = await requestOptions(page, RECOVERY_CODE);
  expect(optionsRes.status()).toBe(200);

  expect(await recoveryCodeUsedAt(RECOVERY_CODE)).toBeNull();
});

test('AK2: nach erfolgreichem verify ist usedAt gesetzt, derselbe Code wird beim naechsten options mit 403 abgewiesen', async ({
  page,
}) => {
  const before = await credentialCount();

  const { verifyRes, verifyBody } = await fullRecoveryCeremony(page, RECOVERY_CODE);
  expect(verifyRes.status()).toBe(200);
  expect(verifyBody.verified).toBe(true);
  expect(await credentialCount()).toBe(before + 1);
  expect(await recoveryCodeUsedAt(RECOVERY_CODE)).not.toBeNull();

  // A successful verify signs the caller in (createSession) — log out again so the
  // next options call is rejected for the code, not merely allowed because the
  // caller now happens to be authenticated.
  await logout(page);
  const secondOptionsRes = await requestOptions(page, RECOVERY_CODE);
  expect(secondOptionsRes.status()).toBe(403);
});

test('AK3: eine abgebrochene Zeremonie laesst den Code gueltig, ein zweiter Anlauf erzeugt den Passkey', async ({
  page,
}) => {
  const before = await credentialCount();

  // Abgebrochen: eine options-Runde, aber kein verify danach.
  const optionsRes = await requestOptions(page, RECOVERY_CODE);
  expect(optionsRes.status()).toBe(200);
  expect(await recoveryCodeUsedAt(RECOVERY_CODE)).toBeNull();

  // Zweiter Anlauf mit demselben, noch gueltigen Code fuehrt zum Passkey.
  const { verifyRes } = await fullRecoveryCeremony(page, RECOVERY_CODE);
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
