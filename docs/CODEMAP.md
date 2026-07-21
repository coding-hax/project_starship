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
    (app)/heute/            Dashboard          (Klammer — wächst ab M1 je Milestone mit)
    (app)/heute/gewohnheiten/ page.tsx         Gewohnheiten-Verwaltung (issue #102) — kein eigener Tab, Einstieg über Heute
    (app)/heute/heute.css   Link „Gewohnheiten verwalten" (issue #102)
    (app)/aufgaben/         Aufgaben           (leer bis M1)
    (app)/kalender/         Termine            (leer bis M5)
    (app)/journal/          Journal            (leer bis M4)
    (app)/einstellungen/    Einstellungen — Darstellung (AppearancePanel) + Spracherfassung (CapturePanel) + Export-Button
    anmelden/               Passkey: Einrichten, Anmelden, Recovery-Code
    offline/                Service-Worker-Fallback ohne Netz
    api/auth/               WebAuthn: register/login (options + verify), logout, status
    api/sync/               push/ und pull/ — die einzigen Wege zu den Daten
    api/health/             SELECT 1 + Versions-SHA, ungeschützt — Ziel des Post-Deploy-Smoke
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
    sync.ts                 Push/Pull, Trigger (Start/Foreground/online), Cursor = sync_seq
    conflict.ts             reine Konfliktregeln: Delete/Restore/Upsert, Overwrite-Flag, Pull-Cursor (ADR-0008)
  auth/
    session.ts              Opakes Session-Token (nur als Hash in der DB), requireOwner()
    webauthn.ts             Challenges, Credentials, Recovery-Code
  crypto/                   (leer — Journal-Verschlüsselung kommt in M4)
  features/
    tasks/
      task-list.tsx          Aufgabenliste — liest via use-tasks.ts, nie per fetch; chat-artiger Scroll-Anker aufs älteste offene Todo (issue #88); gruppiert via groupTasks (issue #89), löst Drag-Drop über resolveNestTarget auf
      task-item.tsx           eine Zeile: Checkbox, Tap öffnet Editor, Swipe rechts/links (erledigen/löschen); Eltern-Zeile mit Disclosure + Fortschritt, Long-Press hebt ein Blatt fürs Drag-to-Nest an (issue #89)
      use-tasks.ts            Dexie-Live-Query auf `records` (table='tasks'), Sortierung strikt nach createdAt (issue #88); groupTasks (eine Ebene Eltern/Kind) + resolveNestTarget (issue #89)
      use-complete-task.ts    toggelt completedAt, hält den Undo-Zustand fürs Toast
      use-delete-task.ts      Tombstone per Swipe, Undo via outbox-Op `restore`; löscht die Kinder eines Elterns mit, Undo stellt beide wieder her (issue #89)
      task-editor.tsx         Bottom-Sheet: Titel/Notiz/Fälligkeit/Priorität, sendet nur geänderte Felder; „Unteraufgabe von"-Feld als deterministischer Zweitpfad zum Drag-to-Nest (issue #89)
      task-editor.css         Styles fürs Editor-Sheet
      task-list.css           Karten-, Checkbox-, Swipe- und Lösch-Bestätigungs-Styles
      quick-add.tsx           FAB + Sheet + Titelfeld, parst Freitext (parse-task-input), speichert via outbox.mutate()
      quick-add.css           Styles fürs Titelfeld + Speichern-Button im Sheet
      parse-task-input.ts     reiner Parser: Freitext -> { title, dueAt } (relative Tage, Wochentage, Datum, Uhrzeit)
      capture-confirm.tsx     Bestätigungs-Sheet für eine per Freitext erkannte Fälligkeit (issue #47 AC1)
      capture-confirm.css     Styles fürs Bestätigungs-Sheet, Summary mit tabular-nums
    events/ journal/          (leer, ab M3/M4)
    habits/
      use-habits.ts            Dexie-Live-Query auf `records` (table='habits'); HabitView + toHabitView (issue #102)
      use-habit-logs.ts        Dexie-Live-Query auf `records` (table='habit_logs'); HabitLogView + toHabitLogView (issue #103)
      use-toggle-habit-log.ts  Abhaken/Zurücknehmen für heute via Outbox, findet die bestehende Log-Zeile statt UNIQUE(habit_id, log_date) zu riskieren (issue #103)
      due-today.ts             reine Logik: welche Habits gehören in die Heute-Sektion (daily immer, weekly noch nicht in der laufenden Mo–So-Woche erledigt) (issue #103)
      streak.ts                reine Logik: computeStreak — aufeinanderfolgende Tage (daily/custom) bzw. Mo–So-Wochen (weekly) bis heute/laufende Woche; offener heutiger Tag/laufende Woche bricht nicht, ausgelassener schon (issue #104)
      habit-today.tsx / .css   Heute-Sektion: Abhak-Liste, Zeile bleibt nach dem Abhaken sichtbar (Undo per erneutem Tippen) (issue #103); Streak-Badge (🔥) je Zeile, nur wenn > 0 (issue #104)
      use-archive-habit.ts     Archivieren/Reaktivieren (setzt/löscht archivedAt, nie deletedAt) mit Undo-Toast (issue #102)
      habit-list.tsx / .css    Verwaltungsliste: aktive Gewohnheiten + eingeklappter Archiv-Bereich (SectionCard)
      habit-editor.tsx / .css  Bottom-Sheet für Anlegen + Bearbeiten (Name, Rhythmus, Farbe aus den vier Bereichsfarben)
      add-habit-fab.tsx        FAB + Sheet fürs Anlegen, gleiche Form wie quick-add.tsx
    export/
      export.ts               liest db.records, baut die Export-Payload (Schema-Version + Zeitstempel), löst den Download aus
      export-panel.tsx         Button + Status in Einstellungen
      export.css               Styles für das Export-Panel
    settings/
      use-appearance.ts       Theme/Reduce-Motion/Textgröße — gerätelokal in localStorage, setzt Attribute auf <html>
      appearance-panel.tsx    Referenz der fünf Primitive: Theme (SegmentedControl), Bewegung reduzieren (Toggle), Textgröße (Slider)
      use-capture-prefs.ts    „ohne Bestätigung direkt anlegen" — gerätelokal in localStorage (issue #47 AC3)
      capture-panel.tsx       Toggle für use-capture-prefs in den Einstellungen
  ui/
    tokens.css              OKLCH-Farbtokens, hell + dunkel + expliziter Theme-Override, Spacing, Motion, --font-scale
    motion.css              Spring-Feder-Presets (--ease-spring-snappy/-smooth), .spring-press-Utility (ADR-0006)
    shell.css               App-Shell: Bottom-Nav (mobil) / Sidebar (Desktop)
    nav.tsx                 Die vier Tabs + Einstellungen-Einstieg (kein fünfter Tab)
    sheet.tsx               Wiederverwendbares Bottom-Sheet auf <dialog>-Basis
    sheet.css               Slide-up + Backdrop-Fade, reduced-motion = nur Opacity
    fab.tsx                 Floating Action Button, fixiert über der Bottom-Nav
    fab.css                 Position + Größe des FAB
    toast.tsx               Wiederverwendbares Undo-Toast (role="status")
    toast.css                Position über der Bottom-Nav, wie der FAB
    row.tsx / row.css       Label-links-Control-rechts-Zeile, Basis jeder Einstellungszeile
    section-card.tsx / .css Karte mit optionaler Überschrift/Aufklappen, gruppiert Rows
    toggle.tsx / .css       Switch (role="switch"), Federknopf
    segmented-control.tsx / .css  Radiogroup mit gleitendem Auswahl-Indikator
    slider.tsx / .css       Hülle um <input type="range">, aria-valuetext
    sync-boot.tsx           startet den Sync beim Mount + fragt persistenten Storage an (issue #52)
    persist-storage.ts      navigator.storage.persist()-Anfrage, idempotent, Status per getStoragePersistenceStatus()
    e2e-bridge.tsx          Griff auf die echte Outbox für Playwright (nur NEXT_PUBLIC_E2E=1)
tests/
  global-setup.ts           Lauf-Lock: ein zweiter E2E-Lauf bricht ab, statt die DB zu teilen
  global-teardown.ts        gibt das Lock wieder frei (nur das eigene)
  run-lock.ts               Pfad des Lockfiles + Port (Dev) + PORT_PROD (Offline-Spec), gemeinsame Quelle für Setup und Config
  helpers.ts                virtueller Authenticator, DB-Zugriff, Reset, Clock-Skew (skewClock)
  shell.spec.ts             Login, vier Tabs, aktiver Tab
  offline-critical.spec.ts  Kritischer Pfad SW → IndexedDB → Outbox → Postgres, läuft gegen echten Prod-Build (issue #57)
  sync.spec.ts              Outbox überlebt Reload, Tombstones, 401 ohne Session, Konfliktauflösung unter Uhrversatz (#53)
  tasks.spec.ts             Aufgabenliste: leer, Tombstone, erledigt/sortiert, offline
  heute.spec.ts             /heute: nur offene, heute fällige/überfällige Aufgaben, Leerzustand, TaskItem-Wiederverwendung (issue #87)
  capture.spec.ts           Freitext-Fälligkeit: Bestätigungs-Sheet, Direkt-Pfad + Undo, offline (issue #47)
  export.spec.ts            Export: alle Datensätze inkl. Tombstones, Schema-Version, offline
  habits.spec.ts            Gewohnheiten: anlegen, bearbeiten, archivieren/reaktivieren, offline (issue #102)
  habits-heute.spec.ts      Gewohnheiten in der Heute-Sektion: sichtbar, abhaken/zurücknehmen, Reload, Leerzustand, offline (issue #103)
  streaks.spec.ts           Streak-Badge in der Heute-Sektion: daily 3 Tage/ausgelassen, Tageswechsel (page.clock), weekly 2 Wochen/Reset (issue #104)
  persist-storage.spec.ts   navigator.storage.persist() beim Start: gewährt, schon gewährt, verweigert, nicht unterstützt (issue #52)
  settings.spec.ts          Theme/Toggle/Slider, Fokus/Tastatur, reduced-motion, 60fps-Filter-Wächter
  schema.spec.ts            Migrationen erzeugen exakt die Tabellen/Spalten aus src/db/schema.ts
scripts/
  claude-runner.sh          der autonome Runner (portabel: macOS + Linux)
  tests/status-queue.test.sh  Fixture-Tests für den Queue-Peek des Status-Tickets (#48)
  tests/round-snap.test.sh    ROUND_SNAP-Sortierung (createdAt statt Nummer) + Session-ID-Regel (#64)
  check-test-integrity.sh   Wächter gegen abgeschwächte Tests
  check-sync-invariants.sh  Wächter gegen direkten fetch(/api) außerhalb der Outbox (#58)
  check-dexie-bump.sh       Hinweis (kein Gate): Server-Migration ohne Dexie-Versions-Bump (#59)
  tests/dexie-bump.test.sh  Fixture-Tests für check-dexie-bump.sh (#59)
  bootstrap-github.sh       einmaliges GitHub-Setup (Labels, Milestones, Branch-Schutz)
  vercel-build.sh           Release-Schritt: wendet Migrationen vor next build an (nur Production)
  smoke-decide.sh           Post-Deploy-Smoke: HEALTHY/REVERT/AMBIGUOUS aus Health+Version+Playwright
  launchd-setup.md          Runner als Dienst auf macOS
  systemd-setup.md          Runner als Dienst auf Linux
.github/workflows/
  ci.yml                    Lint, Typecheck, Vitest, Playwright, Schema-Drift-, Test-Integrity- und Protected-Paths-Gate
  smoke.yml                 Post-Deploy-Smoke gegen Prod, Auto-Revert bei rot
  interaction-limit-reminder.yml  monatlicher Cron, erinnert 30 Tage vor Ablauf des Interaction Limit per Issue (#70)
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
| die Journal-Verschlüsselung              | `src/crypto/journal.ts` (ab M4)                 |
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
