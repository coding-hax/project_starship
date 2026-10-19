import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  createRegistrationCredential,
  enableVirtualAuthenticator,
  expectUebersichtLoaded,
  registerPasskey,
  resetDatabase,
  resetRateLimits,
  seedInvite,
  withDb,
} from './helpers';

/**
 * #1202 (S3 of #1199, ADR-0031): registration only opens through an
 * admin-issued invite link now — `scripts/bootstrap-admin.ts` mints the first
 * one, everything else is redeemed at `/einladung/<token>`. The old "empty
 * database opens registration" branch (`register/options`/`register/verify`)
 * is gone.
 *
 * Opts out of the shared owner session (#115), same as shell.spec.ts and
 * auth-recovery-register.spec.ts — every test here drives the signed-out
 * ceremony itself.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(async () => {
  await resetDatabase();
  await resetRateLimits();
});

/**
 * Hands the next spec what `auth.setup.ts` would: a fresh account and a live
 * shared session — the invite ceremony just wiped both (same reasoning as
 * auth-recovery-register.spec.ts's `afterEach`).
 */
test.afterEach(async ({ browser }) => {
  await resetDatabase();
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await registerPasskey(await context.newPage(), null);
  await context.close();
});

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** An invite needs a creator — seeded directly, without redeeming it, so tests can
 *  name a `createdBy` without first running a whole bootstrap ceremony. */
async function seedAdmin(): Promise<string> {
  const id = randomUUID();
  await withDb((client) =>
    client.query("INSERT INTO users (id, role, display_name) VALUES ($1, 'admin', 'Admin')", [id]),
  );
  return id;
}

async function userCount(): Promise<number> {
  const result = await withDb((client) => client.query('SELECT count(*)::int AS count FROM users'));
  return (result.rows[0] as { count: number }).count;
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

/** /uebersicht fires a real open-meteo request (issue leak, see e2e-fallen skill) —
 *  aborted rather than fulfilled: none of these tests assert anything about weather. */
async function abortWeather(page: Page): Promise<void> {
  await page.route('https://api.open-meteo.com/**', (route) => route.abort('failed'));
}

/** The register/options + register/verify ceremony, driven directly over HTTP
 *  (mirrors `fullRecoveryCeremony` in auth-recovery-register.spec.ts) — faster and
 *  more precise than clicking through the UI for the cases that assert on the
 *  HTTP response itself. */
async function redeemInviteViaHttp(page: Page, token: string) {
  const optionsRes = await page.request.post('/api/auth/register/options', {
    data: { inviteToken: token },
  });
  if (!optionsRes.ok()) {
    return { optionsRes, verifyRes: null, verifyBody: null };
  }
  const options = await optionsRes.json();
  const response = await createRegistrationCredential(page, options);
  const verifyRes = await page.request.post('/api/auth/register/verify', {
    data: { response, challenge: options.challenge },
  });
  return { optionsRes, verifyRes, verifyBody: await verifyRes.json() };
}

test('AK1: token_hash ist der SHA-256 des Klartexts, nie der Klartext selbst', async () => {
  const adminId = await seedAdmin();
  const token = await seedInvite({ createdBy: adminId, label: 'Testeinladung' });

  const { rows } = await withDb((client) =>
    client.query(
      'SELECT token_hash, created_by, label, expires_at, used_at, user_id FROM invites',
    ),
  );

  expect(rows).toHaveLength(1);
  expect(rows[0].token_hash).toBe(tokenHash(token));
  expect(rows[0].token_hash).not.toBe(token);
  expect(rows[0].created_by).toBe(adminId);
  expect(rows[0].label).toBe('Testeinladung');
  expect(rows[0].expires_at).toBeTruthy();
  expect(rows[0].used_at).toBeNull();
  expect(rows[0].user_id).toBeNull();
});

test('AK2: ein frischer Einladungs-Link legt ein eigenes leeres Konto an und landet auf /uebersicht', async ({
  page,
}) => {
  const adminId = await seedAdmin();
  const token = await seedInvite({ createdBy: adminId });
  await abortWeather(page);
  await enableVirtualAuthenticator(page);

  const before = await userCount();
  await page.goto(`/einladung/${token}`);
  await page.getByRole('button', { name: 'Passkey einrichten' }).click();
  await page.waitForURL('**/uebersicht');
  await expectUebersichtLoaded(page);

  expect(await userCount()).toBe(before + 1);

  const inviteRow = await withDb((client) =>
    client.query('SELECT used_at, user_id FROM invites WHERE token_hash = $1', [tokenHash(token)]),
  );
  expect(inviteRow.rows[0].used_at).not.toBeNull();
  expect(inviteRow.rows[0].user_id).not.toBeNull();
  const newUserId = inviteRow.rows[0].user_id as string;

  const newUser = await withDb((client) =>
    client.query('SELECT role FROM users WHERE id = $1', [newUserId]),
  );
  expect(newUser.rows[0].role).toBe('user');

  const tasks = await withDb((client) =>
    client.query('SELECT count(*)::int AS count FROM tasks WHERE user_id = $1', [newUserId]),
  );
  expect(tasks.rows[0].count).toBe(0);
});

test('AK3: ein Einladungs-Token funktioniert genau einmal — der zweite Versuch legt kein zweites Konto an', async ({
  page,
}) => {
  const adminId = await seedAdmin();
  const token = await seedInvite({ createdBy: adminId });
  await enableVirtualAuthenticator(page);

  const first = await redeemInviteViaHttp(page, token);
  expect(first.verifyRes?.ok()).toBe(true);
  expect(first.verifyBody?.verified).toBe(true);

  // The successful verify above signed the caller in — log out so the second
  // attempt is rejected for the burned token, not merely allowed because the
  // caller now happens to be authenticated (same reasoning as
  // auth-recovery-register.spec.ts AK2).
  await logout(page);

  const before = await userCount();
  const beforeCredentials = await credentialCount();

  const secondOptionsRes = await page.request.post('/api/auth/register/options', {
    data: { inviteToken: token },
  });
  expect(secondOptionsRes.status()).toBe(403);
  expect(await secondOptionsRes.json()).toEqual({ error: 'Registrierung nicht erlaubt.' });

  expect(await userCount()).toBe(before);
  expect(await credentialCount()).toBe(beforeCredentials);
});

test('AK4: ein abgelaufener und ein unbekannter Token sind an register/options nicht unterscheidbar', async ({
  page,
}) => {
  const adminId = await seedAdmin();
  const expiredToken = await seedInvite({
    createdBy: adminId,
    expiresAt: new Date(Date.now() - 60_000),
  });
  const unknownToken = `unbekannt-${randomUUID()}`;

  const expiredRes = await page.request.post('/api/auth/register/options', {
    data: { inviteToken: expiredToken },
  });
  const unknownRes = await page.request.post('/api/auth/register/options', {
    data: { inviteToken: unknownToken },
  });

  expect(expiredRes.status()).toBe(403);
  expect(expiredRes.status()).toBe(unknownRes.status());
  expect(await expiredRes.json()).toEqual(await unknownRes.json());
});

test('AK5: register/options ohne Invite, Sitzung oder Recovery-Code antwortet 403, auch bei leerer Datenbank', async ({
  page,
}) => {
  const res = await page.request.post('/api/auth/register/options');
  expect(res.status()).toBe(403);
});

test('AK6: bootstrap-admin legt genau ein Admin-Konto + eine Einladung an, ein zweiter Lauf verweigert den Dienst', async () => {
  const output = execFileSync('pnpm', ['run', 'bootstrap-admin'], { encoding: 'utf8' });
  expect(output).toContain('/einladung/');

  const admins = await withDb((client) =>
    client.query("SELECT id FROM users WHERE role = 'admin'"),
  );
  expect(admins.rows).toHaveLength(1);

  const invites = await withDb((client) => client.query('SELECT user_id FROM invites'));
  expect(invites.rows).toHaveLength(1);
  expect(invites.rows[0].user_id).toBe(admins.rows[0].id);

  expect(() => execFileSync('pnpm', ['run', 'bootstrap-admin'], { encoding: 'utf8' })).toThrow();

  const adminsAfter = await withDb((client) =>
    client.query("SELECT id FROM users WHERE role = 'admin'"),
  );
  expect(adminsAfter.rows).toHaveLength(1);
});

test('AK7: mehrere fehlgeschlagene Invite-Versuche sperren das Invite-Budget, options/recovery bleiben unberührt', async ({
  page,
}) => {
  for (let i = 0; i < 5; i += 1) {
    const res = await page.request.post('/api/auth/register/options', {
      data: { inviteToken: `unbekannt-${i}-${randomUUID()}` },
    });
    expect(res.status()).toBe(403);
  }

  const sixth = await page.request.post('/api/auth/register/options', {
    data: { inviteToken: `unbekannt-6-${randomUUID()}` },
  });
  expect(sixth.status()).toBe(429);
  expect(Number(sixth.headers()['retry-after'])).toBeGreaterThan(0);

  // The far more generous, shared options budget is untouched by six invite
  // failures — a plain login/options call from the same sender still succeeds.
  const loginRes = await page.request.post('/api/auth/login/options');
  expect(loginRes.status()).toBe(200);
});

test('AK8: eine angemeldete Sitzung legt ohne Invite einen zweiten Passkey am selben Konto an', async ({
  page,
  browser,
}) => {
  await abortWeather(page);
  await registerPasskey(page);
  const before = await credentialCount();

  // A second passkey needs a second authenticator: reusing `page`'s would hand the
  // server the same credential it already excludes to stop one authenticator
  // registering twice (InvalidStateError) — same reasoning as `openRecoveryDevice`
  // in auth-recovery-register.spec.ts. The session cookie carries over so this
  // "device" is still the signed-in owner, just with its own empty authenticator.
  const storageState = await page.context().storageState();
  const context = await browser.newContext({ storageState });
  const devicePage = await context.newPage();
  await enableVirtualAuthenticator(devicePage);
  // navigator.credentials is undefined on about:blank (no secure-context origin yet) —
  // the ceremony needs a loaded page before `createRegistrationCredential` can run.
  await devicePage.goto('/uebersicht');

  const optionsRes = await devicePage.request.post('/api/auth/register/options');
  expect(optionsRes.status()).toBe(200);
  const options = await optionsRes.json();

  const response = await createRegistrationCredential(devicePage, options);
  const verifyRes = await devicePage.request.post('/api/auth/register/verify', {
    data: { response, challenge: options.challenge, label: 'Zweitgerät' },
  });
  const body = await verifyRes.json();

  expect(verifyRes.ok()).toBe(true);
  expect(body.verified).toBe(true);
  // Not firstCredential any more — no fresh recovery code for an added device.
  expect(body.recoveryCode).toBeNull();
  expect(await credentialCount()).toBe(before + 1);

  await context.close();
});
