# Code-Karte: DB, Sync, Krypto, Auth, Module, Push

## src/db

- `schema.ts` — Drizzle-Schema, einzige Quelle der Wahrheit
- `sync-tables.ts` / `sync-lock.ts` — Sync-Felder je Tabelle + Advisory-Lock
- `index.ts` / `migrate.ts` — DB-Verbindung, Migrationen anwenden
- `migrations/` — generierte Migrationen, nie von Hand
- `migrations/down/` — Down-Pfad je Migration

## src/local

- `types.ts` — Vertrag zwischen Outbox und Sync-API
- `dexie.ts` — IndexedDB: outbox, records, meta, Sonderstores
- `outbox.ts` / `sync.ts` — Mutations-Queue + Push/Pull
- `conflict.ts` / `use-live-table.ts` — Konfliktregeln (Delete/Restore/Upsert) + Live-Query
- `push.ts` / `garmin-sync.ts` / `ics-fetch.ts` — einzige Stellen gegen push/garmin-sync/ics

## src/auth

- `session.ts` / `device-cookie.ts` — Session-Token (Hash in DB), requireOwner(); Geräte-Etikett
- `session-cookie.ts` — nur SESSION_COOKIE, von `middleware.ts` Edge-Runtime-ladbar
- `webauthn.ts` / `rate-limit.ts` — Challenges/Credentials/Recovery; Fixed-Window-Limit, fail-open bei DB-Fehler

## src/crypto

- `errors.ts` / `base64.ts` — Fehler ohne Klartext + Base64-Helfer
- `envelope.ts` / `journal.ts` / `__fixtures__/journal-vector.json` — KEK-Hülle (AES-GCM); Ver-/Entschlüsselung, Recovery, Re-Export; Testvektor Formatdrift

## src/modules

- `registry.ts` / `module-sections.ts` — Modul-Registry + aktive Sektionen

## src/push

- `vapid.ts` / `send.ts` / `notification.ts` / `schedule.ts` — VAPID+Versand (löscht ungültige); Payload-Logik, DST-Slots
- `reminders/{index,tasks-due,habits-open,interaction-limit,events-due,reminder-kinds}.ts` — Registry+Kind-Metadaten; Aufgaben/Routinen/Ablauf; „15 Min. vorher" je Termin
