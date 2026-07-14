# Code-Karte

**Zweck:** Diese Datei existiert, um Tokens zu sparen. Sie ist die Antwort auf
„wo liegt eigentlich…?", damit niemand — Mensch oder Agent — sich durch das Repo
grepen muss. Eine Zeile pro Datei oder Ordner, mehr nicht.

**Regel:** Wer eine Datei anlegt, verschiebt oder löscht, aktualisiert diese Karte
im selben PR. Eine veraltete Karte ist schlimmer als keine.

## Struktur

```
src/
  app/                    Next.js App Router — Routen und API-Endpunkte
    (app)/heute/          Dashboard
    (app)/aufgaben/       Aufgaben
    (app)/kalender/       Termine
    (app)/journal/        Journal (verschlüsselt)
    api/sync/             Push-/Pull-Endpunkte des Syncs
  db/
    schema.ts             Drizzle-Schema — EINZIGE Quelle der Wahrheit fürs Datenmodell
    migrations/           generierte Migrationen, nie von Hand ändern
  local/
    dexie.ts              IndexedDB-Definition (spiegelt schema.ts)
    outbox.ts             Mutations-Queue — JEDE Schreiboperation läuft hier durch
    sync.ts               Push/Pull, Last-Write-Wins
  crypto/
    journal.ts            AES-GCM, Schlüsselableitung — Klartext verlässt das Gerät nie
  features/
    tasks/                Aufgaben: Komponenten, Hooks, Logik
    events/               Termine
    journal/              Journal
    habits/               Gewohnheiten
  ui/                     Design-System-Komponenten (Tokens, Button, Sheet, …)
tests/
  *.spec.ts               Playwright, ein Spec pro Feature
scripts/
  claude-runner.sh        der autonome Runner
docs/                     Vision, Architektur, Design, Workflow, ADRs
```

## Wo liegt was?

| Ich suche… | Datei |
|---|---|
| das Datenmodell | `src/db/schema.ts` |
| wie eine Änderung zum Server kommt | `src/local/outbox.ts`, dann `src/local/sync.ts` |
| Farben, Abstände, Motion | `src/ui/tokens.css` + `docs/DESIGN_SYSTEM.md` |
| die Journal-Verschlüsselung | `src/crypto/journal.ts` |
| warum etwas so entschieden wurde | `docs/adr/` |

## Wichtige Invarianten

- Kein Feature-Code spricht direkt mit `/api` — **immer** über `src/local/`.
- Keine Komponente benutzt Rohfarben — **immer** Tokens aus `src/ui/`.
- Kein Klartext des Journals verlässt `src/crypto/journal.ts`.
