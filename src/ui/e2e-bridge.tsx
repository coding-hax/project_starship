'use client';

import { useEffect } from 'react';
import { uuidv7 } from 'uuidv7';
import { bytesToBase64 } from '@/crypto/base64';
import { createEnvelope, openEnvelope, type Envelope, type KdfParams } from '@/crypto/envelope';
import { encryptJournal, type JournalContent } from '@/crypto/journal';
import { refreshStaleSubscriptions } from '@/features/events/use-ics-subscriptions';
import { getPersistedDek } from '@/features/journal/dek-session';
import {
  debugCompetingSetup,
  journalLock,
  journalLockSnapshot,
  journalRecoverOrphaned,
  journalSetup,
  journalUnlock,
} from '@/features/journal/lock-store';
import { appendJournalEntry, deleteJournalEntry, listJournalEntries } from '@/features/journal/entry';
import { ensureJournalHabit } from '@/features/journal/journal-habit';
import { debugDecryptRunCount } from '@/features/journal/journal-search-cache';
import { listJournalKeyStash } from '@/features/journal/journal-key-stash';
import { writeJournalEntry } from '@/features/journal/write';
import { DEFAULT_WEATHER_LOCATION } from '@/features/settings/use-weather-location';
import { weatherCacheKey } from '@/features/weather/forecast';
import { db, type WeatherDay } from '@/local/dexie';
import { mutate, pending, size } from '@/local/outbox';
import { startSync, sync } from '@/local/sync';
import { getStoragePersistenceStatus } from './persist-storage';

/**
 * A handle on the real outbox for the E2E suite.
 *
 * M0 has no feature UI yet, so there is nothing that can write a mutation — but the
 * acceptance criterion ("outbox takes a mutation, survives a reload, reaches Postgres")
 * has to be tested against the real thing, not a mock. This exposes the actual
 * outbox and sync functions, the same ones the tasks UI will call in M1.
 *
 * Only rendered when NEXT_PUBLIC_E2E=1, which is set by the Playwright web server
 * and by nothing else. It is not in the production bundle.
 */
export function E2EBridge() {
  useEffect(() => {
    Object.assign(window, {
      __starship: {
        mutate,
        sync,
        pending,
        size,
        startSync,
        persistStatus: getStoragePersistenceStatus,
        debugRecords: () => db.records.toArray(),
        debugMeta: () => db.meta.toArray(),
        // Every JSON-serializable store in one string (issue #341 AC2) — the search
        // session cache lives only in React state, so a plaintext leak into any
        // store, not just `records`, would show up here as a substring match.
        // `journalSession` holds a CryptoKey, not text, and is left out on purpose.
        debugDumpStores: async () => {
          const [outbox, records, meta, weather, journalKeyStash, icsSubscriptions] = await Promise.all([
            db.outbox.toArray(),
            db.records.toArray(),
            db.meta.toArray(),
            db.weather.toArray(),
            db.journalKeyStash.toArray(),
            db.icsSubscriptions.toArray(),
          ]);
          return JSON.stringify({ outbox, records, meta, weather, journalKeyStash, icsSubscriptions });
        },
        // issue #560: seeds a subscription row directly (mirrors the settings
        // panel's own write), without triggering a refresh — specs call
        // refreshIcsSubscriptions() themselves as a separate step, after setting
        // up their own `page.route('**/api/ics*', ...)` mock (or, for the SSRF
        // spec, deliberately without one, so the real proxy route runs).
        addIcsSubscription: (url: string, name: string) =>
          db.icsSubscriptions.put({ id: uuidv7(), url, name, fetchedAt: null, lastError: null, events: [] }),
        refreshIcsSubscriptions: () => refreshStaleSubscriptions(),
        // issue #870 (Endabgleich): writes straight into the forecast cache instead
        // of going through a mocked fetch. `useWeatherForecast` only ever fetches
        // once per run — the cache row it writes never goes stale again under a
        // frozen clock (REFRESH_INTERVAL_MS) — so a spec that needs the day route's
        // real data has no later hook to hang a route-mock swap on. Writing the row
        // directly sidesteps that, and — unlike swapping the network mock before the
        // first /uebersicht mount — never touches what the overview's own forecast
        // strip renders earlier in the same run.
        debugSeedWeather: (days: WeatherDay[]) =>
          db.weather.put({
            key: weatherCacheKey(DEFAULT_WEATHER_LOCATION.latitude, DEFAULT_WEATHER_LOCATION.longitude),
            fetchedAt: new Date().toISOString(),
            days,
          }),
        // The real write path (AC5) — the suite drives writeJournalEntry itself
        // rather than re-deriving row ids in the test. createEnvelope/openEnvelope/
        // encryptJournal let AC7 prove the offline row that reaches Postgres is
        // real ciphertext, not a stand-in — the CryptoKey a call returns only ever
        // travels to the next call inside the same page.evaluate, never back
        // across the Node/browser boundary.
        writeJournalEntry: (entryDate: string, ciphertext: number[], nonce: number[]) =>
          writeJournalEntry(entryDate, {
            ciphertext: new Uint8Array(ciphertext),
            nonce: new Uint8Array(nonce),
          }),
        // Seeds a real, decryptable entry for a given day under the actual unlocked
        // session's DEK — the same call the editor itself makes (issue #341's
        // search suite needs several days of real content, not raw filler bytes).
        appendJournalEntry: (entryDate: string, content: JournalContent) =>
          appendJournalEntry(entryDate, content),
        // Lets specs settle the boot-time Journal-habit creation (issue #505 AC1)
        // deterministically instead of racing `JournalHabitBoot`'s own async effect —
        // see `settleJournalHabitBoot` in tests/helpers.ts.
        ensureJournalHabit: () => ensureJournalHabit(),
        listJournalEntries: (entryDate: string) => listJournalEntries(entryDate),
        deleteJournalEntry: (id: string) => deleteJournalEntry(id),
        // issue #1049 AK6: number of session-cache decrypt passes since load —
        // "An diesem Tag" must not add a third one to the two already running
        // (the day card's own grouping hook, the search/year-list's shared hook).
        debugJournalDecryptRunCount: () => debugDecryptRunCount(),
        bytesToBase64: (bytes: number[]) => bytesToBase64(new Uint8Array(bytes)),
        createEnvelope: (passphrase: string, kdfParamsOverride?: Omit<KdfParams, 'salt'>) =>
          createEnvelope(passphrase, kdfParamsOverride),
        openEnvelope: (envelope: Envelope, passphrase: string) => openEnvelope(envelope, passphrase),
        encryptJournal: async (dek: CryptoKey, content: JournalContent) => {
          const { ciphertext, nonce } = await encryptJournal(dek, content);
          return { ciphertext: Array.from(ciphertext), nonce: Array.from(nonce) };
        },
        // Wire-format corruption (a bad payload from an old client build, storage
        // damage) is not something `mutate()` can produce itself — this is the only
        // way to reproduce a poison mutation for the #182 tests.
        debugPatchOutbox: (id: string, patch: Record<string, unknown>) =>
          db.outbox.update(id, patch),
        // Simulates a server-side ciphertext swap between two already-synced rows
        // (issue #480, F7 AC2) — something no client call can produce, only direct
        // storage tampering. `records` is keyed by `[table+id]`, not `id` alone;
        // the patched fields (ciphertext/nonce) live under `data`, not top-level,
        // so this merges into the existing `data` rather than shadowing it.
        debugPatchRecord: async (table: string, id: string, patch: Record<string, unknown>) => {
          const key = [table, id] as never;
          const row = await db.records.get(key);
          if (!row) return 0;
          return db.records.update(key, { data: { ...row.data, ...patch } });
        },
        // Removes a row through Dexie's own already-open connection (issue #650
        // Fund, modules.spec.ts AC7) — raw `indexedDB.deleteDatabase`/`.open` races
        // Dexie's versionchange handler instead (see journal.spec.ts AC3), so specs
        // that need a genuinely empty local slate go through the app's own db.
        debugDeleteRecord: (table: string, id: string) => db.records.delete([table, id] as never),
        // Drives the real lock-store state machine (issue #339) rather than a
        // test double — journalUnlock resolves 'ok'/'wrong' from the state it
        // actually landed in, never from the thrown error's message.
        journalSetup: (passphrase: string) => journalSetup(passphrase),
        journalUnlock: async (passphrase: string) => {
          await journalUnlock(passphrase);
          return journalLockSnapshot().state === 'unlocked' ? 'ok' : 'wrong';
        },
        journalLock: () => journalLock(),
        journalLockState: () => journalLockSnapshot().state,
        // Simulates the losing side of a first-setup race (issue #518): a fresh
        // envelope written straight onto the fixed key row, bypassing the
        // "already set up" guard the real journalSetup has — see debugCompetingSetup's
        // own doc comment in lock-store.ts for why the bypass is the point here.
        debugCompetingSetup: (passphrase: string) => debugCompetingSetup(passphrase),
        debugJournalKeyStash: () => listJournalKeyStash(),
        journalRecoverOrphaned: (secret: string, useRecoveryKey: boolean) =>
          journalRecoverOrphaned(secret, useRecoveryKey),
        journalHasPersistedDek: () => getPersistedDek().then((dek) => dek !== null),
        // Proves AC5's "non-extractable" half: exportKey on the persisted DEK
        // must throw, never that it merely wasn't asked to export.
        journalPersistedDekExtractable: async () => {
          const key = await getPersistedDek();
          if (!key) return null;
          try {
            await crypto.subtle.exportKey('raw', key);
            return true;
          } catch {
            return false;
          }
        },
      },
    });
  }, []);

  return null;
}
