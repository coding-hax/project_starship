# Code-Karte

**Zweck:** Tokens sparen — eine Zeile pro Datei/Ordner, reine Struktur.
Beantwortet „wo liegt eigentlich…?", nicht „warum".

**Regel:** Struktur, kein Warum. Begründungen, Entscheidungen und Issue-Historie
gehören in `git blame`, die ADRs oder das Ticket — nicht hierher. Für Detail
jenseits der Grobstruktur (Zusammenhänge, Implementierungsdetails) ist der
**Explore-Subagent** der Weg, nicht ein Ausbau dieser Karte.

Wer eine Datei anlegt, verschiebt oder löscht, aktualisiert diese Karte im
selben PR. Eine veraltete Karte ist schlimmer als keine.

## Struktur

### src/app — Routen & API

- `(app)/layout.tsx` — Auth-Gate, App-Shell, `<ModuleRouteGuard/>`, ohne Session → `/anmelden`
- `(app)/page-transition.tsx` — Opacity-Crossfade-Wrapper um `{children}` (siehe Invarianten)
- `(app)/uebersicht/` — Dashboard: `<DailyProgressRing/>` + `<UebersichtSections/>`
  (rendert je aktivem Modul dessen `OverviewSection`, Reihenfolge Wetter → Aufgaben →
  Aktivitäten → Gewohnheiten)
- `(app)/aufgaben/` — Aufgaben (leer bis M1)
- `(app)/kalender/page.tsx` — rendert `<CalendarView/>` (Tages-Timeline, S2 von #473, issue #553); Editor/Monat/Serien folgen S3–S6
- `(app)/gewohnheiten/page.tsx` / `(app)/aktivitaeten/page.tsx` — Gewohnheiten-Verwaltung + Garmin-Aktivitäten, je eigener Tab
- `(app)/wetter/[datum]/page.tsx` — Tagesdetails: Stundenverlauf, Niederschlag, Wind, Sonnenauf-/-untergang
- `(app)/journal/page.tsx` — Titelzeile mit heutigem Datum (issue #469) + rendert `<JournalGate/>`, kein Editor-Inhalt direkt
- `(app)/einstellungen/` — Darstellung, Reihenfolge, Module, Push (rendert je aktivem Modul dessen `SettingsPanel`)
- `anmelden/` / `offline/` — Passkey (Einrichten/Anmelden/Recovery) + Service-Worker-Fallback ohne Netz
- `api/auth/` / `api/health/` — WebAuthn (register/login/logout/status) + SELECT 1 + Versions-SHA (ungeschützt)
- `api/sync/` — `push/` und `pull/`, die einzigen Wege zu den Daten
- `api/push/` / `api/garmin-sync/` — subscribe/unsubscribe/test+`reminders/`, holt Aktivitäten (beide Bearer-Secret)
- `layout.tsx` / `manifest.ts` / `globals.css` — Root-Layout (PWA-Metadaten, Theme/Modul-Bootstrap), Manifest, Tailwind+Tokens
- `sw.ts` — Service Worker (Serwist), Push/Notification-Handler, modul-unabhängig

### src/db

- `schema.ts` — Drizzle-Schema, einzige Quelle der Wahrheit fürs Datenmodell
- `sync-tables.ts` / `sync-lock.ts` — welche Tabellen/Felder Sync anfassen darf + `pg_advisory_xact_lock` je Schreib-Transaktion
- `index.ts` / `migrate.ts` — DB-Verbindung (pg-Pool) + wendet Migrationen an (`pnpm db:migrate`)
- `migrations/` / `migrations/down/` — generierte Migrationen (nie von Hand) + Down-Pfad je Migration

### src/local — Outbox & Sync

- `types.ts` — Vertrag zwischen Outbox und `/api/sync`
- `dexie.ts` — IndexedDB-Definition (outbox, records, meta + Sonderstores)
- `outbox.ts` / `sync.ts` — Mutations-Queue (jede Schreiboperation) + Push/Pull, Cursor = `sync_seq`
- `conflict.ts` / `use-live-table.ts` — Konfliktregeln (Delete/Restore/Upsert) + generischer `liveQuery`-Hook
- `push.ts` / `garmin-sync.ts` — einzige Stellen, die gegen `/api/push` bzw. `/api/garmin-sync` sprechen

### src/auth

- `session.ts` — opakes Session-Token (Hash in der DB), `requireOwner()`
- `webauthn.ts` — Challenges, Credentials, Recovery-Code

### src/crypto — Journal-Verschlüsselung

- `errors.ts` / `base64.ts` — `WrongPassphraseError`/`JournalDecryptError` (nie Klartext in der Message) + Base64-Helfer
- `envelope.ts` — KEK+Hülle: `deriveKek` (PBKDF2) + `createEnvelope`/`openEnvelope` (DEK als AES-GCM)
- `journal.ts` — `encryptJournal`/`decryptJournal`, `reissueRecovery`, Re-Export der envelope-API
- `__fixtures__/journal-vector.json` — Testvektor gegen unbemerkte Formatänderungen

### src/modules

- `registry.ts` / `module-sections.ts` — `MODULES`+`NavItem` (einzige Quelle je Modul) + `useActiveSections(order, pick)`

### src/push — Server-seitiger Versand

- `vapid.ts` / `send.ts` — VAPID aus Env-Vars + `sendPushToAll(payload)`, löscht ungültige Abos
- `notification.ts` / `schedule.ts` — reine `buildNotification`/`parsePushPayload`-Logik + `berlinNow`/`dueSlots` (DST-sicher)
- `reminders/index.ts` / `reminder-kinds.ts` — Registry (`sendDueReminders`) + Kind-Metadaten
- `reminders/tasks-due.ts` / `habits-open.ts` / `interaction-limit.ts` — feste Slots: fällige Aufgaben, offene Gewohnheiten, Ablauf

### src/features/tasks

- `task-list.tsx` / `task-list.css` / `tasks-overview-section.tsx` — Aufgabenliste (gruppiert, Drag-Drop) + `OverviewSection`
- `task-item.tsx` — eine Zeile: Checkbox, Swipe erledigen/löschen, Drag-to-Nest
- `use-tasks.ts` / `use-complete-task.ts` / `use-delete-task.ts` — Live-Query+Gruppierung, Erledigen/Löschen (Swipe, Undo)
- `task-editor.tsx` / `.css` — Bottom-Sheet: Titel/Notiz/Fälligkeit/Priorität
- `quick-add.tsx` / `.css` / `parse-task-input.ts` — FAB + Sheet, parst Freitext → `{ title, dueAt }`
- `capture-confirm.tsx` / `.css` — Bestätigungs-Sheet für erkannte Fälligkeit

### src/features/journal

- `write.ts` / `entry.ts` — `writeJournalEntry` (einziger Schreibpfad) + Listen/Anhängen/Löschen
- `journal-keys.ts` — `readEnvelope`/`writeEnvelope`/`readRecoveryEnvelope`/`writeRecoveryEnvelope`
- `dek-session.ts` / `use-journal-persist-pref.ts` — opt-in persistierter DEK (Dexie-Store `journalSession`) + Pref
- `lock-store.ts` — Entsperr-Automat: `setup`/`locked`/`unlocked`, In-Memory-DEK, Auto-Lock 15 Min
- `decrypt-journal-row.ts` / `conflicts.ts` — entschlüsselt Zeilen einzeln (eine unlesbare fällt raus) + Konflikte
- `use-journal-{conflicts,entries,search-entries}.ts` — `liveQuery`-Hooks
- `journal-editor.tsx` / `.css` — Formular (Stimmung/Text/Tags) + Eintragsliste + Suche
- `search.ts` / `journal-search-cache.ts` / `journal-search.tsx` / `.css` — In-Memory-Suche, Entschlüsselungs-Cache, Suchfeld+Ergebnisliste
- `journal-gate.tsx` / `.css` — Zustands-UI: setup/locked/unlocked, Recovery-Key-Screen, Rewrap-Screen
- `journal-header-date.tsx` / `.css` — heutiges Datum neben dem Seitentitel, oben rechts (issue #469)
- `journal-settings-panel.tsx` / `.css` — Opt-in-Toggle + Recovery-Key neu ausstellen
- `journal-habit.ts` — feste `JOURNAL_HABIT_ID` + Anlegen/Archivieren/Entarchivieren/Abhaken der Journal-Gewohnheit (issue #505)
- `journal-habit-boot.tsx` — legt die Journal-Gewohnheit idempotent nach dem ersten Pull an (issue #505)

### src/features/habits

- `use-habits.ts` / `use-habit-logs.ts` / `use-habit-freezes.ts` / `use-toggle-habit-log.ts` — Live-Queries + Abhaken/Zurücknehmen
- `due-today.ts` / `schedule-rules.ts` — Wochen-/Monats-Helfer + reine Fälligkeits-/Erledigt-Regeln
- `streak.ts` / `freeze.ts` — `computeStreak` (berücksichtigt Freezes) + Streak-Joker: Kontingent, `canRescue`
- `habit-today.tsx` / `.css` — Abhak-Liste, Streak-Badge, Rescue-Button
- `habits-overview-section.tsx` / `weekly-recap.ts` / `weekly-recap-card.tsx` / `.css` — `OverviewSection` + Wochenrückblick (Quote+Superlativ)
- `habit-week-grid.tsx` / `.css` — Monatsraster Mo–So je Habit-Zeile
- `use-archive-habit.ts` / `habit-list.tsx` / `.css` / `habit-editor.tsx` / `.css` / `add-habit-fab.tsx` — Archiv, Verwaltungsliste, Anlegen/Bearbeiten (Sheet+FAB)

### src/features/events

- `event-time.ts` — reine Layout-Logik (kein DB/DOM): `layoutForDay`/`nowLinePct`/`categoryEdgeVar`, `berlinMinutesOfDay`/`addDays`/`weekDaysFor`
- `use-events.ts` — `EventView`/`toEventView` + `useEvents()` (Dexie-Live-Query über `useLiveTable`)
- `calendar-view.tsx` / `.css` — `/kalender`: hält `selectedDay`, Header mit `<WeekStrip/>`, darunter `<EventTimeline/>`
- `week-strip.tsx` / `.css` — zugeklapptes Wochenband Mo–So, Vor/Zurück-Tag + antippbare Tage
- `event-timeline.tsx` / `.css` — Stundenachse 0–24h, Jetzt-Linie, Terminkarten mit Kategorie-Farbkante

### src/features/export

- `export.ts` / `export-panel.tsx` / `.css` — baut Export-Payload aus `db.records`, löst Download aus, Button+Status

### src/features/activities

- `recap.ts` / `monthly-summary.ts` — `computeRecap` (30-Tage-Fenster) + `computeMonthlySummary` je Art
- `format.ts` / `track-path.ts` / `line-path.ts` — Formatierung + SVG-Geometrie (Projektion, Wertreihe → Pfad)
- `use-activities.ts` / `use-activity-sync.ts` — Dexie-Live-Query + stößt `/api/garmin-sync` an
- `activity-list.tsx` / `.css` / `activity-block.tsx` / `.css` — Recap+Liste, eine Aktivität (Kopfzahlen+drei Kurven)
- `activity-map.tsx` / `.css` / `activity-chart.tsx` / `.css` — Kartenbild/SVG-Spur, eine Kurve (HF/Pace/Höhe)
- `activity-month-strip.tsx` / `.css` — Monatsstand auf der Übersicht

### src/features/garmin — Server-seitig

- `connect-api.ts` / `tokens.ts` — OAuth1-Signatur + OAuth2-Tausch/-Erneuerung, `garmin_tokens`
- `activity-mapper.ts` / `activity-diff.ts` / `static-map.ts` — Rohform→Kopfzahlen+Track, `sync_seq`-Diff, Mapbox-Kartenbild
- `sync-activities.ts` — kompletter Ablauf, eine Schreib-Transaktion

### src/features/weather

- `forecast.ts` — Open-Meteo: `fetchForecast`/`parseForecast`, `isStale`, Tagesdetail-Helfer
- `geocoding.ts` / `wmo-icon.ts` / `weather-category-labels.ts` — Ortssuche (flüchtig) + Wettercode → Icon/Label
- `use-weather-cache.ts` / `use-weather-forecast.ts` / `use-weather-day.ts` — Lese-Hook, Refresh-Trigger, Tagesdetail
- `weather-forecast.tsx` / `.css` / `weather-day.tsx` / `.css` — 7-Tage-Streifen + Tagesdetail (Kurve/Niederschlag als `<svg>`)

### src/features/settings

- `use-appearance.ts` / `appearance-panel.tsx` — Theme/Reduce-Motion/Textgröße, gerätelokal + Steuerung
- `use-capture-prefs.ts` / `capture-panel.tsx` — „ohne Bestätigung direkt anlegen" + Toggle
- `use-modules.ts` / `module-panel.tsx` — Modul-Ein/Aus (`core` nie abschaltbar) + Toggle je Modul
- `use-weather-location.ts` / `weather-panel.tsx` / `.css` — Wetter-Ort, gerätelokal, suchen/auswählen
- `use-nav-order.ts` / `nav-order-panel.tsx` / `.css` — Reihenfolge der Nav-Einträge, ↑/↓ je Eintrag
- `use-push.ts` / `use-reminder-prefs.ts` / `push-panel.tsx` / `.css` — Push-Hook, Prefs-Query, Panel (an/aus)

### src/ui

- `mood-scale.tsx` / `.css` — Zehn Ein-Tipp-Punkte 1–10
- `tokens.css` / `motion.css` / `shell.css` — Farbtokens, Spring-Presets + `.list-motion-item` (Listen-Ein/Ausblenden, reduced-motion → Fade), App-Shell
- `use-list-presence.ts` — `useListPresence(items, getKey)`: hält entfernte Zeilen bis zum Exit-Animationsende gemountet (issue #430)
- `use-now.ts` — `useNow(intervalMs)`: tickendes `Date` (Default 60s), treibt z. B. die Kalender-Jetzt-Linie (issue #553)
- `app-header.tsx` / `nav-items.ts` / `nav.tsx` / `module-route-guard.tsx` — Einstellungen-Einstieg, Nav-Ableitung+Reihenfolge, Aus-Route-Redirect
- `sheet.tsx` / `.css` / `fab.tsx` / `.css` — Bottom-Sheet (`<dialog>`), Floating Action Button
- `toast-host.tsx` / `toast.tsx` / `.css` — zentraler Toast-Host (`aria-live`) + Toast (confirmation/error)
- `row/section-card/toggle/segmented-control/slider.tsx` (+ `.css`) — Form-Primitive
- `sync-boot.tsx` / `persist-storage.ts` / `sync-status.tsx` / `stale.ts` — Sync/Storage-Start, Fehler-Toast, Stale-Helfer
- `e2e-bridge.tsx` — Test-Griff auf Outbox/Journal/Dexie-Dump (nur `NEXT_PUBLIC_E2E`)

### tests/ — Playwright

- `global-setup.ts` / `global-teardown.ts` / `run-lock.ts` — Lauf-Lock gegen parallele E2E-Läufe, Lockfile-Pfad+Ports
- `helpers.ts` — virtueller Authenticator, DB-Zugriff, Reset, `skewClock`, Seed-Helfer
- `shell.spec.ts` / `nav-order.spec.ts` — Login/Tabs/Header, Karussell/Reihenfolge/Sidebar (reduced-motion, Dark Mode)
- `offline-critical.spec.ts` / `sync.spec.ts` — SW→IndexedDB→Outbox→Postgres (Prod-Build) + Reload/Tombstones/401/Konflikte
- `tasks.spec.ts` / `uebersicht.spec.ts` / `capture.spec.ts` — Aufgabenliste, Übersicht-Filter, Freitext-Fälligkeit, je offline
- `export.spec.ts` — Export inkl. Tombstones, Schema-Version, offline
- `habits.spec.ts` / `habits-uebersicht.spec.ts` / `streaks.spec.ts` / `habits-week-grid.spec.ts` — Verwaltung, Übersicht-Sektion, Streaks/Joker, Monatsraster
- `kalender.spec.ts` — Tages-Timeline: Stundenachse, Jetzt-Linie, Kategorie-Farbkante, Wochenstreifen-Blättern (issue #553)
- `persist-storage.spec.ts` / `settings.spec.ts` — Storage-Persistenz, Theme/Toggle/Slider/Fokus
- `weather.spec.ts` / `weather-day.spec.ts` — Übersicht + Tagesdetailseite, Netzausfall/Stale
- `schema.spec.ts` — Migrationen erzeugen exakt das Schema
- `journal.spec.ts` / `journal-suche.spec.ts` — Editor (Mehr-Einträge, Migration Up/Down) + Suche
- `journal-recovery.spec.ts` / `journal-recovery-reissue.spec.ts` — Recovery-Kit, Recovery-Key neu ausstellen
- `garmin.spec.ts` / `push-reminders.spec.ts` / `reminder-prefs.spec.ts` — Pull ins IndexedDB, Reminder-Versand, Panel „Benachrichtigungen"
- `modules.spec.ts` — Modul-Panel, Route-Guard, beide Viewports

### scripts/ — Runner & CI-Hilfen

- `garmin-bootstrap.md` — einmaliger Handgriff fürs Garmin-OAuth1-Token
- `claude-runner.sh` / `runner/cli.ts` — autonomer Runner, Einstiegspunkt (Bash) + TS-Kern-Dispatcher (`argv[2]`)
- `runner/{gh,git,state,clock,time}.ts` — Adapter (gh/git/State-Dateien/Zeit), injizierbar für Vitest
- `runner/{queue,tier,escalation,cap,pr,catchup}.ts` — Queue, Modell-Eskalation, Deckel, PR-Zustand, Nachzieh-Ablauf
- `runner/{watch,select,status}.ts` — CI-Wache, Ticketauswahl, Statusmeldungen fürs Status-Issue
- `runner/prompts.ts` / `runner/round.ts` — vier Agenten-Prompts + eine Runde (`roundPlan`/`roundEval`/`roundRecover`)
- `runner/{session,shim,cleanup,claim,fleet}.ts` — Session-Trennung, Shim-Drift, Aufräumen, Multi-Slot-Status
- `runner/*.test.ts` — Vitest-Suiten der TS-Adapter, je eine Datei pro Modul
- `git-hooks/pre-push` — Push-Netz gegen Doppelbau (ADR-0020): bricht nur ab, wenn der Claim des Tickets fremdem Slot gehört
- `check-test-integrity.sh` / `check-sync-invariants.sh` — Wächter: abgeschwächte Tests, `fetch(/api/)` außerhalb der Outbox
- `check-dexie-bump.sh` / `check-codemap.sh` — fehlender Dexie-Bump-Hinweis, Wächter für diese Karte (schlank)
- `tests/*.test.sh` — Bash-Fixture-Suiten, je eine Datei pro Guard/Runner-Baustein (Namen wie das geprüfte Skript)
- `starship-runner` — Shim, den launchd/systemd startet
- `bootstrap-github.sh` / `vercel-build.sh` / `smoke-decide.sh` — GitHub-Setup, Migration vor Build, Post-Deploy-Smoke
- `launchd-setup.md` / `systemd-setup.md` / `gen-slot-plists.sh` — Runner als Dienst, Plist-Generator je Slot

### .github/workflows/

- `ci.yml` / `guards.yml` — Lint/Typecheck/Vitest/Playwright/Schema-Drift/Codemap-Gate, Test-Integrity-Gate
- `smoke.yml` — Post-Deploy-Smoke gegen Prod, Auto-Revert bei rot
- `garmin-sync.yml` / `reminders.yml` — nächtlicher Cron `/api/garmin-sync`, alle 30 Min `/api/push/reminders`

### docs/

Vision, Architektur, Design, Workflow, Token-Budget, ADRs.

## Wo liegt was?

| Ich suche… | Datei |
| --- | --- |
| das Datenmodell | `src/db/schema.ts` |
| welche Felder ein Client schreiben darf | `src/db/sync-tables.ts` |
| wie eine Änderung zum Server kommt | `src/local/outbox.ts`, dann `src/local/sync.ts` |
| den Vertrag zwischen Client und Sync-API | `src/local/types.ts` |
| wer reindarf | `src/auth/session.ts` (`requireOwner`) |
| Farben, Abstände, Motion | `src/ui/tokens.css` + `docs/DESIGN_SYSTEM.md` |
| die Journal-Verschlüsselung | `src/crypto/journal.ts` (+ `envelope.ts`) |
| warum etwas so entschieden wurde | `docs/adr/` |

## Wichtige Invarianten

- Kein Feature-Code spricht direkt mit `/api` — **immer** über `src/local/`.
- Keine Komponente benutzt Rohfarben — **immer** Tokens aus `src/ui/`.
- Kein Klartext des Journals verlässt `src/crypto/journal.ts`.
- Jede API-Route prüft `requireOwner()`. Es gibt keinen zweiten Pfad in die Daten.
- Jede synchronisierte Tabelle spreizt `syncColumns` aus `src/db/schema.ts`.
- Löschen ist **immer** ein Tombstone (`deleted_at`), nie ein `DELETE`.
- Der App-Router fokussiert nach einer Navigation automatisch das erste Element
  des Segments — `page-transition.tsx` liegt deshalb bewusst über dem
  Router-Segment (nicht in `template.tsx`), und Seiten mit eigener Kopfzeile
  (z. B. `wetter/[datum]/page.tsx`) tragen ihre Kopfzeile bewusst als `<header>`,
  weil sie so dieses erste fokussierte Element wird.

## Bauen

`pnpm build` und `pnpm dev` laufen mit `--webpack`, **nicht** mit Turbopack.
Serwist ist ein Webpack-Plugin, Next 16 nimmt Turbopack als Standard, und die
Kombination bricht den Build (serwist#54). Nimmt man das Flag weg, verschwindet der
Service Worker und mit ihm die Installierbarkeit — ohne dass irgendetwas rot wird.
