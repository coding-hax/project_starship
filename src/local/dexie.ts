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
 * A journal-entry version a pull displaced (ADR-0017 point 3, issue #338 AC6) — the
 * server applied a later write on top of one this device never saw. Content-blind,
 * like everything else in the sync/conflict layer: `ciphertext`/`nonce` are opaque
 * Base64, never decrypted here. Surfacing/resolving this in the journal UI is S3b.
 */
export interface JournalConflict {
  /** uuidv7, generated when the conflict is captured — independent of the row id. */
  id: string;
  entryDate: string;
  ciphertext: string;
  nonce: string;
  /** `syncSeq` of the displaced version, for display/ordering. */
  displacedSyncSeq: number | null;
  /** `updatedAt` of the displaced version. */
  updatedAt: string;
  /** When this device captured the conflict — distinct from `updatedAt` above. */
  capturedAt: string;
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

const db = new Dexie('starship') as Dexie & {
  outbox: EntityTable<OutboxEntry, 'id'>;
  records: EntityTable<LocalRecord, 'id'>;
  meta: EntityTable<MetaEntry, 'key'>;
  weather: EntityTable<WeatherCacheEntry, 'key'>;
  journalConflicts: EntityTable<JournalConflict, 'id'>;
  journalSession: EntityTable<JournalSessionEntry, 'id'>;
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
// version bump for those two. `journalConflicts` (ADR-0017 point 3) is a genuinely new
// store though, so it needs its own version: additive, existing stores/rows are
// untouched, an upgrading install just gains an empty conflicts table.
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
