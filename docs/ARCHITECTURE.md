# Architektur

## Stack

| Schicht          | Wahl                                   | Warum                                                  |
| ---------------- | -------------------------------------- | ------------------------------------------------------ |
| Framework        | Next.js (App Router) + TypeScript      | Frontend und API in einem Repo, ein Deploy             |
| UI               | Tailwind + shadcn/ui + Motion          | schnelle, konsistente Basis; Animationen ohne Eigenbau |
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

Ein Nutzer, maximal zwei bis drei Geräte → **kein CRDT nötig.**
Last-Write-Wins auf Feldebene über `updated_at` reicht. Konflikte sind hier ein Randfall,
kein Designproblem.

### Pflicht-Spalten für jede synchronisierte Tabelle

| Spalte        | Zweck                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------ |
| `id` (UUIDv7) | clientseitig erzeugt, damit Offline-Anlage ohne Server-Roundtrip geht; zeitlich sortierbar |
| `updated_at`  | Konfliktauflösung + inkrementeller Pull                                                    |
| `deleted_at`  | **Soft Delete** — harte Löschung würde beim Sync „wiederauferstehen"                       |
| `synced_at`   | lokal: wurde erfolgreich übertragen                                                        |

### Sync-Ablauf

- **Push:** Outbox der Reihe nach an `POST /api/sync/push`. Idempotent über die Client-`id`.
- **Pull:** `GET /api/sync/pull?since=<updated_at>` liefert alle Änderungen seit T.
- **Wann:** beim App-Start, beim Foreground (`visibilitychange`), nach jeder Mutation (debounced), sowie beim Wiedererlangen von Konnektivität (`online`-Event).
- **iOS-Realität:** Background Sync existiert auf iOS nicht. Es wird ausschließlich synchronisiert, wenn die App im Vordergrund ist. Das ist akzeptiert.

## Datenmodell (Skizze)

```
tasks           id, title, notes, due_at, priority, completed_at, recurrence_rule, ...
events          id, title, location, starts_at, ends_at, all_day, recurrence_rule, ...
journal_entries id, entry_date, ciphertext, nonce, ...   ← Text, Stimmung UND Tags im Chiffrat (ADR-0004)
habits          id, name, schedule (daily|weekly|custom), color, archived_at, ...
habit_logs      id, habit_id, log_date, done, ...
sync_state      key, value            ← letzter Pull-Zeitstempel etc.
```

Alle Tabellen tragen die vier Pflicht-Spalten oben.
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
  monatlich mit optionalem Enddatum. Kein vollständiger RRULE-Sprachumfang,
  keine `EXDATE`/`RECURRENCE-ID`-Ausnahmen (eigenes Ticket, falls es fehlt).
- **`.ics`-Export** bleibt Teil des Export-Features (siehe unten) — als Datenausgang,
  nicht als Sync.

Der GitHub-Actions-Cron bleibt trotzdem nötig: für Backups und für terminierte Web-Push-Erinnerungen.

## Security

- **Auth:** Passkey (WebAuthn). Recovery-Code als Fallback.
- **Session:** httpOnly, Secure, SameSite=Lax, lange Laufzeit (Ziel: nie manuell einloggen).
- **Autorisierung:** Single-User. Jede API-Route prüft die Session gegen `OWNER_USER_ID` aus der Env.
  Es gibt keinen zweiten Pfad in die Daten.
- **Rate Limiting** auf Auth- und Sync-Endpoints.
- **Header:** CSP (strikt, keine Inline-Skripte), HSTS, `X-Content-Type-Options`, Referrer-Policy.
- **Secrets** ausschließlich in Vercel-Env-Variablen. Nie im Repo, nie im Client-Bundle.

## Backup & Export

- Nightly `pg_dump` per GitHub Action → verschlüsselt (age/gpg) in ein privates Repo oder Object Storage.
- „Alles exportieren"-Button in der App: JSON (vollständig) + `.ics` (Termine) + Markdown (Journal, entschlüsselt, clientseitig erzeugt).
- Der Export ist ein Feature, kein Notfallwerkzeug: er wird in M1 gebaut und bleibt grün getestet.

## Umgebungen

| Env        | Zweck                                                        |
| ---------- | ------------------------------------------------------------ |
| lokal      | `pnpm dev` gegen lokale Postgres in Docker                   |
| Preview    | jeder PR bekommt eine Vercel-Preview + eigene Neon-Branch-DB |
| Produktion | `main` → Vercel Production                                   |
