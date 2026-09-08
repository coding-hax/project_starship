# Code-Karte

**Zweck:** Tokens sparen — eine Zeile pro Datei/Ordner, reine Struktur.
Beantwortet „wo liegt eigentlich…?", nicht „warum". Warum, Entscheidungen und
Issue-Historie gehören in `git blame`, ADR oder Ticket — nicht hierher.

**Eintragsregel** (`scripts/check-codemap.sh` erzwingt sie): eine Zeile je
Eintrag, höchstens 4 Backtick-Tokens, davon höchstens einer ohne Datei-Endung
— verbietet Funktions-/Signaturlisten. Kein `#<nr>`, `ADR-####`, `(S<n>)`,
`(T<n>)`. Neue/verschobene/gelöschte Dateien: passende Bereichskarte im
selben PR nachziehen.

## Routen-Grobstruktur

`src/app/(app)/`: Übersicht, Aufgaben, Kalender, Routinen, Aktivitäten, Wetter,
Journal, Einstellungen. Daneben `anmelden/`, `offline/`, `api/` (Auth, Sync,
Push, Garmin, ICS).

## Bereich → Datei

| Bereich | Datei |
| --- | --- |
| Routen & API | `docs/codemap/app.md` |
| DB, Sync/Outbox, Krypto, Auth, Module, Push | `docs/codemap/daten.md` |
| Design-System-Bausteine | `docs/codemap/ui.md` |
| Aufgaben + Erfassen | `docs/codemap/aufgaben-erfassen.md` |
| Kalender & Termine | `docs/codemap/kalender.md` |
| Journal | `docs/codemap/journal.md` |
| Routinen | `docs/codemap/routinen.md` |
| Wetter, Aktivitäten, Garmin | `docs/codemap/wetter-aktivitaeten.md` |
| Einstellungen, Export | `docs/codemap/einstellungen-export.md` |
| Playwright-Specs | `docs/codemap/tests.md` |
| Runner, CI, Workflows | `docs/codemap/scripts.md` |

## Wo liegt was?

| Ich suche… | Datei |
| --- | --- |
| das Datenmodell | `src/db/schema.ts` |
| welche Felder ein Client schreiben darf | `src/db/sync-tables.ts` |
| wie eine Änderung zum Server kommt | `src/local/outbox.ts`, dann `src/local/sync.ts` |
| der Sync-API-Vertrag | `src/local/types.ts` |
| wer reindarf | `src/auth/session.ts` (`requireOwner`) |
| Farben, Abstände, Motion | `src/ui/tokens.css` + `docs/DESIGN_SYSTEM.md` |
| wie ein Screen aus mehreren Live-Queries lädt | `src/ui/overview-ready.tsx` |
| die Journal-Verschlüsselung | `src/crypto/journal.ts` (+ `envelope.ts`) |
| warum etwas so entschieden wurde | `docs/adr/` |

## Wichtige Invarianten

- Kein Feature-Code spricht direkt mit `/api` — **immer** über `src/local/`.
- Keine Komponente benutzt Rohfarben — **immer** Tokens aus `src/ui/`.
- Kein Klartext des Journals verlässt `src/crypto/journal.ts`.
- Jede API-Route prüft `requireOwner()`. Es gibt keinen zweiten Pfad in die Daten.
- Jede synchronisierte Tabelle spreizt `syncColumns` aus `src/db/schema.ts`.
- Löschen ist **immer** ein Tombstone (`deleted_at`), nie ein `DELETE`.
- Der App-Router fokussiert je Navigation automatisch das erste Segment-Element
  — `page-transition.tsx` liegt deshalb über dem Router-Segment (nicht
  `template.tsx`); Seiten mit eigener Kopfzeile (`wetter/[datum]/page.tsx`)
  nutzen dafür `<header>`.

## Bauen

`pnpm build`/`pnpm dev` laufen mit `--webpack`, **nicht** Turbopack (Next 16s
Standard): Serwist ist ein Webpack-Plugin, die Kombination bricht sonst den
Build (serwist#54). Ohne das Flag verschwindet der Service Worker lautlos, ohne
roten Fehler.
