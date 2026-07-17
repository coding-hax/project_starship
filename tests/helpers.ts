import type { Browser, Page } from '@playwright/test';
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

/**
 * A second, independent "device": its own IndexedDB (a fresh browser context),
 * but the same authenticated session as `page` — reusing the passkey ceremony
 * would need a recovery code and a second virtual authenticator for no benefit,
 * since what #29 exercises is the sync pull path, not credential handling.
 */
export async function openSecondDevice(browser: Browser, page: Page) {
  const storageState = await page.context().storageState();
  const context = await browser.newContext({ storageState });
  const devicePage = await context.newPage();
  await devicePage.goto('/heute');
  return devicePage;
}

/**
 * Skews one device's clock without touching its timers — `scheduleSync`'s
 * debounce and `startSync`'s poll interval keep firing normally. Used to prove
 * that arrival order, not the client clock, decides sync conflicts (ADR-0008, #53).
 */
export async function skewClock(page: Page, at: string) {
  await page.clock.setFixedTime(at);
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
      pending: () => Promise<
        Array<{ table: string; rowId: string; op: string; payload: Record<string, unknown> }>
      >;
      startSync: () => () => void;
      persistStatus: () => 'granted' | 'denied' | 'unsupported' | null;
    };
  }
}
