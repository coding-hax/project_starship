import type { Browser, Page } from '@playwright/test';
import { Client } from 'pg';
import { AUTH_STATE } from './run-lock';

export { AUTH_STATE };

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

/**
 * Makes sure the page is signed in, and is cheap when it already is (#115).
 *
 * The suite used to run this full WebAuthn ceremony in every single test — 59 call
 * sites × 2 viewports, each a page load, a click, a recovery-code wait and a redirect.
 * That was the bulk of the runtime. Now the `setup` project registers once and the
 * projects start from its `storageState`, so the status probe below short-circuits.
 *
 * It stays self-healing: the specs that legitimately wipe credentials (shell.spec.ts
 * asserts the pristine "Passkey einrichten" state) leave the shared session invalid,
 * so the next caller registers again — and writes the refreshed state back, which the
 * following contexts pick up. Costs one ceremony after such a test instead of all of them.
 */
export async function registerPasskey(page: Page) {
  const authenticated = await page.request
    .get('/api/auth/status')
    .then((r) => r.ok() && r.json().then((s: { authenticated?: boolean }) => !!s.authenticated))
    .catch(() => false);
  if (authenticated) {
    // Same postcondition as the full ceremony: signed in AND sitting on a loaded /heute.
    // Callers rely on it — they reach straight for `window.__starship` afterwards.
    await page.goto('/heute');
    return;
  }

  await enableVirtualAuthenticator(page);

  await page.goto('/anmelden');
  await page.getByRole('button', { name: 'Passkey einrichten' }).click();

  // Shown exactly once. If this ever stops appearing, recovery is silently broken.
  await page.getByTestId('recovery-code').waitFor();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();

  await page.waitForURL('**/heute');

  await page.context().storageState({ path: AUTH_STATE });
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

/**
 * Freezes an already-installed fake clock at the page's *own* current time, so the
 * fastForward that follows advances a known, deterministic amount.
 *
 * `page.clock.pauseAt(Date.now())` read the time in the **Node** test process, not in
 * the browser. The installed fake clock keeps ticking at real rate, and the CDP round
 * trip that carries `pauseAt` to the browser takes a few milliseconds — long enough
 * for the browser clock to tick past the captured value, so `pauseAt` rejected with
 * "cannot fast-forward to the past" and the #29 poll tests flaked (#75). Reading the
 * time inside the page and pausing a beat ahead keeps the target ahead of the still-
 * advancing clock. The one-second lead is far smaller than any interval the callers
 * fast-forward through, so it changes nothing they assert on.
 */
export async function freezeClock(page: Page) {
  const browserNow = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(browserNow + 1_000);
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

/**
 * Clears the app's own rows but leaves the owner signed in — the default (#115).
 *
 * Wiping `sessions`/`credentials` too (what the old `resetDatabase` did everywhere)
 * invalidated the shared session, which forced every test to re-run the WebAuthn
 * ceremony. Domain tests only need empty data, not a logged-out browser.
 */
export async function resetAppData() {
  await withDb(async (client) => {
    await client.query(
      'DELETE FROM sync_state; DELETE FROM tasks; ' +
        // habit_logs first — it references habits via a foreign key.
        'DELETE FROM habit_logs; DELETE FROM habits;',
    );
  });
}

/**
 * A truly clean slate: no credential, no session, no synced row. Only for specs that
 * assert the pristine, never-registered state (shell.spec.ts). It logs the shared
 * session out — `registerPasskey` notices and re-registers for whoever comes next.
 */
export async function resetDatabase() {
  await withDb(async (client) => {
    await client.query(
      'DELETE FROM sessions; DELETE FROM credentials; DELETE FROM auth_challenges; ' +
        'DELETE FROM recovery_codes; DELETE FROM sync_state; DELETE FROM tasks; ' +
        'DELETE FROM habit_logs; DELETE FROM habits;',
    );
  });
}

/** The handle the E2E bridge puts on window. */
declare global {
  interface Window {
    __starship: {
      mutate: (input: {
        table: 'sync_state' | 'tasks' | 'habits' | 'habit_logs';
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
