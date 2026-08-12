import Dexie, { type EntityTable } from 'dexie';
import type { OutboxEntry, SyncTable } from './types';

/**
 * A row as it lives on the client. IndexedDB is the truth the UI reads from —
 * the API is never queried directly (CLAUDE.md rule 8).
 *
 * M0 keeps one generic store keyed by [table+id]. When the first real entity lands
 * in M1 it gets its own typed Dexie table; this store stays as the sync substrate.
 */
export interface LocalRecord {
  table: SyncTable;
  id: string;
  updatedAt: string;
  deletedAt: string | null;
  /** Set once the row has been confirmed by the server. Null while still in flight. */
  syncedAt: string | null;
  /**
   * The server's `sync_seq` for this row version (ADR-0008). Null until the first
   * pull confirms it — a row created locally and not yet pulled back has none yet.
   * Drives the pull merge (supersedes an `updatedAt` comparison) and becomes the
   * next mutation's `baseSeq`.
   */
  syncSeq: number | null;
  data: Record<string, unknown>;
}

export interface MetaEntry {
  key: string;
  value: unknown;
}

/** One hour of a `WeatherDay.hours` array (issue #156) — Open-Meteo's hourly block,
 * filtered down to the local calendar day it belongs to. */
export interface WeatherHour {
  /** Local ISO instant without offset, `YYYY-MM-DDTHH:mm`. */
  time: string;
  temperature: number;
  precipitationProbability: number;
  /** Millimeters. */
  precipitation: number;
}

/** One day of `WeatherCacheEntry.days` — see there for why this store exists. */
export interface WeatherDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  /** WMO weather code (Open-Meteo `daily.weather_code`) — see wmo-icon.ts for the icon mapping. */
  weatherCode: number;
  tempMax: number;
  tempMin: number;
  precipitationProbability: number;
  /** Local ISO instants, same "no offset" shape as `WeatherHour.time` (issue #156). */
  sunrise: string;
  sunset: string;
  windSpeedMax: number;
  windGustsMax: number;
  /** 24 entries, one per hour of this day (issue #156) — the day detail page's
   * temperature curve/precipitation. Same Open-Meteo call as the daily block, no
   * second endpoint (ADR-0009, CLAUDE.md Regel 8). */
  hours: WeatherHour[];
}

/**
 * The 7-day Bonn forecast (issue #139), its own store deliberately separate from
 * `records`: it is public third-party data, not user content, so it never goes
 * through the outbox and never reaches Postgres (ADR-0009). `key` is always
 * `WEATHER_CACHE_KEY` (weather-forecast.ts) — one row, since the location is
 * hard-coded.
 */
export interface WeatherCacheEntry {
  key: string;
  fetchedAt: string;
  days: WeatherDay[];
}

/**
 * The opt-in persisted DEK (issue #339, ADR-0016 AC5) — its own store, not `meta`,
 * so it can be wiped in isolation (`clearPersistedDek`) without touching the sync
 * cursor. `dek` is a non-extractable `CryptoKey`; IndexedDB's structured-clone
 * algorithm stores it directly, the raw key bytes never pass through JS.
 */
export interface JournalSessionEntry {
  id: string;
  dek: CryptoKey;
}

/**
 * A `journal_keys` envelope displaced by a foreign, newer one arriving on `pull()`
 * (issue #518) — the first-setup race two devices can hit offline: both mint a DEK
 * onto the same fixed row id, arrival-wins (ADR-0008) lets one win, and the loser's
 * envelope would otherwise vanish everywhere (client and server both overwrite it),
 * orphaning every entry it encrypted. Captured here, on this device only, before the
 * overwrite lands — never synced, the server has already discarded it too.
 * `envelope`/`recoveryEnvelope` are opaque (`unknown`): this store, like the sync
 * engine itself, never imports crypto runtime code.
 */
export interface JournalKeyStashEntry {
  id: string;
  envelope: unknown;
  recoveryEnvelope?: unknown;
  capturedAt: string;
}

/**
 * One already-expanded, all-day occurrence of a subscribed calendar's event
 * (issue #560, ADR-0022) — the parser/expander's output, never a raw `VEVENT`.
 * Dates are Berlin calendar days, `YYYY-MM-DD`, same shape as `EventView`'s
 * `startDate`/`endDate`. Getimte Termine (mit Uhrzeit/`TZID`) fallen beim
 * Parsen bereits heraus (ADR-0022 Entscheidung A), landen also nie hier.
 */
export interface SubscribedEvent {
  /** The `VEVENT`'s own `UID`, not unique across subscriptions — combined
   * with the subscription id and date for the view's row key (use-ics-subscriptions.ts). */
  uid: string;
  title: string;
  startDate: string;
  endDate: string;
}

/**
 * One `.ics` subscription (issue #560, ADR-0022): config (`url`/`name`) and
 * cache (`events`) in the same row, like `WeatherCacheEntry` — so a failed
 * refresh can update `lastError` alone without ever touching `events`. Read-
 * only external data, never synced (ADR-0009): not in `SYNC_TABLES`, never
 * in the outbox, never in Postgres.
 */
export interface IcsSubscriptionEntry {
  id: string;
  url: string;
  name: string;
  /** ISO instant of the last successful fetch, or `null` before the first one. */
  fetchedAt: string | null;
  /** The last fetch's failure, shown in the settings panel — cleared on the
   * next successful fetch. `events` below is untouched while this is set. */
  lastError: string | null;
  events: SubscribedEvent[];
}

const db = new Dexie('starship') as Dexie & {
  outbox: EntityTable<OutboxEntry, 'id'>;
  records: EntityTable<LocalRecord, 'id'>;
  meta: EntityTable<MetaEntry, 'key'>;
  weather: EntityTable<WeatherCacheEntry, 'key'>;
  journalSession: EntityTable<JournalSessionEntry, 'id'>;
  journalKeyStash: EntityTable<JournalKeyStashEntry, 'id'>;
  icsSubscriptions: EntityTable<IcsSubscriptionEntry, 'id'>;
};

db.version(1).stores({
  outbox: 'id, createdAt, table',
  records: '[table+id], table, updatedAt, syncedAt',
  meta: 'key',
});

// Additive: a new store, on its own version so existing installs migrate without
// touching the stores above (ADR-0009).
db.version(2).stores({
  weather: 'key',
});

// issue #244 adds `reminder_prefs` as a new `SyncTable` (src/local/types.ts), same as
// `garmin_activities` did in #186 — it lives in the generic `records` store above like
// every other synced table, discriminated by `table` alone. No new store, no new index,
// so no db.version() bump: Dexie versions the *index* schema, not which `table` values
// happen to show up in it.

// issue #156 grows `WeatherDay` (sunrise/sunset/wind/hours) but touches neither the
// store list nor its `key` index — Dexie versions the *index* schema, not the shape
// of what's stored under it, so no new db.version() is warranted here. An install
// still on the old shape simply has no `hours` until the next refresh; `refreshIfStale`
// replaces the whole cached row wholesale (never merges), so that self-heals within
// one REFRESH_INTERVAL_MS window without any migration step.

// issue #338 adds `journal_entries`/`journal_keys` as new `SyncTable`s (src/local/types.ts)
// living in the generic `records` store above, same reasoning as `reminder_prefs` — no
// version bump for those two.
db.version(3).stores({
  journalConflicts: 'id, entryDate',
});

// Additive: a new store for the opt-in persisted DEK (issue #339). Existing
// stores/rows are untouched, an upgrading install just gains an empty session store.
db.version(4).stores({
  journalSession: 'id',
});

// issue #433 adds `habit_freezes` as a new `SyncTable` (src/local/types.ts), same
// reasoning as `reminder_prefs`/`journal_entries` above — it lives in the generic
// `records` store, no new store or index, so no db.version() bump.

// issue #552 (S1 of #473) adds `events`/`event_exceptions` as new `SyncTable`s
// (src/local/types.ts), same reasoning as `reminder_prefs`/`habit_freezes` above —
// both live in the generic `records` store, discriminated by `table` alone, no new
// store or index, so no db.version() bump.

// Store removal (issue #477, ADR-0018): entry conflicts are structurally impossible
// since every journal entry is its own uuidv7 row with no edit path — the store has
// had no producer since #395 removed PRESERVE_DISPLACED. `null` is Dexie's way to
// drop a store on upgrade; the table was always empty, so no upgrading install loses
// data.
db.version(5).stores({
  journalConflicts: null,
});

// Additive: a new store for the displaced-envelope stash (issue #518). Existing
// stores/rows are untouched, an upgrading install just gains an empty stash — the
// down path is simply never writing to it, same as `journalSession` (v4) above.
db.version(6).stores({
  journalKeyStash: 'id, capturedAt',
});

// Additive: a new store for `.ics` subscriptions (issue #560, ADR-0022) — same
// reasoning as `weather` (v2)/`journalKeyStash` (v6) above: read-only external
// data, its own store, never in `records`/the outbox/Postgres. An upgrading
// install just gains an empty store, no data to migrate.
db.version(7).stores({
  icsSubscriptions: 'id',
});

// issue #660 adds `category_colors` as a new `SyncTable` (src/local/types.ts), same
// reasoning as `reminder_prefs`/`habit_freezes`/`events` above — it lives in the
// generic `records` store, discriminated by `table` alone, no new store or index,
// so no db.version() bump.

export { db };

/**
 * The pull cursor (ADR-0008): the highest `sync_seq` seen so far. A missing value
 * starts at `0`, i.e. a one-time full pull — unremarkable, since pull is idempotent
 * and the server is the truth.
 */
export const META_LAST_PULLED_SEQ = 'lastPulledSeq';

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await db.meta.get(key))?.value as T | undefined;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}
