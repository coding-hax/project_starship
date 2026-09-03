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

- `middleware.ts` — Auth-Gate vor `(app)`: prüft nur Cookie-**Anwesenheit** (kein DB-Zugriff),
  `matcher` auf `(app)`-Routen; ohne Cookie → `/anmelden`. Liegt bewusst unter `src/`,
  nicht an der Repo-Wurzel — dort lädt Next es lautlos nie.
- `(app)/layout.tsx` — App-Shell, `<ModuleRouteGuard/>`; die echte Autorisierung bleibt
  an der Datenschicht (`requireOwner()` in jeder `/api/sync/*`-Route)
- `(app)/page-transition.tsx` — Opacity-Crossfade-Wrapper um `{children}` (siehe Invarianten)
- `(app)/uebersicht/` — Dashboard: Ring + Einstellungs-Einstieg in der Augenbrauenzeile,
  `UebersichtCapture` als FAB unten rechts + `<UebersichtSections/>` (je aktivem
  Modul eine `OverviewSection`: Wetter → Termine → Aufgaben → Aktivitäten → Routinen),
  Kopf via `OverviewBlock`
- `(app)/aufgaben/page.tsx` — Kopfzeile + `<TaskList/>` + `<QuickAddTask/>`
- `(app)/kalender/page.tsx` — rendert `<CalendarView/>` (Tages-Timeline + Termin-Editor); Monat/Serien folgen S4–S6
- `(app)/routinen/page.tsx` / `(app)/aktivitaeten/page.tsx` — Routinen-Verwaltung + Garmin-Aktivitäten, je eigener Tab
- `(app)/wetter/[datum]/page.tsx` — Tagesdetails: Stundenverlauf, Niederschlag, Wind, Sonnenauf-/-untergang
- `(app)/journal/page.tsx` — Titelzeile mit heutigem Datum + rendert `<JournalGate/>`, kein Editor-Inhalt direkt
- `(app)/einstellungen/` — Darstellung, Reihenfolge, Module, Push (rendert je aktivem Modul dessen `SettingsPanel`)
- `anmelden/` / `offline/` — Passkey (Einrichten/Anmelden/Recovery) + Service-Worker-Fallback ohne Netz
- `api/auth/` / `api/health/` — WebAuthn (register/login/logout/status), Geräte-/Sitzungswiderruf (`credentials/`, `sessions/`) + SELECT 1 + Versions-SHA (ungeschützt)
- `api/sync/` — `push/` und `pull/`, die einzigen Wege zu den Daten
- `api/push/` / `api/garmin-sync/` — subscribe/unsubscribe/test+`reminders/`, holt Aktivitäten (beide Bearer-Secret)
- `api/ics/` — SSRF-abgesicherter Proxy für abonnierte `.ics`-Feeds (ADR-0022): `ssrf.ts`
  (Schema+IP-Sperre, rein) + `route.ts` (DNS-Auflösung, Redirect-Revalidierung je Hop, Größen-/Zeit-Cap), `requireOwner()`-geschützt
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
- `push.ts` / `garmin-sync.ts` / `ics-fetch.ts` — einzige Stellen, die gegen `/api/push` bzw. `/api/garmin-sync` bzw. `/api/ics` sprechen

### src/auth

- `session.ts` — opakes Session-Token (Hash in der DB), `requireOwner()`
- `session-cookie.ts` — nur `SESSION_COOKIE`, blattlos (keine Imports), damit `middleware.ts` es im Edge-Runtime laden kann
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
- `reminders/tasks-due.ts` / `habits-open.ts` / `interaction-limit.ts` — feste Slots: fällige Aufgaben, offene Routinen, Ablauf
- `reminders/events-due.ts` — reine `dueEventReminders` + DB-`collectDueEventReminders`: „15 Minuten vorher" pro Termin (S7, kein fester Slot, nutzt S6-Expansion)

### src/features/tasks

- `task-list.tsx` / `task-list.css` / `tasks-overview-section.tsx` — Aufgabenliste (gruppiert, Drag-Drop) + `OverviewSection`
- `task-item.tsx` — eine Zeile: Checkbox, Swipe erledigen/löschen, Drag-to-Nest
- `use-tasks.ts` / `use-complete-task.ts` / `use-delete-task.ts` — Live-Query+Gruppierung, Erledigen/Löschen (Swipe, Undo); `openTaskNodes` filtert erledigte aus „Alle"
- `task-editor.tsx` / `.css` — Bottom-Sheet: Titel/Notiz/Fälligkeit/Priorität
- `quick-add.tsx` / `.css` / `parse-task-input.ts` — FAB + Sheet, parst Freitext → `{ title, dueAt }`;
  `analyzeText` Baustein für `src/features/capture/`; Wann-Panel `due-picker.tsx`
- `capture-confirm.tsx` / `.css` — Bestätigungs-Sheet für erkannte Fälligkeit
- `capture-draft-store.ts` — `CaptureDraftItem` (`task`/`event`) / `CaptureDraftBatch`, In-Memory-Übergabe Übersicht→FAB/`EventEditor`
- `uebersicht-capture.tsx` — Erfassungsknopf `/uebersicht`: ruft `route-capture.ts`, lenkt task/event über Draft-Store, hakt habit_check bei hoher Konfidenz ab (Undo), sonst `/routinen`

### src/features/capture

- `types.ts` — `CaptureKind`/`CaptureContext`/`CaptureDraft`/`Recognizer`, Naht lokal/Modell-Erkenner, eigenes `CaptureDraft` (reicher als `tasks/capture-draft-store.ts`)
- `local-recognizer.ts` — Klassifikator (Punktzahl je Art), reine Funktion, kein React/Dexie; Titel kommt aus `parse-task-input.ts`s `analyzeText`
- `habit-match.ts` — Fuzzy-Match ohne Dependency (Tokenüberlappung, Diakritika gefaltet); Verneinung ("nicht") kassiert einen Treffer
- `field-confidence.ts` — Helfer für `FieldConfidence`, von Erkenner und `quick-add.tsx` geteilt
- `corpus.ts` — tabellengetriebenes Satz-Korpus
- `route-capture.ts` — die eine Stelle für „wohin damit": ruft `recognizeLocally`, übersetzt `CaptureKind` in Navigation/Prefill/Mutation; `allowedCaptureKinds` aus aktiven Modulen

### src/features/journal

- `write.ts` / `entry.ts` — `writeJournalEntry` (Schreibpfad) + Listen/Anhängen/Löschen
- `journal-keys.ts` — `readEnvelope`/`writeEnvelope`/`readRecoveryEnvelope`/`writeRecoveryEnvelope`
- `journal-key-stash.ts` — Dexie-Store `journalKeyStash`: fängt einen beim Pull verdrängten `journal_keys`-Envelope auf
- `recover-orphaned-entries.ts` — bergt Einträge unter gestashtem Alt-DEK, verschlüsselt sie unter dem aktuellen DEK neu
- `dek-session.ts` / `use-journal-persist-pref.ts` — opt-in persistierter DEK (`journalSession`) + Pref
- `lock-store.ts` — Entsperr-Automat: `setup`/`locked`/`unlocked`, In-Memory-DEK, Auto-Lock 15 Min
- `decrypt-journal-row.ts` — entschlüsselt Zeilen einzeln, unlesbare fällt raus
- `use-journal-{entries,search-entries}.ts` / `use-orphaned-key.ts` — `liveQuery`-Hooks
- `journal-editor.tsx` / `.css` — Eintragsstrom+FAB
- `search.ts` / `journal-search-cache.ts` / `journal-search.tsx` / `.css` — In-Memory-Suche + `splitHighlight`, Cache, Suchfeld+Treffer (nur im Suchmodus)
- `journal-view-mode.ts` / `journal-search-toggle.tsx` — Suchmodus-Store + Lupe in der Titelzeile
- `journal-gate.tsx` / `.css` — Zustands-UI: setup/locked/unlocked, Recovery-/Rewrap-Screen
- `journal-settings-panel.tsx` / `.css` — Opt-in-Toggle + Recovery-Key neu ausstellen
- `journal-habit.ts` — feste `JOURNAL_HABIT_ID` + Anlegen/Archivieren/Abhaken der Journal-Routine
- `journal-habit-boot.tsx` — legt die Journal-Routine idempotent nach dem ersten Pull an

### src/features/habits

- `use-habits.ts` / `use-habit-logs.ts` / `use-toggle-habit-log.ts` — Live-Queries + Abhaken/Zurücknehmen
- `due-today.ts` / `schedule-rules.ts` / `habit-progress.ts` — Fälligkeits-/Erledigt-Regeln, `computeHabitProgress` (N von M) teilen Ring + Kopf-Link
- `streak.ts` — `computeStreak` (`habit_freezes` dormant) + `countHabitsOnStreak`
- `week-goal.ts` / `history-weeks.ts` / `history-days.ts` / `month-progress.ts` — reine Ableitungen: Wochensoll, 12-Wochen-, 30-Tage-, Monatsreihe
- `habit-today.tsx` / `.css` — Abhak-Liste, Streak-Badge auf /uebersicht
- `habits-overview-section.tsx` — `OverviewSection`-Wrapper für `HabitToday`
- `habit-tiles.tsx` / `.css` — vier Kennzahl-Kacheln auf /routinen
- `habit-table.tsx` / `habit-week-grid.tsx` / `row-month-nav.tsx` (+ `.css`) — ausklappbare Tabelle auf /routinen mit Monatsraster+-nav je Zeile
- `habit-history-card.tsx` / `.css` / `step-path.ts` — 30-Tage-Verlaufskarte auf /routinen (Stufenkurve, feste Skala)
- `use-archive-habit.ts` / `habit-editor.tsx` / `.css` / `add-habit-fab.tsx` — Archiv, Anlegen/Bearbeiten (Sheet+FAB)

### src/features/events

- `event-time.ts` — reine Layout-Logik (kein DB/DOM): Tages-/Wochen-/Monats-Helfer + `upcomingEventsToday`/`formatCountdown`
- `recurrence.ts` — reine Serien-Expansion: `occurrencesOnDay`/`matchesPattern`/`anchorDateKeyOf`, `expandForDay(events, exceptions, dayKey)` → gerenderte `Occurrence`s
- `event-mutations.ts` — Schreibseite zu `recurrence.ts` (S6): `truncateRecurrence`/`remainingRecurrence`, `moveOccurrence`/`cancelOccurrence`, `splitSeries`/`truncateSeriesFrom`
- `use-events.ts` — `EventView`/`toEventView` + `useEvents()` (Dexie-Live-Query über `useLiveTable`); `EventView.origin`
  (`'local'|'subscribed'`, View-Feld) unterscheidet synced von abonnierten Terminen
- `use-event-exceptions.ts` — `EventExceptionView`/`toEventExceptionView` + `useEventExceptions()`, nur lesend — Schreiben läuft über `event-mutations.ts`
- `ics-parse.ts` — Minimal-RFC-5545-Parser, nur ganztägig (ADR-0022): `parseIcs(text)` liest
  `UID`/`SUMMARY`/`DTSTART`/`DTEND`/`RRULE`/`EXDATE` aus `VEVENT`s, überliest den Rest; getimte Termine fallen heraus
- `ics-expand.ts` — reine Serien-Expansion für abonnierte Kalender: `expandIcsEvents(parsed, horizon)`
  über `occurrencesOnDay` (recurrence.ts), `isIcsStale`/`icsHorizon`/`ICS_REFRESH_INTERVAL_MS`
- `use-ics-subscriptions.ts` — Wetter-Muster (ADR-0009): `useIcsSubscriptionList`/`useSubscribedEvents` (Live-Query),
  `refreshStaleSubscriptions`/`useIcsSubscriptionsRefresh` (nur bei Staleness, Fehler rühren nur `lastError` an)
- `calendar-view.tsx` / `.css` — `/kalender`: Woche `<CalendarStrip/>` im Header, Monat `<MonthGrid/>` im Rumpf, dann
  `<EventAgenda/>`, FAB + `<EventDetail/>`/`<EventEditor/>` + Lösch-Undo-`<Toast/>`
- `calendar-strip.tsx` / `.css` — Wochenstreifen Mo–So, Wisch blättert, Vor/Zurück-Tag, „Heute", Punkte/Tag
- `month-grid.tsx` / `.css` — Monats-Karte: 7×6-Raster, ≤3 Punkte/Tag, 44px-Trefferfläche per Pseudo-Element, Monatsnav
- `event-agenda.tsx` / `.css` — All-Day-Band (ganztägig/mehrtägig) + chronologische Agenda-Liste: Terminkarten
  (antippbar → Detail-Sheet) mit Kategorie-Farbkante, Fokus auf den nächsten Termin, spärlich/leer-Zustände;
  `origin:'subscribed'`-Items als nicht-interaktives `<div data-origin="subscribed">`, kein Detail-Zugriff
- `event-detail.tsx`/`event-editor.tsx` (`.css`) — Detail-Sheet, „Bearbeiten" öffnet den Editor (`mutate()`); Serien-Instanz fragt erst `<RecurrenceScopeSheet/>` (S6)
- `recurrence-scope-sheet.tsx` / `.css` — "Nur dieser"/"Alle folgenden"/"Ganze Serie"-Abfrage (S6), "Nur dieser" nur wenn der Caller sie anbietet
- `use-delete-event.ts` — Tombstone + Undo-Fenster für einen Termin (1:1-Spiegel von `use-delete-task.ts`, ohne Kinder)
- `events-overview-section.tsx` / `.css` — `OverviewSection` "Nächster Termin": nächster Termin heute groß mit Countdown, Rest des Tages als dünne Zeilen darunter

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
- `geocoding.ts` / `geolocation.ts` / `wmo-icon.ts` / `weather-category-labels.ts` — Ortssuche + GPS-Kapsel + Wettercode → Icon/Label
- `use-weather-cache.ts` / `use-weather-forecast.ts` / `use-weather-day.ts` — Lese-Hook, Refresh-Trigger, Tagesdetail
- `weather-forecast.tsx` / `.css` / `weather-day.tsx` / `.css` — 7-Tage-Streifen + Tagesdetail (Kurve/Niederschlag als `<svg>`)

### src/features/settings

- `use-appearance.ts` / `appearance-panel.tsx` — Theme/Reduce-Motion/Textgröße, gerätelokal + Steuerung
- `use-capture-prefs.ts` / `capture-panel.tsx` — „ohne Bestätigung direkt anlegen" + Toggle
- `use-modules.ts` / `module-panel.tsx` — Modul-Ein/Aus (`core` nie abschaltbar) + Toggle je Modul
- `use-weather-location.ts` / `weather-panel.tsx` / `.css` — Wetter-Ort, gerätelokal, suchen/auswählen
- `ics-subscriptions-panel.tsx` / `.css` — `.ics`-Abos hinzufügen/entfernen, zeigt `lastError` je Abo (ADR-0022)
- `use-nav-order.ts` / `nav-order-panel.tsx` / `.css` — Reihenfolge der Nav-Einträge, ↑/↓ je Eintrag
- `use-push.ts` / `use-reminder-prefs.ts` / `push-panel.tsx` / `.css` — Push-Hook, Prefs-Query, Panel (an/aus)
- `use-devices.ts` / `devices-panel.tsx` / `.css` — Karte „Geräte": nur Passkeys — Liste, Hinzufügen, Widerruf, „Dieses Gerät"
- `use-sessions.ts` / `session-panel.tsx` / `.css` — Karte „Sitzung": „App sperren" + „Alle anderen Sitzungen beenden"
- `use-category-colors.ts` / `category-colors-panel.tsx` / `.css` — Zehnerpalette je Kalender-Kategorie, Merged-View + setColor/resetColor
- `category-colors-boot.tsx` — setzt/entfernt `--cat-<category>` als `var()`-Referenz auf `<html>`
- `calendar-settings-panel.tsx` — kalenders `SettingsPanel`-Slot zeigt auf `CategoryColorsPanel` + `IcsSubscriptionsPanel`

### src/ui

- `page-head.tsx` / `.css` — Dreizonen-Kopf (Augenbraue/Titel/Zusatz), drei Routen
- `mood-scale.tsx` / `.css` — Zehn Ein-Tipp-Punkte 1–10
- `background-arcs.tsx` / `.css` — drei gestaffelte Bögen hinterm Grund, dieselbe Anordnung auf jeder Route
- `faces.tsx` / `.css` — eine Figur je Route (`PageFace`), Inline-SVG, CSS-Blinzeln
- `swatch-palette.ts` — `SWATCH_PALETTE`, zehn Farbnamen (Token+Label), Quelle für habit-editor.tsx + category-colors-panel.tsx
- `tokens.css` / `motion.css` / `shell.css` — Farbtokens, Spring-Presets + `.list-motion-item` (Listen-Motion), App-Shell
- `use-list-presence.ts` — `useListPresence(items, getKey)`: hält entfernte Zeilen bis zum Exit-Animationsende gemountet
- `use-now.ts` — `useNow(intervalMs)`: tickendes `Date` (Default 60s), treibt z. B. die Kalender-Jetzt-Linie
- `use-online.ts` / `offline-notice.tsx` / `.css` — `useOnline()` (SSR-sicher) + geteilte
  Offline-Notiz (`role="status"`, Text als `children`), extrahiert aus den Aufgaben
- `app-header.tsx` / `nav-items.ts` / `nav.tsx` / `module-route-guard.tsx` — Einstellungen-Einstieg, Nav-Ableitung+Reihenfolge, Aus-Route-Redirect
- `sheet.tsx` / `.css` / `fab.tsx` / `.css` — Bottom-Sheet (`<dialog>`), Floating Action Button
- `toast-host.tsx` / `toast.tsx` / `.css` — zentraler Toast-Host (`aria-live`) + Toast (confirmation/error)
- `row/section-card/toggle/segmented-control/slider.tsx` (+ `.css`) — Form-Primitive
- `overview-block.tsx` / `.css` — /uebersicht: `OverviewBlock` (Rahmen) + `OverviewCardHead` (Kopf: Titel + Link)
- `field-hint.tsx` / `.css` — Warnfarbene Notiz für ein geratenes Feld, kein Icon
- `sync-boot.tsx` / `persist-storage.ts` / `sync-status.tsx` / `stale.ts` — Sync/Storage-Start, Fehler-Toast, Stale-Helfer
- `e2e-bridge.tsx` — Test-Griff auf Outbox/Journal/Dexie-Dump (nur `NEXT_PUBLIC_E2E`)

### tests/ — Playwright

- `global-setup.ts` / `global-teardown.ts` / `run-lock.ts` — Lauf-Lock gegen parallele E2E-Läufe, Lockfile-Pfad+Ports
- `helpers.ts` — virtueller Authenticator, DB-Zugriff, Reset, `skewClock`, Seed-Helfer
- `shell.spec.ts` / `nav-order.spec.ts` — Login/Tabs/Header, Karussell/Reihenfolge/Sidebar (reduced-motion, Dark)
- `section-card.desktop.spec.ts` — `.section-card` verliert ab 768px ihren 480px-Deckel
- `uebersicht.desktop.spec.ts` — /uebersicht ab 768px zweispaltig (Sektionen, Titelfigur, FAB-Reserve), 1280×800
- `seitenleiste-grund.desktop.spec.ts` — `.nav` ohne Fläche, `--on-ground`-Schrift ≥4,5:1, `--surface`-Pille aktiv
- `grundfarbe.spec.ts` / `seitenkopf.spec.ts` — Seitengrund + halbhoher Kopf je Route, je ein Test je AK
- `grundfarbe-vollfarbe.spec.ts` — Karten/Leiste/FAB, Vollfarbe
- `nav-schleier.spec.ts` — Boden-Schleier
- `abgleich-828.spec.ts` — Kopf-Angaben aus S2 AK4 `toBeInViewport` im vollen Recolor
- `offline-critical.spec.ts` / `sync.spec.ts` — SW→IndexedDB→Outbox→Postgres (Prod-Build) + Reload/Tombstones/401/Konflikte
- `navigation.prod.spec.ts` — Tab-Wechsel ohne RSC-/Dokument-Request, offline erreichbare Tabs, Redirect je Cookie-Zustand
- `shipped.prod.spec.ts` — Rauchtest gegen das ausgelieferte Bündel (ohne `NEXT_PUBLIC_E2E`, eigene `playwright.shipped.config.ts`)
- `tasks.spec.ts` / `uebersicht.spec.ts` / `capture.spec.ts` — Aufgabenliste, Übersicht-Filter, Freitext-Fälligkeit, je offline
- `capture-uebersicht.spec.ts` — Erfassungsknopf auf `/uebersicht` -> `/aufgaben` + `CaptureConfirm`
- `capture-router.spec.ts` / `capture-routine-neu.spec.ts` — Freitext: Termin vorbefüllt, Routine abgehakt/Review/neu, sonst Aufgabe
- `capture-parser.spec.ts` (Teil 1/4) — Span+Ranking-Grammatik, je Test AK1–AK7 + Offline
- `capture-zeigerzeit.spec.ts` (Teil 2/4) — deutsche Zeigerzeit + Tageshälften, je Test AK1–AK6 + Offline
- `capture-datum.spec.ts` (Teil 3/4) — Monatsnamen, Spannen, Tagesgrenze 04:00, rückw. Abhaken, je Test AK1–AK6 + Offline
- `capture-unsicher.spec.ts` (Teil 4/4) — unsichere Felder markieren, je Test AK1–AK6
- `export.spec.ts` — Export inkl. Tombstones, Schema-Version, offline
- `habits.spec.ts` / `habits-uebersicht.spec.ts` / `streaks.spec.ts` / `habits-week-grid.spec.ts` — Verwaltung, Übersicht, Streaks, Monatsraster
- `routinen.spec.ts` / `habits-streak-summary.spec.ts` — /routinen (Kopf+Kacheln+Tabelle+Verlauf, Dark/reduced-motion) + 30-Tage-Verlaufskarte
- `kalender.spec.ts` — Tages-Timeline: Stundenachse, Jetzt-Linie, Kategorie-Farbkante, Wochenstreifen-Blättern
- `scroll-position.spec.ts` — jede Seite startet oben, nie auf der Scrollposition der vorherigen, auch nicht per Zurück
- `persist-storage.spec.ts` / `settings.spec.ts` — Storage-Persistenz, Theme/Toggle/Slider/Fokus
- `weather.spec.ts` / `weather-day.spec.ts` — Übersicht + Tagesdetailseite, Netzausfall/Stale
- `schema.spec.ts` — Migrationen erzeugen exakt das Schema
- `journal.spec.ts` / `journal-suche.spec.ts` — Editor (Mehr-Einträge, Migration Up/Down) + Suche
- `journal.desktop.spec.ts` — zwei Bahnen ab 768px, Figur neben Titel, Bodenreserve gegen den Fab
- `journal-recovery.spec.ts` / `journal-recovery-reissue.spec.ts` — Recovery-Kit, Recovery-Key neu ausstellen
- `journal-key-race.spec.ts` — Erst-Setup-Race auf zwei Geräten: Stash des verdrängten Envelopes, Bergung der Alt-Einträge (AK1–AK7)
- `garmin.spec.ts` / `push-reminders.spec.ts` / `reminder-prefs.spec.ts` — Pull ins IndexedDB, Reminder-Versand, Panel „Benachrichtigungen"
- `modules.spec.ts` — Modul-Panel, Route-Guard, beide Viewports
- `form-bedienelemente.spec.ts` — FAB-Pille/Atem, aktiver Reiter, Häkchen, je AK + Überlauf hell/dunkel

### scripts/ — Runner & CI-Hilfen

- `garmin-bootstrap.md` — einmaliger Handgriff fürs Garmin-OAuth1-Token
- `claude-runner.sh` / `runner/cli.ts` — autonomer Runner, Einstiegspunkt (Bash) + TS-Kern-Dispatcher (`argv[2]`)
- `runner/{gh,git,state,clock,time}.ts` — Adapter (gh/git/State-Dateien/Zeit), injizierbar für Vitest
- `runner/{queue,tier,escalation,cap,pr,catchup}.ts` — Queue, Modell-Eskalation, Deckel, PR-Zustand, Nachzieh-Ablauf
- `runner/{watch,select,status,ak}.ts` — CI-Wache, Ticketauswahl, Status-Issue, AK-Parser (ADR-0026)
- `runner/prompts.ts` / `runner/round.ts` — fünf Prompts + eine Runde (`roundPlan`/`roundEval`/`roundRecover`)
- `runner/{session,shim,cleanup,claim,fleet}.ts` — Session-Trennung, Shim-Drift, Aufräumen, Multi-Slot-Status
- `runner/*.test.ts` — Vitest-Suiten der TS-Adapter, je eine Datei pro Modul
- `git-hooks/pre-push` — Push-Netz gegen Doppelbau (ADR-0020): bricht nur ab, wenn der Claim des Tickets fremdem Slot gehört
- `check-test-integrity.sh` / `check-sync-invariants.sh` — Wächter: abgeschwächte Tests, `fetch(/api/)` außerhalb der Outbox
- `check-dexie-bump.sh` / `check-codemap.sh` — fehlender Dexie-Bump-Hinweis, Wächter für diese Karte
- `tests/*.test.sh` — Bash-Fixture-Suiten, je eine Datei pro Guard/Runner-Baustein
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
