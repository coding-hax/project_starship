# Code-Karte: DB, Sync, Krypto, Auth, Module, Push

## src/db

- `schema.ts` — Drizzle-Schema, einzige Quelle der Wahrheit; users-Tabelle, Mandanten-PK
- `sync-tables.ts` / `sync-lock.ts` / `sync-counters.ts` — Felder, Lock, Zähler
- `index.ts` / `migrate.ts` — DB-Verbindung, Migrationen anwenden
- `migrations/` — generierte Migrationen, nie von Hand
- `migrations/down/` — Down-Pfad je Migration
- `storage-quota.ts` — Speicherlimit je Konto, Default/Override, fail-open

## src/local

- `types.ts` — Vertrag zwischen Outbox und Sync-API
- `dexie.ts` — IndexedDB: outbox, records, meta, Sonderstores
- `outbox.ts` / `sync.ts` — Mutations-Queue + Push/Pull
- `conflict.ts` / `use-live-table.ts` — Konfliktregeln (Delete/Restore/Upsert) + Live-Query
- `push.ts` / `ics-fetch.ts` — einzige Stellen gegen push/ics

## src/auth

- `session.ts` / `auth-response.ts` / `device-cookie.ts` — Session-Token+requireUser()/requireAdmin(); 401/403/404; Geräte-Etikett
- `activity.ts` — last_seen_at/user_activity_days, 1×/h (requireUser)
- `session-cookie.ts` — nur SESSION_COOKIE, von `middleware.ts` Edge-Runtime-ladbar
- `webauthn.ts` / `rate-limit.ts` — Challenges/Credentials/Recovery; Fixed-Window, fail-open bei DB-Fehler
- `invite.ts` — Einladungs-Tokens: erzeugen, prüfen, einmalig einlösen

## src/crypto

- `errors.ts` / `base64.ts` — Fehler ohne Klartext + Base64-Helfer
- `envelope.ts` / `journal.ts` / `__fixtures__/journal-vector.json` — KEK-Hülle (AES-GCM); Ver-/Entschlüsselung, Recovery, Re-Export; Testvektor Formatdrift

## src/modules

- `registry.ts` / `module-sections.ts` — Modul-Registry + aktive Sektionen

## src/push

- `vapid.ts` / `send.ts` / `notification.ts` / `schedule.ts` — VAPID+Versand (löscht ungültige); Payload-Logik, DST-Slots
- `reminders/{index,tasks-due,habits-open,interaction-limit,events-due,reminder-kinds}.ts` — Registry+Kind-Metadaten; Aufgaben/Routinen/Ablauf; 15-Min.-Vorlauf je Termin
