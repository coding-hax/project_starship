# Architektur

## Stack

| Schicht          | Wahl                                   | Warum                                                  |
| ---------------- | -------------------------------------- | ------------------------------------------------------ |
| Framework        | Next.js (App Router) + TypeScript      | Frontend und API in einem Repo, ein Deploy             |
| UI               | Tailwind (shadcn/ui, Motion: nicht installiert) | Utility-CSS, eigene Komponenten (`src/ui/`) |
| Lokaler Speicher | IndexedDB via **Dexie**                | Wahrheit für die UI, offline-fähig                     |
| PWA              | **Serwist** (Service Worker, Manifest) | Home-Screen-Installation, Precaching, Web Push         |
| Server-DB        | **Postgres (Neon, EU-Region)**         | Sync-Ziel und Backup, Standard-SQL                     |
| ORM              | **Drizzle**                            | typsicher, leichte Migrationen, kein Vendor-Bezug      |
| Hosting          | **Vercel Hobby** (kostenlos, privat)   | 0 € laufende Kosten                                    |
| Hintergrundjobs  | **GitHub Actions Cron** (~alle 15 min) | umgeht die Cron-Limits des Hobby-Plans, kostenlos      |
| Auth             | **Passkey / WebAuthn**                 | Face ID auf dem iPhone, kein Passwort                  |
| Tests            | Vitest (Logik) + Playwright (E2E)      |                                                        |

**Portabilitätsregel:** keine Vercel- oder Neon-spezifischen Primitive.
Ein Umzug auf einen eigenen Server muss eine Konfigurations-, keine Umbauentscheidung sein.

## Local-first: das Herzstück

### Prinzip

```
UI  ──liest/schreibt──►  IndexedDB (Dexie)  ──►  Outbox-Queue  ──►  /api/sync  ──►  Postgres
                                ▲                                        │
                                └────────── Pull (changes since T) ◄─────┘
```

Die UI spricht **niemals** direkt mit der API. Jede Mutation:

1. schreibt sofort nach IndexedDB (UI aktualisiert sich instant),
2. legt einen Eintrag in die Outbox,
3. die Outbox wird abgearbeitet, sobald Netz da ist.

### Konfliktauflösung

Pro Konto ein Mensch mit zwei bis drei Geräten → **kein CRDT nötig.**
**Neueste Ankunft am Server gewinnt** — eine globale, server-monotone Sequenz
(`sync_seq`), nicht die Client-Uhr, entscheidet einen Konflikt (ADR-0008).
`updated_at` bleibt Anzeige/Tiebreaker, ist aber nicht mehr Autorität: ein
verstelltes Gerätedatum kann eine Mutation weder fälschlich als „veraltet"
ablehnen noch eine fremde beim Pull überspringen. Ein Konflikt (eine Mutation
überschreibt eine noch nicht gesehene fremde Änderung) wird protokolliert,
nie still verworfen — die Mutation wird trotzdem angewandt. Löschen schlägt
ein Feld-Update immer, in beiden Ankunftsreihenfolgen (`src/local/conflict.ts`).

### Pflicht-Spalten für jede synchronisierte Tabelle

Die Sequenz `sync_seq` bleibt **eine** für alle Konten (ADR-0031): der Pull filtert
auf `user_id`, ein Konto sieht also Lücken in der Nummernfolge. Das ist harmlos,
weil der Cursor nur „höher als" vergleicht und nie Lückenlosigkeit voraussetzt.

| Spalte        | Zweck                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------ |
| `id` (UUIDv7) | clientseitig erzeugt, damit Offline-Anlage ohne Server-Roundtrip geht; zeitlich sortierbar |
| `updated_at`  | Anzeige/Tiebreaker — nicht mehr die Konflikt-Autorität (ADR-0008)                          |
| `deleted_at`  | **Soft Delete** — harte Löschung würde beim Sync „wiederauferstehen"                       |
| `synced_at`   | lokal: wurde erfolgreich übertragen                                                        |
| `sync_seq`    | server-monotone Ankunftsreihenfolge, die Konflikt-Autorität (ADR-0008)                     |
| `user_id`     | das besitzende Konto (ADR-0031) — Teil des Primärschlüssels, nicht nur Filterspalte        |

### Down-Migrationen

`pnpm db:generate` erzeugt nur den Up-Pfad; `drizzle-kit` kennt keine Downs. Ab
Migration `0008` (issue #186) liegt zu jeder Migration mit Rückweg eine Datei unter
`src/db/migrations/down/`, die **von Hand** angewendet wird — nichts führt sie
automatisch aus.

### Sync-Ablauf

- **Push:** Outbox der Reihe nach an `POST /api/sync/push`. Idempotent über die Client-`id`.
  Jede Mutation trägt `baseSeq` (die `sync_seq`, auf der sie fußt); der Server vergibt beim
  Schreiben `nextval('sync_seq')`, serialisiert über `pg_advisory_xact_lock`.
- **Pull:** `GET /api/sync/pull?since=<sync_seq>` liefert alle Änderungen mit höherer Sequenz.
- **Wann:** beim App-Start, beim Foreground (`visibilitychange`), nach jeder Mutation (debounced), sowie beim Wiedererlangen von Konnektivität (`online`-Event).
- **iOS-Realität:** Background Sync existiert auf iOS nicht. Es wird ausschließlich synchronisiert, wenn die App im Vordergrund ist. Das ist akzeptiert.

## Datenmodell (Skizze)

```
tasks           id, title, notes, due_at, priority, completed_at, recurrence_rule, ...
events          id, title, location, starts_at, ends_at, all_day, recurrence_rule, ...
journal_entries id, entry_date, ciphertext, nonce, ...   ← Text, Stimmung UND Tags im Chiffrat (ADR-0004)
habits          id, name, schedule (daily|weekly|custom), color, emoji, archived_at, ...
                ← `color` bleibt in Schema/Daten stehen, wird seit #1101 aber nicht mehr gelesen
habit_logs      id, habit_id, log_date, done, ...
sync_state      key, value            ← letzter Pull-Cursor (sync_seq) etc.
```

Alle Tabellen tragen die fünf Pflicht-Spalten oben. Die Auth-Tabellen
synchronisieren nie und tragen deshalb keine.
Es gibt **keine** Felder für externe Kalender (`external_uid`, `etag`, `calendar_links`) —
die App ist die alleinige Wahrheit für ihre Termine (siehe ADR-0002).

## Journal: Ende-zu-Ende-Verschlüsselung

- Schlüssel wird aus einer Passphrase abgeleitet (Argon2id oder PBKDF2 via WebCrypto),
  liegt **nur** auf dem Gerät. Der Server bekommt ihn nie.
- Verschlüsselung: AES-GCM über WebCrypto. Gespeichert werden `ciphertext` + `nonce`.
- **Folge:** keine serverseitige Suche über Journal-Inhalte. Das ist kein Verlust —
  die Suche läuft ohnehin lokal über IndexedDB.
- **Folge:** Passphrase verloren = Journal verloren. Recovery-Key wird beim Einrichten
  einmalig angezeigt und muss in den Passwortmanager.
- **Stimmung und Tags sind mitverschlüsselt** (ADR-0004). Sie liegen gemeinsam mit dem
  Text in **einem** Chiffrat — nicht in eigenen verschlüsselten Spalten, sonst erzeugt
  derselbe Tag denselben Chiffretext und der Server kann über Häufigkeiten Rückschlüsse
  ziehen. Nur `entry_date` bleibt im Klartext, weil der inkrementelle Sync es braucht.
- **Folge:** keine serverseitige Filterung oder Aggregation über Journalinhalte.
  Bewusst akzeptiert — in einer Local-first-App läuft ohnehin jede Abfrage lokal.

## Kalender: kein externer Sync

Die App ist die **alleinige Wahrheit** für ihre Termine. Es gibt keinen Sync mit iCloud
oder Google (ADR-0002). Konsequenzen für die Architektur:

- Kein CalDAV, kein `tsdav`, kein app-spezifisches Apple-Passwort auf dem Server.
- Keine externen Identitäten (`external_uid`, `etag`) am Event, keine Mapping-Tabelle,
  kein Loop-Schutz, keine Polling-Jobs für Kalender.
- **Serientermine** werden trotzdem gebraucht, aber in einfacher Form: täglich / wöchentlich /
  monatlich mit optionalem Enddatum. Kein vollständiger RRULE-Sprachumfang; einzelne
  Vorkommen lassen sich per `event_exceptions`-Tabelle verschieben/absagen (`recurrence.ts`),
  nicht per RFC-5545-Syntax. `EXDATE` liest nur der `.ics`-Import (`ics-parse.ts`);
  `RECURRENCE-ID` kommt im Code nicht vor.
- `.ics`-Export der eigenen Termine ist (noch) nicht gebaut (siehe unten), kein Sync-Ersatz.

Der GitHub-Actions-Cron läuft für terminierte Web-Push-Erinnerungen (`reminders.yml`);
ein Backup-Cron ist (Stand heute) nicht angelegt, siehe unten.

## Security

- **Auth:** Passkey (WebAuthn). Recovery-Code als Fallback.
- **Session:** httpOnly, Secure, SameSite=Lax, lange Laufzeit (Ziel: nie manuell einloggen).
- **Autorisierung:** Mehrbenutzer seit ADR-0031. `requireUser()` liest die `user_id`
  **aus der Sitzungszeile** — keine Env-Variable, kein zweiter Pfad in die Daten.
  Ohne Sitzung `401`, bei gesetztem `users.blocked_at` `403 blocked` (der Client muss
  Sperre und Abmeldung unterscheiden können).
- **Mandantentrennung:** jede synchronisierte Tabelle trägt `user_id` und hat
  `(user_id, id)` als Primärschlüssel; Referenzen zwischen ihnen sind zusammengesetzt.
  Eine Zeile, die auf ein fremdes Konto zeigt, scheitert damit **an der Datenbank**,
  nicht an Sorgfalt im Code. `scripts/check-tenant-isolation.sh` ist Required Check.
- **Rate Limiting** auf Auth- und Sync-Endpoints.
- **Header:** CSP (strikt, keine Inline-Skripte), HSTS, `X-Content-Type-Options`, Referrer-Policy.
- **Secrets** ausschließlich in Vercel-Env-Variablen. Nie im Repo, nie im Client-Bundle.

## Backup & Export

- „Alles exportieren" (`src/features/export/`): vollständiger JSON-Dump aller
  IndexedDB-Datensätze inkl. Tombstones. Kein `.ics`-, kein Markdown-Export.
- Nächtliches `pg_dump`-Backup per GitHub Action ist **Absicht, nicht umgesetzt** —
  `.github/workflows/` hat heute keinen Backup-Workflow, keine dafür nötigen Secrets.

## Umgebungen

| Env        | Zweck                                                        |
| ---------- | ------------------------------------------------------------ |
| lokal      | `pnpm dev` gegen lokale Postgres in Docker                   |
| Preview    | jeder PR bekommt eine Vercel-Preview + eigene Neon-Branch-DB |
| Produktion | `main` → Vercel Production                                   |
