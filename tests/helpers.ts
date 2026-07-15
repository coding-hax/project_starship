import type { Page } from '@playwright/test';
import { Client } from 'pg';

/**
 * Chrome's virtual authenticator. This is not a mock of our auth code — the real
 * WebAuthn ceremony runs, the real @simplewebauthn verification runs, a real
 * credential lands in Postgres. Only the hardware is virtual.
 */
export async function enableVirtualAuthenticator(page: Page) {
  const client = await page.context().newCDPSession(page);
  await client.send('WebAuthn.enable');
  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      // Registration asks for residentKey: 'required'. Without this the authenticator
      // refuses with NotAllowedError — and CDP silently ignores a misspelled key.
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true, // stands in for Face ID succeeding
      automaticPresenceSimulation: true,
    },
  });
  return { client, authenticatorId };
}

/** Registers a passkey from a clean state and lands on /heute. */
export async function registerPasskey(page: Page) {
  await enableVirtualAuthenticator(page);

  await page.goto('/anmelden');
  await page.getByRole('button', { name: 'Passkey einrichten' }).click();

  // Shown exactly once. If this ever stops appearing, recovery is silently broken.
  await page.getByTestId('recovery-code').waitFor();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();

  await page.waitForURL('**/heute');
}

/** The tests assert against the real database, not against what the UI claims. */
export async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A clean slate: no credential, no session, no synced row. */
export async function resetDatabase() {
  await withDb(async (client) => {
    await client.query(
      'DELETE FROM sessions; DELETE FROM credentials; DELETE FROM auth_challenges; ' +
        'DELETE FROM recovery_codes; DELETE FROM sync_state; DELETE FROM tasks;',
    );
  });
}

/** The handle the E2E bridge puts on window. */
declare global {
  interface Window {
    __starship: {
      mutate: (input: {
        table: 'sync_state' | 'tasks';
        rowId?: string;
        op: 'upsert' | 'delete' | 'restore';
        payload?: Record<string, unknown>;
      }) => Promise<string>;
      sync: () => Promise<void>;
      size: () => Promise<number>;
    };
  }
}
