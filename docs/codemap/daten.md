# Code-Karte: DB, Sync, Krypto, Auth, Module, Push

## src/db

- `schema.ts` — Drizzle-Schema, einzige Quelle der Wahrheit fürs Datenmodell
- `sync-tables.ts` / `sync-lock.ts` — Sync-Felder je Tabelle + Advisory-Lock
- `index.ts` / `migrate.ts` — DB-Verbindung + wendet Migrationen an
- `migrations/` — generierte Migrationen + Down-Pfad, nie von Hand

## src/local

- `types.ts` — Vertrag zwischen Outbox und Sync-API
- `dexie.ts` — IndexedDB-Definition: outbox, records, meta, Sonderstores
- `outbox.ts` / `sync.ts` — Mutations-Queue je Schreiboperation + Push/Pull
- `conflict.ts` / `use-live-table.ts` — Konfliktregeln (Delete/Restore/Upsert) + Live-Query
- `push.ts` / `garmin-sync.ts` / `ics-fetch.ts` — einzige Stellen gegen push/garmin-sync/ics

## src/auth

- `session.ts` — opakes Session-Token (Hash in der DB), requireOwner()
- `session-cookie.ts` — nur SESSION_COOKIE, von `middleware.ts` im Edge-Runtime ladbar
- `webauthn.ts` — Challenges, Credentials, Recovery

## src/crypto

- `errors.ts` / `base64.ts` — Fehler ohne Klartext in der Message + Base64-Helfer
- `envelope.ts` — KEK+Hülle: DEK-Erzeugung und -Öffnung als AES-GCM
- `journal.ts` — Ver-/Entschlüsselung, Recovery-Neuausstellung, Envelope-Re-Export
- `__fixtures__/journal-vector.json` — Testvektor gegen unbemerkte Formatänderungen

## src/modules

- `registry.ts` / `module-sections.ts` — Modul-Registry + aktive Sektionen

## src/push

- `vapid.ts` / `send.ts` — VAPID, Versand an alle Abos, löscht ungültige
- `notification.ts` / `schedule.ts` — Payload-Logik + DST-sichere Slots
- `reminders/index.ts` / `reminder-kinds.ts` — Reminder-Registry + Kind-Metadaten
- `reminders/tasks-due.ts` / `habits-open.ts` / `interaction-limit.ts` — Aufgaben, Routinen, Ablauf
- `reminders/events-due.ts` — „15 Minuten vorher" pro Termin, ohne festen Slot
