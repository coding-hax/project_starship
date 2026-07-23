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

/** One day of `WeatherCacheEntry.days` — see there for why this store exists. */
export interface WeatherDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  /** WMO weather code (Open-Meteo `daily.weather_code`) — see wmo-icon.ts for the icon mapping. */
  weatherCode: number;
  tempMax: number;
  tempMin: number;
  precipitationProbability: number;
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

const db = new Dexie('starship') as Dexie & {
  outbox: EntityTable<OutboxEntry, 'id'>;
  records: EntityTable<LocalRecord, 'id'>;
  meta: EntityTable<MetaEntry, 'key'>;
  weather: EntityTable<WeatherCacheEntry, 'key'>;
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
