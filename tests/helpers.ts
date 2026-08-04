import { randomUUID } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { Client } from 'pg';
import { AUTH_STATE } from './run-lock';

export { AUTH_STATE };

/**
 * A fixed "now" for specs that would otherwise read the real wall clock (#495).
 * Midday, far from midnight and DST, matching the NOW already proven in
 * uebersicht.spec.ts.
 */
export const FIXED_NOW = '2026-07-18T12:00:00.000Z';

/**
 * Installs the fake clock at `when` (default FIXED_NOW). Call before the first
 * navigation — the clock ticks forward at real rate afterwards (so liveQuery/
 * sync timers keep firing); only `freezeClock`/`fastForward` actually stop it.
 */
export async function installClockAt(page: Page, when: string = FIXED_NOW) {
  await page.clock.install({ time: new Date(when) });
}

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
      // The journal's PRF-derived unlock key (#511) reuses this same login
      // passkey, so the virtual authenticator must speak the prf extension too.
      hasPrf: true,
    },
  });
  return { client, authenticatorId };
}

/**
 * Drives `navigator.credentials.create()` by hand against a registration-options
 * response — the same ceremony `startRegistration` (@simplewebauthn/browser) runs
 * for the "Passkey einrichten" button, but written out directly because the
 * recovery-code registration path (#476) has no UI entry point to click through
 * (a recovery code cannot be typed anywhere yet). The virtual authenticator signs
 * for real; only the base64url<->ArrayBuffer plumbing normally hidden by the
 * client library is inlined here.
 */
export async function createRegistrationCredential(
  page: Page,
  optionsJSON: PublicKeyCredentialCreationOptionsJSON,
): Promise<RegistrationResponseJSON> {
  return page.evaluate(async (options) => {
    function base64UrlToBuffer(value: string): ArrayBuffer {
      const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
      const raw = atob(padded);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
      return bytes.buffer;
    }
    function bufferToBase64Url(buffer: ArrayBuffer): string {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    const publicKey = {
      ...options,
      challenge: base64UrlToBuffer(options.challenge),
      user: { ...options.user, id: base64UrlToBuffer(options.user.id) },
      excludeCredentials: (options.excludeCredentials ?? []).map((credential) => ({
        ...credential,
        id: base64UrlToBuffer(credential.id),
      })),
    };

    const credential = (await navigator.credentials.create({
      publicKey: publicKey as unknown as PublicKeyCredentialCreationOptions,
    })) as PublicKeyCredential;
    const response = credential.response as AuthenticatorAttestationResponse;

    return {
      id: credential.id,
      rawId: bufferToBase64Url(credential.rawId),
      type: credential.type,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: bufferToBase64Url(response.clientDataJSON),
        attestationObject: bufferToBase64Url(response.attestationObject),
        transports: response.getTransports ? response.getTransports() : [],
      },
    } as unknown as RegistrationResponseJSON;
  }, optionsJSON);
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
    // Same postcondition as the full ceremony: signed in AND sitting on a loaded /uebersicht.
    // Callers rely on it — they reach straight for `window.__starship` afterwards.
    await page.goto('/uebersicht');
    return;
  }

  await enableVirtualAuthenticator(page);

  await page.goto('/anmelden');
  await page.getByRole('button', { name: 'Passkey einrichten' }).click();

  // Shown exactly once. If this ever stops appearing, recovery is silently broken.
  await page.getByTestId('recovery-code').waitFor();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();

  await page.waitForURL('**/uebersicht');

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
  await devicePage.goto('/uebersicht');
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
      'DELETE FROM sync_state; DELETE FROM tasks; DELETE FROM garmin_activities; ' +
        'DELETE FROM reminder_prefs; DELETE FROM journal_entries; DELETE FROM journal_keys; ' +
        // habit_logs/habit_freezes first — both reference habits via a foreign key.
        'DELETE FROM habit_logs; DELETE FROM habit_freezes; DELETE FROM habits; ' +
        // event_exceptions first — it references events via a foreign key (issue #553).
        'DELETE FROM event_exceptions; DELETE FROM events;',
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
        'DELETE FROM habit_logs; DELETE FROM habit_freezes; DELETE FROM habits; ' +
        'DELETE FROM garmin_activities; ' +
        'DELETE FROM garmin_tokens; DELETE FROM reminder_prefs; DELETE FROM journal_entries; ' +
        'DELETE FROM journal_keys; ' +
        // event_exceptions first — it references events via a foreign key (issue #553).
        'DELETE FROM event_exceptions; DELETE FROM events;',
    );
  });
}

/** push_subscriptions is server-/device-infra (src/db/schema.ts), not app data — its own reset. */
export async function resetPushData() {
  await withDb(async (client) => {
    await client.query('DELETE FROM push_subscriptions;');
  });
}

/** reminder_sends is cron infra (src/db/schema.ts, issue #239) — its own reset, same reasoning. */
export async function resetReminderData() {
  await withDb(async (client) => {
    await client.query('DELETE FROM reminder_sends; DELETE FROM reminder_prefs;');
  });
}

/**
 * Seeds a `reminder_prefs` row the way a real push (not this helper) would leave
 * it — same columns a client upsert writes (src/db/sync-tables.ts), so the cron
 * reads a row indistinguishable from one the settings panel produced (issue #244).
 */
export async function seedReminderPref(kind: string, enabled: boolean, times: string[]): Promise<void> {
  await withDb((client) =>
    client.query(
      `INSERT INTO reminder_prefs (id, updated_at, deleted_at, synced_at, sync_seq, kind, enabled, times)
       VALUES ($1, now(), NULL, now(), nextval('sync_seq'), $2, $3, $4)
       ON CONFLICT (kind) DO UPDATE SET enabled = $3, times = $4`,
      [randomUUID(), kind, enabled, JSON.stringify(times)],
    ),
  );
}

interface ForecastFixture {
  dates: string[];
  tempsMax: number[];
  tempsMin: number[];
  /** Defaults to 0 = klar for every day. */
  weatherCodes?: number[];
  /** Defaults to 0 % for every day. */
  precipitationProbabilityMax?: number[];
}

/**
 * A complete Open-Meteo `/v1/forecast` body, covering every column
 * `buildForecastUrl` asks for (src/features/weather/forecast.ts).
 *
 * `parseForecast` reads `hourly` as well as `daily` since issue #156, and it reads
 * `hourly.time` unguarded. A fixture that ships `daily` alone therefore does not
 * fail loudly — it throws inside the refresh, which `use-weather-cache.ts` catches
 * and logs, so the spec just sees an empty forecast and a five-second timeout with
 * no hint as to why. Build fixtures through here rather than inline, so the shape
 * only has to be corrected in one place when the URL grows another column.
 */
export function openMeteoForecastBody({
  dates,
  tempsMax,
  tempsMin,
  weatherCodes = dates.map(() => 0),
  precipitationProbabilityMax = dates.map(() => 0),
}: ForecastFixture) {
  const time: string[] = [];
  const temperature_2m: number[] = [];
  const precipitation_probability: number[] = [];
  const precipitation: number[] = [];
  dates.forEach((date, day) => {
    for (let hour = 0; hour < 24; hour += 1) {
      time.push(`${date}T${String(hour).padStart(2, '0')}:00`);
      // A plain min-to-max ramp: the callers of this helper assert on the daily
      // strip, so the curve only has to be present and in range, not realistic.
      temperature_2m.push(tempsMin[day] + ((tempsMax[day] - tempsMin[day]) * hour) / 23);
      precipitation_probability.push(precipitationProbabilityMax[day]);
      precipitation.push(0);
    }
  });
  return {
    daily: {
      time: dates,
      weather_code: weatherCodes,
      temperature_2m_max: tempsMax,
      temperature_2m_min: tempsMin,
      precipitation_probability_max: precipitationProbabilityMax,
      sunrise: dates.map((date) => `${date}T05:53`),
      sunset: dates.map((date) => `${date}T21:12`),
      wind_speed_10m_max: dates.map(() => 12),
      wind_gusts_10m_max: dates.map(() => 20),
    },
    hourly: { time, temperature_2m, precipitation_probability, precipitation },
  };
}

/** The handle the E2E bridge puts on window. */
declare global {
  interface Window {
    __starship: {
      mutate: (input: {
        table:
          | 'sync_state'
          | 'tasks'
          | 'habits'
          | 'habit_logs'
          | 'habit_freezes'
          | 'garmin_activities'
          | 'reminder_prefs'
          | 'journal_entries'
          | 'journal_keys'
          | 'events'
          | 'event_exceptions';
        rowId?: string;
        op: 'upsert' | 'delete' | 'restore';
        payload?: Record<string, unknown>;
      }) => Promise<string>;
      sync: () => Promise<void>;
      size: () => Promise<number>;
      pending: () => Promise<
        Array<{ id: string; table: string; rowId: string; op: string; payload: Record<string, unknown> }>
      >;
      startSync: () => () => void;
      persistStatus: () => 'granted' | 'denied' | 'unsupported' | null;
      debugPatchOutbox: (id: string, patch: Record<string, unknown>) => Promise<number>;
      debugPatchRecord: (table: string, id: string, patch: Record<string, unknown>) => Promise<number>;
      debugRecords: () => Promise<
        Array<{
          table: string;
          id: string;
          updatedAt: string;
          deletedAt: string | null;
          syncedAt: string | null;
          syncSeq: number | null;
          data: Record<string, unknown>;
        }>
      >;
      debugMeta: () => Promise<Array<{ key: string; value: unknown }>>;
      writeJournalEntry: (entryDate: string, ciphertext: number[], nonce: number[]) => Promise<string>;
      appendJournalEntry: (
        entryDate: string,
        content: { text: string; mood?: string; tags?: string[] },
      ) => Promise<void>;
      listJournalEntries: (entryDate: string) => Promise<
        Array<{
          id: string;
          entryDate: string;
          createdAt: string;
          content: { text: string; mood?: string; tags?: string[] };
        }>
      >;
      deleteJournalEntry: (id: string) => Promise<void>;
      bytesToBase64: (bytes: number[]) => string;
      createEnvelope: (
        passphrase: string,
        kdfParamsOverride?: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number },
      ) => Promise<unknown>;
      openEnvelope: (envelope: unknown, passphrase: string) => Promise<unknown>;
      encryptJournal: (
        dek: unknown,
        content: { text: string; mood?: string; tags?: string[] },
      ) => Promise<{ ciphertext: number[]; nonce: number[] }>;
      journalSetup: (passphrase: string) => Promise<string>;
      journalUnlock: (passphrase: string) => Promise<'ok' | 'wrong'>;
      journalLock: () => Promise<void>;
      journalLockState: () => 'loading' | 'setup' | 'locked' | 'unlocked';
      journalHasPersistedDek: () => Promise<boolean>;
      journalPersistedDekExtractable: () => Promise<boolean | null>;
      debugDumpStores: () => Promise<string>;
    };
  }
}
