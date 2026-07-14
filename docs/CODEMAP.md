# Code-Karte

**Zweck:** Diese Datei existiert, um Tokens zu sparen. Sie ist die Antwort auf
„wo liegt eigentlich…?", damit niemand — Mensch oder Agent — sich durch das Repo
grepen muss. Eine Zeile pro Datei oder Ordner, mehr nicht.

**Regel:** Wer eine Datei anlegt, verschiebt oder löscht, aktualisiert diese Karte
im selben PR. Eine veraltete Karte ist schlimmer als keine.

## Struktur

```
src/
  app/                      Next.js App Router — Routen und API-Endpunkte
    (app)/layout.tsx        Auth-Gate + App-Shell. Ohne Session -> /anmelden
    (app)/heute/            Dashboard          (leer bis M5)
    (app)/aufgaben/         Aufgaben           (leer bis M1)
    (app)/kalender/         Termine            (leer bis M2)
    (app)/journal/          Journal            (leer bis M3)
    anmelden/               Passkey: Einrichten, Anmelden, Recovery-Code
    offline/                Service-Worker-Fallback ohne Netz
    api/auth/               WebAuthn: register/login (options + verify), logout, status
    api/sync/               push/ und pull/ — die einzigen Wege zu den Daten
    layout.tsx              Root: Inter, Viewport, PWA-Metadaten (Apple + Manifest)
    manifest.ts             Web-App-Manifest (Next-Metadata-Route)
    sw.ts                   Service Worker (Serwist-Quelle) -> public/sw.js
    globals.css             Tailwind-Import + @theme-Mapping der Tokens
  db/
    schema.ts               Drizzle-Schema — EINZIGE Quelle der Wahrheit fürs Datenmodell
    sync-tables.ts          Welche Tabellen der Sync anfassen darf + Feld-Whitelist
    index.ts                DB-Verbindung (pg-Pool, Standard-Connection-String)
    migrate.ts              wendet Migrationen an (pnpm db:migrate)
    migrations/             generierte Migrationen, nie von Hand ändern
  local/
    types.ts                Vertrag zwischen Outbox und /api/sync (beide Seiten)
    dexie.ts                IndexedDB-Definition (outbox, records, meta)
    outbox.ts               Mutations-Queue — JEDE Schreiboperation läuft hier durch
    sync.ts                 Push/Pull, Last-Write-Wins, Trigger (Start/Foreground/online)
  auth/
    session.ts              Opakes Session-Token (nur als Hash in der DB), requireOwner()
    webauthn.ts             Challenges, Credentials, Recovery-Code
  crypto/                   (leer — Journal-Verschlüsselung kommt in M3)
  features/                 (leer — tasks/ events/ journal/ habits/ ab M1)
  ui/
    tokens.css              OKLCH-Farbtokens, hell + dunkel, Spacing, Motion
    shell.css               App-Shell: Bottom-Nav (mobil) / Sidebar (Desktop)
    nav.tsx                 Die vier Tabs
    sync-boot.tsx           startet den Sync beim Mount
    e2e-bridge.tsx          Griff auf die echte Outbox für Playwright (nur NEXT_PUBLIC_E2E=1)
tests/
  helpers.ts                virtueller Authenticator, DB-Zugriff, Reset
  shell.spec.ts             Login, vier Tabs, aktiver Tab
  sync.spec.ts              Outbox überlebt Reload, Tombstones, 401 ohne Session
scripts/
  claude-runner.sh          der autonome Runner (portabel: macOS + Linux)
  check-test-integrity.sh   Wächter gegen abgeschwächte Tests
  bootstrap-github.sh       einmaliges GitHub-Setup (Labels, Milestones, Branch-Schutz)
  launchd-setup.md          Runner als Dienst auf macOS
  systemd-setup.md          Runner als Dienst auf Linux
docs/                       Vision, Architektur, Design, Workflow, Token-Budget, ADRs
```

## Wo liegt was?

| Ich suche…                               | Datei                                           |
| ---------------------------------------- | ----------------------------------------------- |
| das Datenmodell                          | `src/db/schema.ts`                              |
| welche Felder ein Client schreiben darf  | `src/db/sync-tables.ts`                         |
| wie eine Änderung zum Server kommt       | `src/local/outbox.ts`, dann `src/local/sync.ts` |
| den Vertrag zwischen Client und Sync-API | `src/local/types.ts`                            |
| wer reindarf                             | `src/auth/session.ts` (`requireOwner`)          |
| Farben, Abstände, Motion                 | `src/ui/tokens.css` + `docs/DESIGN_SYSTEM.md`   |
| die Journal-Verschlüsselung              | `src/crypto/journal.ts` (ab M3)                 |
| warum etwas so entschieden wurde         | `docs/adr/`                                     |

## Wichtige Invarianten

- Kein Feature-Code spricht direkt mit `/api` — **immer** über `src/local/`.
- Keine Komponente benutzt Rohfarben — **immer** Tokens aus `src/ui/`.
- Kein Klartext des Journals verlässt `src/crypto/journal.ts`.
- Jede API-Route prüft `requireOwner()`. Es gibt keinen zweiten Pfad in die Daten.
- Jede synchronisierte Tabelle spreizt `syncColumns` aus `src/db/schema.ts`.
- Löschen ist **immer** ein Tombstone (`deleted_at`), nie ein `DELETE`.

## Bauen

`pnpm build` und `pnpm dev` laufen mit `--webpack`, **nicht** mit Turbopack.
Serwist ist ein Webpack-Plugin, Next 16 nimmt Turbopack als Standard, und die
Kombination bricht den Build (serwist#54). Nimmt man das Flag weg, verschwindet der
Service Worker und mit ihm die Installierbarkeit — ohne dass irgendetwas rot wird.
