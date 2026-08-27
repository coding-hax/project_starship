import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, type Browser, type Page } from '@playwright/test';
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

/**
 * Switches `/aufgaben`'s Woche/Alle/Erledigt view (issue #705 AK2) via the
 * SegmentedControl's `role="radio"` options, and waits for `aria-checked` so
 * the caller's next assertion never races the click. Almost every existing
 * `/aufgaben` spec was written against the flat, undated-inclusive "Alle"
 * run (issue #88) — now that "Woche" is the default, those specs call
 * `selectView(page, 'Alle')` right after landing on `/aufgaben` to keep
 * testing exactly what they always tested (Entscheidung A, issue #705).
 */
export async function selectView(page: Page, view: 'Woche' | 'Alle' | 'Erledigt') {
  const option = page
    .getByRole('radiogroup', { name: 'Aufgaben-Ansicht' })
    .getByRole('radio', { name: view });
  await option.click();
  await expect(option).toHaveAttribute('aria-checked', 'true');
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
 * Mints a session row directly in Postgres (mirrors `hashToken`/`createSession` in
 * `src/auth/session.ts`), independent of the shared `AUTH_STATE` session — for specs
 * that need to actually log out (issue #756). Set the returned `token` as the
 * `starship_session` cookie in a fresh context; sperren must never touch the shared
 * session every other project's `storageState` depends on. Optional `credentialId`
 * binds the session the way a real login/register does (issue #854) — omitted, it
 * stays `null` like a pre-#854 session.
 */
export async function createThrowawaySession(
  credentialId?: string,
): Promise<{ token: string; tokenHash: string }> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  await withDb((client) =>
    client.query(
      'INSERT INTO sessions (id, token_hash, expires_at, credential_id) VALUES ($1, $2, $3, $4)',
      [randomUUID(), tokenHash, expiresAt, credentialId ?? null],
    ),
  );
  return { token, tokenHash };
}

export async function sessionRowExists(tokenHash: string): Promise<boolean> {
  const result = await withDb((client) =>
    client.query('SELECT 1 FROM sessions WHERE token_hash = $1', [tokenHash]),
  );
  return result.rows.length > 0;
}

/**
 * Mints a `credentials` row directly in Postgres, independent of the real WebAuthn
 * ceremony (issue #754) — for specs that need extra passkeys to revoke without
 * running a second virtual-authenticator registration. `credentialId`/`publicKey`
 * are throwaway values; nothing ever verifies a signature against them.
 */
export async function createThrowawayCredential({
  label,
}: { label?: string } = {}): Promise<string> {
  const id = randomUUID();
  await withDb((client) =>
    client.query(
      'INSERT INTO credentials (id, credential_id, public_key, label) VALUES ($1, $2, $3, $4)',
      [id, randomUUID(), randomBytes(32).toString('base64url'), label ?? null],
    ),
  );
  return id;
}

export async function credentialRowExists(id: string): Promise<boolean> {
  const result = await withDb((client) =>
    client.query('SELECT 1 FROM credentials WHERE id = $1', [id]),
  );
  return result.rows.length > 0;
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
        'DELETE FROM reminder_prefs; DELETE FROM category_colors; ' +
        'DELETE FROM journal_entries; DELETE FROM journal_keys; ' +
        // habit_logs/habit_freezes first — both reference habits via a foreign key.
        'DELETE FROM habit_logs; DELETE FROM habit_freezes; DELETE FROM habits; ' +
        // event_exceptions first — it references events via a foreign key (issue #553).
        'DELETE FROM event_exceptions; DELETE FROM events;',
    );
  });
}

/**
 * Settles the boot-time Journal-habit creation (issue #505 AC1) deterministically.
 * `JournalHabitBoot` creates the row itself on every fresh account (the Journal
 * module is active by default), but only after its own `await sync()` resolves —
 * timing that isn't bound to anything a spec can wait on, so its `mutate()` can
 * land in the outbox at any point after boot, including inside a window a spec is
 * already using to assert an exact outbox size or habit-row count (#505 ripple).
 * Calling `ensureJournalHabit` directly is idempotent with whatever the boot effect
 * does on its own — whichever of the two runs first wins, the other is a no-op.
 * Call right after `registerPasskey`, while still online, before the spec's own
 * scenario starts.
 */
export async function settleJournalHabitBoot(page: Page): Promise<void> {
  await page.evaluate(() => window.__starship.ensureJournalHabit());
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
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
        'DELETE FROM auth_rate_limits; ' +
        'DELETE FROM recovery_codes; DELETE FROM sync_state; DELETE FROM tasks; ' +
        'DELETE FROM habit_logs; DELETE FROM habit_freezes; DELETE FROM habits; ' +
        'DELETE FROM garmin_activities; ' +
        'DELETE FROM garmin_tokens; DELETE FROM reminder_prefs; DELETE FROM category_colors; ' +
        'DELETE FROM journal_entries; ' +
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
 * auth_rate_limits is server infra (src/db/schema.ts, issue #755) — its own reset so
 * specs that call the auth options routes without a full `resetDatabase()` (e.g.
 * auth-verify.spec.ts, which keeps the shared session) don't accumulate a shared
 * `unknown`-key counter across tests and trip a sporadic 429.
 */
export async function resetRateLimits() {
  await withDb(async (client) => {
    await client.query('DELETE FROM auth_rate_limits;');
  });
}

/**
 * Seeds a `reminder_prefs` row the way a real push (not this helper) would leave
 * it — same columns a client upsert writes (src/db/sync-tables.ts), so the cron
 * reads a row indistinguishable from one the settings panel produced (issue #244).
 */
export async function seedReminderPref(
  kind: string,
  enabled: boolean,
  times: string[],
): Promise<void> {
  await withDb((client) =>
    client.query(
      `INSERT INTO reminder_prefs (id, updated_at, deleted_at, synced_at, sync_seq, kind, enabled, times)
       VALUES ($1, now(), NULL, now(), nextval('sync_seq'), $2, $3, $4)
       ON CONFLICT (kind) DO UPDATE SET enabled = $3, times = $4`,
      [randomUUID(), kind, enabled, JSON.stringify(times)],
    ),
  );
}

/**
 * Seeds a `category_colors` row the way a real client upsert would leave it
 * (src/db/sync-tables.ts, issue #660) — same shape `useCategoryColors`'s
 * `setColor` produces, so a spec can assert AC9's offline→online path without
 * driving the panel's own UI first.
 */
export async function seedCategoryColor(category: string, color: string): Promise<void> {
  await withDb((client) =>
    client.query(
      `INSERT INTO category_colors (id, updated_at, deleted_at, synced_at, sync_seq, category, color)
       VALUES ($1, now(), NULL, now(), nextval('sync_seq'), $2, $3)
       ON CONFLICT (category) DO UPDATE SET color = $3`,
      [randomUUID(), category, color],
    ),
  );
}

/**
 * Seeds a `habit_freezes` row directly in Postgres, bypassing the client entirely.
 * The table is dormant since issue #796 removed the streak-joker feature (sync
 * wiring, UI, quota logic) but kept the table itself to avoid a migration/data
 * loss. Unlike `seedReminderPref`/`seedCategoryColor`, a row minted this way can
 * never reach a client through the outbox — the pull no longer reads
 * `habit_freezes` — so this only simulates a leftover row from before the removal.
 *
 * The specs that call this create the matching habit only client-side (via
 * `mutate`, never synced — `**\/api/sync/**` is aborted). `habit_freezes.habit_id`
 * has a foreign key to `habits.id`, so Postgres needs a row with the same id or
 * the insert below is rejected; its content is irrelevant since the app never
 * reads `habits` back from Postgres in these specs.
 */
export async function seedHabitFreeze(habitId: string, freezeDate: string): Promise<void> {
  await withDb((client) =>
    client.query(
      `INSERT INTO habits (id, sync_seq, name, schedule)
       VALUES ($1, nextval('sync_seq'), 'Postgres-Restzeile', 'daily')
       ON CONFLICT (id) DO NOTHING`,
      [habitId],
    ),
  );
  await withDb((client) =>
    client.query(
      `INSERT INTO habit_freezes (id, updated_at, deleted_at, synced_at, sync_seq, habit_id, freeze_date)
       VALUES ($1, now(), NULL, now(), nextval('sync_seq'), $2, $3)`,
      [randomUUID(), habitId, freezeDate],
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
  /** Defaults to 12 km/h for every day — under both isWindy thresholds (issue #695),
   * so specs outside weather.spec.ts stay windmark-free unless they opt in. */
  windSpeedsMax?: number[];
  /** Defaults to 20 km/h for every day — same reasoning as `windSpeedsMax`. */
  windGustsMax?: number[];
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
  windSpeedsMax = dates.map(() => 12),
  windGustsMax = dates.map(() => 20),
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
      wind_speed_10m_max: windSpeedsMax,
      wind_gusts_10m_max: windGustsMax,
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
          | 'garmin_activities'
          | 'reminder_prefs'
          | 'journal_entries'
          | 'journal_keys'
          | 'events'
          | 'event_exceptions'
          | 'category_colors';
        rowId?: string;
        op: 'upsert' | 'delete' | 'restore';
        payload?: Record<string, unknown>;
      }) => Promise<string>;
      sync: () => Promise<void>;
      size: () => Promise<number>;
      pending: () => Promise<
        Array<{
          id: string;
          table: string;
          rowId: string;
          op: string;
          payload: Record<string, unknown>;
        }>
      >;
      startSync: () => () => void;
      persistStatus: () => 'granted' | 'denied' | 'unsupported' | null;
      debugPatchOutbox: (id: string, patch: Record<string, unknown>) => Promise<number>;
      debugPatchRecord: (
        table: string,
        id: string,
        patch: Record<string, unknown>,
      ) => Promise<number>;
      debugDeleteRecord: (table: string, id: string) => Promise<void>;
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
      writeJournalEntry: (
        entryDate: string,
        ciphertext: number[],
        nonce: number[],
      ) => Promise<string>;
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
      ensureJournalHabit: () => Promise<void>;
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
      // issue #518: journal_keys first-setup race.
      debugCompetingSetup: (passphrase: string) => Promise<void>;
      debugJournalKeyStash: () => Promise<
        Array<{ id: string; envelope: unknown; recoveryEnvelope?: unknown; capturedAt: string }>
      >;
      journalRecoverOrphaned: (secret: string, useRecoveryKey: boolean) => Promise<number>;
      // issue #560: ICS-Abo (ADR-0022).
      addIcsSubscription: (url: string, name: string) => Promise<string>;
      refreshIcsSubscriptions: () => Promise<void>;
    };
  }
}
