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
    (app)/uebersicht/       Dashboard          (Klammer — wächst ab M1 je Milestone mit); Wetter (WeatherForecast) ganz oben, vor der Aufgabenliste (issue #139); vormals „Heute"/`/heute` (issue #161)
    (app)/uebersicht/uebersicht.css   Titel-Zeile mit inline Einstellungen-Einstieg (issue #126); kein Shortcut-Link mehr, Tab in der Nav genügt (issue #137)
    (app)/aufgaben/         Aufgaben           (leer bis M1)
    (app)/gewohnheiten/     page.tsx           Gewohnheiten-Verwaltung (issue #102), eigener Tab (issue #123); /heute/gewohnheiten leitet per next.config.ts dauerhaft hierher weiter
    (app)/kalender/         Termine            (leer bis M5)
    (app)/journal/          Journal            (leer bis M4)
    (app)/einstellungen/    Einstellungen — Darstellung (AppearancePanel) + Spracherfassung (CapturePanel) + Export-Button
    anmelden/               Passkey: Einrichten, Anmelden, Recovery-Code
    offline/                Service-Worker-Fallback ohne Netz
    api/auth/               WebAuthn: register/login (options + verify), logout, status
    api/sync/               push/ und pull/ — die einzigen Wege zu den Daten
    api/push/               subscribe/unsubscribe/test — Push-Grundgerüst (issue #122), kein geschützter Pfad (kein Sync, keine Auth)
    api/garmin-sync/        POST, Bearer-Secret + Owner-Session als Zweitpfad — holt Aktivitäten, schreibt nie ohne Netzwerk-Vorlauf in die Transaktion (ADR-0011, issue #186)
    api/health/             SELECT 1 + Versions-SHA, ungeschützt — Ziel des Post-Deploy-Smoke
    layout.tsx              Root: Inter, Viewport, PWA-Metadaten (Apple + Manifest)
    manifest.ts             Web-App-Manifest (Next-Metadata-Route)
    sw.ts                   Service Worker (Serwist-Quelle) -> public/sw.js; push/notificationclick-Handler + E2E-Hooks (__pushTest/__lastNotificationClick unter NEXT_PUBLIC_E2E) seit issue #122
    globals.css             Tailwind-Import + @theme-Mapping der Tokens
  db/
    schema.ts               Drizzle-Schema — EINZIGE Quelle der Wahrheit fürs Datenmodell; `pushSubscriptions` seit issue #122, ohne syncColumns (Geräte-Infrastruktur wie sessions); garmin_activities (read-only) + garmin_tokens (nie synchronisiert) seit ADR-0011
    sync-tables.ts          Welche Tabellen der Sync anfassen darf + Feld-Whitelist; `readOnly`/`readable` für Server-Origin-Tabellen (issue #186)
    sync-lock.ts            gemeinsamer pg_advisory_xact_lock für jede Sync-Schreib-Transaktion (push, garmin-sync) — verhindert sync_seq außer Reihenfolge (ADR-0008)
    index.ts                DB-Verbindung (pg-Pool, Standard-Connection-String)
    migrate.ts              wendet Migrationen an (pnpm db:migrate)
    migrations/             generierte Migrationen, nie von Hand ändern
    migrations/down/        Down-Pfad je Migration mit Rückweg, von Hand angewendet (Konvention seit #186)
  local/
    types.ts                Vertrag zwischen Outbox und /api/sync (beide Seiten); SYNC_TABLES/READ_ONLY_TABLES/isReadOnlyTable seit ADR-0011
    dexie.ts                IndexedDB-Definition (outbox, records, meta); eigene weather-Tabelle, nie synchronisiert (ADR-0009, issue #139)
    outbox.ts               Mutations-Queue — JEDE Schreiboperation läuft hier durch; mutate() wirft für eine read-only-Tabelle (ADR-0011)
    sync.ts                 Push/Pull, Trigger (Start/Foreground/online), Cursor = sync_seq
    conflict.ts             reine Konfliktregeln: Delete/Restore/Upsert, Overwrite-Flag, Pull-Cursor (ADR-0008)
    use-live-table.ts       generischer liveQuery-Hook über `db.records`; von use-tasks/use-habits/use-habit-logs benutzt statt vierfach kopiertem Muster (issue #177)
    push.ts                 einzige Stelle, die gegen /api/push spricht (Guard-Ausnahme wie sync.ts): getPushState (Abo statt bloßer Browser-Erlaubnis), subscribeToPush/unsubscribeFromPush/sendTestPush (issue #122); Push-Abo bewusst nicht Outbox-geführt (Geräte-Infrastruktur, kein Domänendatum)
  auth/
    session.ts              Opakes Session-Token (nur als Hash in der DB), requireOwner()
    webauthn.ts             Challenges, Credentials, Recovery-Code
  crypto/                   (leer — Journal-Verschlüsselung kommt in M4)
  push/                     Server-seitiger Versand (issue #122, ADR-0010)
    vapid.ts                setzt VAPID-Details aus Env-Vars, lazy wie src/db/index.ts (Build braucht die Vars noch nicht)
    send.ts                 sendPushToAll(payload) — 410/404 vom Push-Dienst löscht das Abo, sonst nur Log ohne endpoint/keys
    notification.ts         reine buildNotification/parsePushPayload-Logik, von src/app/sw.ts benutzt (Vitest-testbar ohne SW-Scope)
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
      due-today.ts             reine Logik: welche Habits gehören in die Übersicht-Sektion (daily immer, weekly noch nicht in der laufenden Mo–So-Woche erledigt) (issue #103); weekDays — die 7 Datums-Keys Mo–So einer Woche (issue #105); monthDays/monthLabel/addMonths/dayLabel — Monatsraster + Monatsleiste (issue #124)
      streak.ts                reine Logik: computeStreak — aufeinanderfolgende Tage (daily/custom) bzw. Mo–So-Wochen (weekly) bis heute/laufende Woche; offener heutiger Tag/laufende Woche bricht nicht, ausgelassener schon (issue #104)
      habit-today.tsx / .css   Übersicht-Sektion: Abhak-Liste, Zeile bleibt nach dem Abhaken sichtbar (Undo per erneutem Tippen) (issue #103); Streak-Badge (🔥) je Zeile, nur wenn > 0 (issue #104)
      habit-week-grid.tsx / .css  Monatsraster Mo–So je Habit-Zeile (issue #105 → #124), heutiger Tag nur im laufenden Monat markiert, Zukunft gesperrt, Zelle direkt abhakbar über useToggleHabitLog
      use-archive-habit.ts     Archivieren/Reaktivieren (setzt/löscht archivedAt, nie deletedAt) mit Undo-Toast (issue #102)
      habit-list.tsx / .css    Verwaltungsliste: aktive Gewohnheiten + eingeklappter Archiv-Bereich (SectionCard); Monatsleiste (‹/›) steuert den Monat aller Raster gemeinsam (issue #124); jede Zeile zeigt zusätzlich das Monatsraster
      habit-editor.tsx / .css  Bottom-Sheet für Anlegen + Bearbeiten (Name, Rhythmus, Farbe aus den vier Bereichsfarben)
      add-habit-fab.tsx        FAB + Sheet fürs Anlegen, gleiche Form wie quick-add.tsx
    export/
      export.ts               liest db.records, baut die Export-Payload (Schema-Version + Zeitstempel), löst den Download aus
      export-panel.tsx         Button + Status in Einstellungen
      export.css               Styles für das Export-Panel
    garmin/                   Server-seitig, kein Client-Code -- keine Garmin-Spezifika außerhalb dieses Verzeichnisses (ADR-0011, issue #186)
      connect-api.ts           handgerollte OAuth1-Signatur + OAuth2-Tausch + die zwei connectapi.garmin.com-Aufrufe, keine Client-Bibliothek
      tokens.ts                liest/schreibt garmin_tokens, erneuert OAuth2 aus OAuth1, GarminBootstrapRequired statt Login-Versuch
      activity-mapper.ts       reine Zuordnung Garmin-Rohform -> Kopfzahlen (mapActivityListEntry) + spaltenweiser Track (buildTrack), robust gegen wechselnde metricDescriptors-Reihenfolge
      activity-diff.ts         reine Änderungserkennung (activityChanged) -- Grund, warum sync_seq nur bei echter Änderung bumpt, ohne SQL-WHERE-Klausel
      static-map.ts            Kartenbild einmal je Aktivität, Mapbox Static Images; wirft nie, null ohne GARMIN_MAP_KEY oder bei Fehlschlag
      sync-activities.ts       der ganze Ablauf ohne HTTP-Kram -- Netzarbeit vor der einen Schreib-Transaktion, dieselbe pg_advisory_xact_lock wie push (src/db/sync-lock.ts)
    weather/
      forecast.ts              Open-Meteo: fetchForecast(lat, lon)/parseForecast, isStale (3h-Fenster), weatherCacheKey (ein Cache-Row je Ort), weekdayLabel, isWeekend, isStaleWarning (8h) + formatStaleSince — Ort kommt aus use-weather-location.ts, kein fester Ort mehr (issue #139, ADR-0009; Feinschliff issue #155; Ort wählbar issue #159)
      geocoding.ts             searchLocations/formatGeocodingResult gegen Open-Meteos Geocoding-Suche — flüchtig, nie in Dexie abgelegt (issue #159)
      wmo-icon.ts              reine Funktion: WMO weather_code -> eine von sieben Kategorien, unbekannter Code fällt auf 'cloudy' zurück
      use-weather-forecast.ts  Live-Query auf db.weather, ein Cache-Key je Ort (issue #159 — Ortswechsel verwirft die alte Vorhersage statt sie zu vermischen); Refresh nur wenn stale; zusätzlich Trigger bei visibilitychange/focus + Intervall solange sichtbar (issue #155), Fehler überschreiben den Cache nie
      weather-forecast.tsx / .css  7-Tage-Streifen ganz oben auf Übersicht, zeigt den eingestellten Ort (issue #159); Skeleton reserviert die Höhe vor dem ersten Abruf (Smooth-Regel 3); Wochenend-Spalten mit outline statt border (kein Layout-Einfluss); Stand-Zeile nur >8h alt, absolut positioniert (issue #155)
    settings/
      use-appearance.ts       Theme/Reduce-Motion/Textgröße — gerätelokal in localStorage, setzt Attribute auf <html>
      appearance-panel.tsx    Referenz der fünf Primitive: Theme (SegmentedControl), Bewegung reduzieren (Toggle), Textgröße (Slider)
      use-capture-prefs.ts    „ohne Bestätigung direkt anlegen" — gerätelokal in localStorage (issue #47 AC3)
      capture-panel.tsx       Toggle für use-capture-prefs in den Einstellungen
      use-weather-location.ts Wetter-Ort { name, latitude, longitude } — gerätelokal in localStorage, Default Bonn (issue #159)
      weather-panel.tsx / .css Ort suchen (geocoding.ts) + auswählen, plus Open-Meteo-Quellenangabe (vormals attribution-panel.tsx, issue #155/#159 — eine Fremdquelle, eine Tafel)
      use-nav-order.ts        Reihenfolge der Nav-Einträge — gerätelokal in localStorage; resolveOrder(stored, items) rein: bekannte Ids in gespeicherter Reihenfolge, unbekannte raus, fehlende hinten dran (issue #205)
      nav-order-panel.tsx / .css  SectionCard mit ↑/↓ je Eintrag, kein Drag & Drop (issue #205)
      use-push.ts             Hook um src/local/push.ts (kein eigener fetch); Phasen loading/unsupported/default/denied/granted (issue #122)
      push-panel.tsx / .css   Benachrichtigungen an-/abschalten + Testnachricht; denied zeigt erklärenden Text statt toter Schaltfläche (AC3, issue #122)
  ui/
    tokens.css              OKLCH-Farbtokens, hell + dunkel + expliziter Theme-Override, Spacing, Motion, --font-scale
    motion.css              Spring-Feder-Presets (--ease-spring-snappy/-smooth), .spring-press-Utility (ADR-0006)
    shell.css               App-Shell: Header + Bottom-Nav (mobil, Karussell ab mehr als fünf Einträgen) / Header + Sidebar (Desktop, kein Karussell) (issue #205)
    app-header.tsx           Einstellungen-Einstieg, zwei Varianten: `chrome` (Shell, nur ab 768px) und `inline` (nur auf /uebersicht, mobil) (issue #123, #126)
    nav-items.ts            NAV_ITEMS — eine Quelle für nav.tsx und nav-order-panel.tsx (issue #205)
    nav.tsx                 Reihenfolge aus useNavOrder, holt den aktiven Tab beim Navigieren selbst heran (scrollIntoView, reduced-motion-bewusst) (issue #123, #205)
    sheet.tsx               Wiederverwendbares Bottom-Sheet auf <dialog>-Basis
    sheet.css               Slide-up + Backdrop-Fade, reduced-motion = nur Opacity
    fab.tsx                 Floating Action Button, fixiert über der Bottom-Nav
    fab.css                 Position + Größe des FAB
    toast.tsx               Wiederverwendbares Toast: `variant` confirmation (role="status", Undo) oder error (role="alert", --danger) (issue #182)
    toast.css                Position über der Bottom-Nav, wie der FAB; toast--error für die Fehler-Variante
    row.tsx / row.css       Label-links-Control-rechts-Zeile, Basis jeder Einstellungszeile
    section-card.tsx / .css Karte mit optionaler Überschrift/Aufklappen, gruppiert Rows
    toggle.tsx / .css       Switch (role="switch"), Federknopf
    segmented-control.tsx / .css  Radiogroup mit gleitendem Auswahl-Indikator
    slider.tsx / .css       Hülle um <input type="range">, aria-valuetext
    sync-boot.tsx           startet den Sync beim Mount + fragt persistenten Storage an (issue #52)
    persist-storage.ts      navigator.storage.persist()-Anfrage, idempotent, Status per getStoragePersistenceStatus()
    e2e-bridge.tsx          Griff auf die echte Outbox für Playwright (nur NEXT_PUBLIC_E2E=1); debugPatchOutbox zum Simulieren einer poison mutation (issue #182)
    sync-status.tsx         liveQuery über db.outbox, zeigt Toast(variant=error) sobald overSyncErrorThreshold (issue #182)
tests/
  global-setup.ts           Lauf-Lock: ein zweiter E2E-Lauf bricht ab, statt die DB zu teilen
  global-teardown.ts        gibt das Lock wieder frei (nur das eigene)
  run-lock.ts               Pfad des Lockfiles + Port (Dev) + PORT_PROD (Offline-Spec), gemeinsame Quelle für Setup und Config
  helpers.ts                virtueller Authenticator, DB-Zugriff, Reset, Clock-Skew (skewClock)
  shell.spec.ts             Login, fünf Tabs (aus NAV_ITEMS abgeleitet), aktiver Tab, Header-Einstellungen, Redirect /heute/gewohnheiten (issue #123)
  nav-order.spec.ts         Karussell ab mehr Einträgen als Plätzen, aktiver Tab holt sich selbst heran, Reihenfolge in den Einstellungen + Reload, unbekannte/fehlende Ids, Sidebar ab 768px, reduced-motion, Dark Mode (issue #205)
  offline-critical.spec.ts  Kritischer Pfad SW → IndexedDB → Outbox → Postgres, läuft gegen echten Prod-Build (issue #57)
  sync.spec.ts              Outbox überlebt Reload, Tombstones, 401 ohne Session, Konfliktauflösung unter Uhrversatz (#53)
  tasks.spec.ts             Aufgabenliste: leer, Tombstone, erledigt/sortiert, offline
  uebersicht.spec.ts        /uebersicht: nur offene, heute fällige/überfällige Aufgaben, Leerzustand, TaskItem-Wiederverwendung (issue #87); Redirect/Manifest/Offline-SW-Weiterleitung von /heute (issue #161)
  capture.spec.ts           Freitext-Fälligkeit: Bestätigungs-Sheet, Direkt-Pfad + Undo, offline (issue #47)
  export.spec.ts            Export: alle Datensätze inkl. Tombstones, Schema-Version, offline
  habits.spec.ts            Gewohnheiten: anlegen, bearbeiten, archivieren/reaktivieren, offline (issue #102)
  habits-uebersicht.spec.ts Gewohnheiten in der Übersicht-Sektion: sichtbar, abhaken/zurücknehmen, Reload, Leerzustand, offline (issue #103)
  streaks.spec.ts           Streak-Badge in der Übersicht-Sektion: daily 3 Tage/ausgelassen, Tageswechsel (page.clock), weekly 2 Wochen/Reset (issue #104)
  habits-week-grid.spec.ts Monatsraster: Monatsanfang eingerückt, Blättern via ‹/›, Zellen über Monate hinweg, Vergangenheit nachträglich abhakbar, Zukunft gesperrt, Heute nur im laufenden Monat, Streak reagiert sofort, leerer Monat, offline, Tokens/Dark/reduced-motion (issue #105 → #124)
  persist-storage.spec.ts   navigator.storage.persist() beim Start: gewährt, schon gewährt, verweigert, nicht unterstützt (issue #52)
  weather.spec.ts           Wetter auf Übersicht: 7 Tage/Kürzel/Symbol/Werte, 3h-Fenster, offline, Netzausfall mit/ohne Cache, reservierte Höhe, nie in der Outbox, 375/1280px, Tokens/Dark/reduced-motion (issue #139); Wochenend-Rahmen, Stand-Zeile erst >8h + kein Layout-Shift, Nachhol-Refresh bei visibilitychange/focus/Intervall (issue #155) — ruft nie die echte Open-Meteo-API
  settings.spec.ts          Theme/Toggle/Slider, Fokus/Tastatur, reduced-motion, 60fps-Filter-Wächter; Open-Meteo-Quellenangabe (issue #155)
  schema.spec.ts            Migrationen erzeugen exakt die Tabellen/Spalten aus src/db/schema.ts (inkl. garmin_activities/garmin_tokens, issue #186)
  garmin.spec.ts            Aktivität per withDb() serverseitig angelegt (das, was der Cron schreibt) landet über den normalen Pull im IndexedDB inkl. track; offline->online ohne Outbox; Client ruft /api/garmin-sync nie auf und garmin_tokens erscheint nirgends im IndexedDB (issue #186)
scripts/
  garmin-bootstrap.md       einmaliger Handgriff im Browser fürs Garmin-OAuth1-Token, ~jährlich fällig, führt nie automatisch (ADR-0011, issue #186)
  claude-runner.sh          der autonome Runner (portabel: macOS + Linux); pr_squash_merge() übergibt Subject/Body selbst statt GitHub Commits sammeln zu lassen, reopen_falsely_closed_issues() als Netz dagegen (#172); ts_run() ist die Naht zu scripts/runner/cli.ts, RUNNER_TS=0 als Kill-Switch (#198 S1); fmt_hm/d_plus/reset_epoch/queue_order_flat/queue_pending/queue_next sind Einzeiler über ts_run mit `*_bash`-Fallback (#199 S2) -- Ausnahme: die Kontingent-erschöpft-Bailout-Meldung ruft bewusst `fmt_hm_bash` direkt, damit dieser Zweig ein garantierter No-Op bleibt (kein tsx-Start, kein gh-Aufruf); sha1_of/tier_current/tier_bump/tier_reset/resume_allowed/blocker_sig/build_escalation_eval/opus_build_cap_reached/opus_build_cap_reserve ebenso Einzeiler über ts_run mit `*_bash`-Fallback (#200 S3), `*_bash`-Kompositionen rufen einander direkt (nie über den Wrapper), um im Fallback-Fall keine zusätzlichen ts_run-Versuche zu verschwenden; STATE_DIR respektiert seit #200 einen vorab exportierten Wert (Default weiterhin `$REPO_DIR/.runner`) und wird selbst exportiert, damit der tsx-Kindprozess dasselbe Verzeichnis sieht; status() ruft `sha1_of_bash` direkt statt `sha1_of` -- über den ts_run-Wrapper würde ein fehlendes/kaputtes `tsx` sonst endlos rekursieren (status -> sha1_of -> ts_run -> status -> ...), live beobachtet als gekillter CI-Job auf #208 (#201 S4); pr_for_issue/pr_ci_state/pr_is_behind/pr_merge_state/pr_catch_up_behind/catchup_fail_reason/catchup_fail_escalated/catchup_fail_reset/pr_only_protected_paths_red/pr_squash_merge/reopen_falsely_closed_issues/pr_failure_summary ebenso Einzeiler über ts_run mit `*_bash`-Fallback, `*_bash`-Kompositionen wieder direkt verdrahtet (#201 S4); watch_running_issue/watch_parked_issues ersetzen die beiden getrennten CI-Wachen-Blöcke in run_round() durch EINEN Aufruf je Fall (JSON-Ergebnis, `kind`-diskriminiert) -- die menschenlesbaren `status()`-Texte bleiben unverändert in run_round() selbst, nur die Fallunterscheidung wandert nach scripts/runner/watch.ts; `watch_parked_issues_bash()` trägt Zwischenergebnisse über zwei Scratch-Dateien unter $STATE_DIR aus der Pipe-Subshell der `while read`-Schleife nach außen (#202 S5)
  runner/cli.ts             TS-Kern-Dispatcher: argv[2] = Kommando, unbekannt -> Exit 2 auf stderr; verdrahtet gh/git/state/clock zu einem RunnerContext, den ts_run() über `tsx` aufruft (#198 S1); Handler geben `string | null` zurück (`null` = Exit 1, kein stdout -- Pendant zu `return 1` in Bash); ab S2 (#199) Kommandos `fmt-hm`/`d-plus`/`reset-epoch`/`queue-order-flat`/`queue-pending`/`queue-next`; ab S3 (#200) zusätzlich `sha1-of`/`tier-current`/`tier-bump`/`tier-reset`/`resume-allowed`/`blocker-sig`/`build-escalation-eval`/`opus-cap-reached`/`opus-cap-reserve`; ab S4 (#201) zusätzlich `pr-for-issue`/`pr-ci-state`/`pr-is-behind`/`pr-merge-state`/`pr-catch-up-behind`/`catchup-fail-reason`/`catchup-fail-escalated`/`catchup-fail-reset`/`pr-only-protected-paths-red`/`pr-squash-merge`/`reopen-falsely-closed-issues`/`pr-failure-summary`; `CommandResult` bekommt dafür einen dritten Fall `{exitCode, stdout}` neben `string | null`, weil `pr-catch-up-behind` die vollen Zahlen-Exitcodes 0-5 seiner Bash-Vorlage braucht statt nur 0/1; ab S5 (#202) zusätzlich `watch-running-issue`/`watch-parked-issues`, beide als JSON-String (`kind`-diskriminiert)
  runner/gh.ts, git.ts      Adapter um `gh`/`git`, injizierbare exec-Funktion für Vitest-Doubles (#198 S1)
  runner/state.ts           Adapter für Dateien unter $STATE_DIR, baseDir injizierbar -- Vitest zeigt nie auf das echte .runner/ (#198 S1); `remove()` seit #200 S3 (tierReset räumt Dateien weg, entspricht `rm -f`)
  runner/clock.ts           Zeitquelle, injizierbar (createClock/createFixedClock) (#198 S1)
  runner/time.ts            fmtHm/dPlus/resetEpoch -- TS-Portierung von fmt_hm/d_plus/reset_epoch, Zeit ausschließlich über den Clock-Adapter (#199 S2)
  runner/queue.ts           queueOrderFlat/queuePending/queueNext -- TS-Portierung der Prioritäts-Queue, Leseregel (jede '#NN' zählt) unverändert (#199 S2)
  runner/tier.ts            Tier-Typ ('haiku'|'sonnet'|'opus') + tierCurrent/tierBump/tierReset -- TS-Portierung der Modell-Eskalationsleiter, Default aus dem Label 'model:haiku' (#200 S3)
  runner/escalation.ts      sha1Of/resumeAllowed/blockerSig/buildEscalationEval -- TS-Portierung von Fehlversuchs-/Wiederaufnahme-Auswertung; buildEscalationEval nutzt state/gh/git-Adapter, kein eigener ts_run-Befehl für den internen branchTip-Baustein (#200 S3)
  runner/cap.ts             opusBuildCapReached/opusBuildCapReserve -- TS-Portierung des Opus-Tagesdeckels (2 Bau-Läufe/Ticket/Tag), 'opus-boost' umgeht ihn (#200 S3)
  runner/pr.ts              PrState-Union (pending|failing|behind|success) + prForIssue/prCiState/prIsBehind/prMergeState/prOnlyProtectedPathsRed/prSquashMerge/reopenFalselyClosedIssues/prFailureSummary -- TS-Portierung der PR-Zustandslogik, kein `jq`, JSON kommt direkt vom `gh`-Adapter (#201 S4)
  runner/catchup.ts         CatchupResult-Union (ok/conflict/dirty/fetchFailed/checkoutFailed/pushFailed) + prCatchUpBehind/catchupFailReason/catchupFailEscalated/catchupFailReset -- TS-Portierung des Nachzieh-Ablaufs (fetch/checkout/merge/push über den git-Adapter); catchupExitCode/catchupStdout bilden die Union an der CLI-Kante auf die Zahlen-Exitcodes 0-5 zurück (#201 S4)
  runner/watch.ts           EINE Übergangstabelle (`watchReaction()`, WatchState × parked) statt zwei getrennter CI-Wachen -- `watchRunningIssue()`/`watchParkedIssues()` lösen `PrState` (S4) je zu einem WatchState auf (inkl. Nachziehen/Eskalation) und lassen danach dieselbe Tabelle entscheiden; Eskalation bei transienten Nachzieh-Fehlern (`behind-retry`) bleibt bewusst nur für laufende Tickets aktiv, geparkte bleiben dabei still (Status quo aus #173, keine neue Einschränkung); menschenlesbare Statustexte bleiben in claude-runner.sh, nicht hier (#202 S5)
  runner/select.ts          selfHealPark()/selectTicket()/pickTicket() -- TS-Portierung der Ticketauswahl aus `run_round`: Selbstheilung (#145, in-progress+needs-input -> parked), dann dieselbe Präzedenz wie bisher (laufend > Resume eines geparkten Tickets > Prioritäts-Queue S2 > needs-plan > needs-research > ready, je ältestes createdAt); `selectTicket()` ist rein, `pickTicket()` führt die dafür nötige Label-Mutation aus und bestimmt MODE (start/resume) (#202 S5)
  runner/status.ts          waitingIssues/parkedIssues/parkIssue/queueSnapshot/queueBody -- TS-Portierung der Statusmeldungen; `status()`/`append_end_reason()` bleiben ABSICHTLICH bash-only (Endlosrekursions-Risiko über `ts_run()`, siehe Kommentar im File) (#202 S5)
  runner/*.test.ts          Vitest-Suiten der TS-Adapter/des Dispatchers/Zeit/Queue/Eskalation/Deckel/PR-Zustände/Nachziehen/Wache/Ticketauswahl, laufen über `pnpm test` mit (#198 S1, #199 S2, #200 S3, #201 S4, #202 S5)
  tests/runner-ts.test.sh   Fixture-Tests für ts_run(): RUNNER_TS-Vorgabe ruft cli.ts auf, RUNNER_TS=0 startet tsx gar nicht, fehlendes tsx meldet sich hörbar über status() (#198 S1)
  tests/runner-ts-s2-parity.test.sh  Fixture-Tests (#199 S2): stdout/Exit-Code der sechs portierten Funktionen sind über ts_run (echtes tsx/cli.ts, REPO_DIR zeigt aufs echte Repo) und über RUNNER_TS=0 (Bash-Pfad) identisch
  tests/runner-ts-s3-parity.test.sh  Fixture-Tests (#200 S3): wie die S2-Parity-Fixture, zusätzlich STATE_DIR als eigenes Wegwerf-Verzeichnis je Pfad (vorab exportiert, claude-runner.sh respektiert es) und gh/git-Stubs wie escalation.test.sh, weil die neun S3-Funktionen (anders als S2) Zustand unter $STATE_DIR lesen/schreiben und teils `gh`/`git` aufrufen
  tests/runner-ts-s4-parity.test.sh  Fixture-Tests (#201 S4): wie die S3-Parity-Fixture, zusätzlich GHSTATE_DIR als eigenes Wegwerf-Verzeichnis je Pfad (wie STATE_DIR), weil pr_squash_merge/reopen_falsely_closed_issues keinen eigenen stdout-Vertrag haben, sondern nur über gh-Seiteneffekte (Marker-Dateien) vergleichbar sind; gh/git-Stubs Obermenge aus ci-watch.test.sh + squash-close-guard.test.sh
  tests/runner-ts-s5-parity.test.sh  Fixture-Tests (#202 S5): wie die S4-Parity-Fixture für die neun neu portierten Funktionen (self_heal_park, pick_ticket, waiting_issues, parked_issues, park_issue, queue_snapshot, queue_body, watch_running_issue, watch_parked_issues); deckte einen echten Bash/TS-Unterschied in `pr_failure_summary` auf (trailing Newline verschwindet in Bash durch `$(...)`-Einbettung, in TS nicht, weil `watchRunningIssue()` sie ohne Subshell-Grenze direkt einbettet) -- gefixt in `runner/pr.ts` durch explizites Trimmen
  tests/status-queue.test.sh  Fixture-Tests für den Queue-Peek des Status-Tickets (#48)
  tests/round-snap.test.sh    ROUND_SNAP-Sortierung (createdAt statt Nummer) + Session-ID-Regel (#64)
  check-test-integrity.sh   Wächter gegen abgeschwächte Tests
  check-sync-invariants.sh  Wächter gegen direkten fetch(/api/) außerhalb der Outbox (#58); Trenner-Slash Pflicht, sonst false-positiv auf Fremdquellen wie https://api.open-meteo.com (#139)
  check-dexie-bump.sh       Hinweis (kein Gate): Server-Migration ohne Dexie-Versions-Bump (#59)
  tests/dexie-bump.test.sh  Fixture-Tests für check-dexie-bump.sh (#59)
  tests/limit-until.test.sh Fixture-Tests: abgelaufenes 'limit-until' hebt die Pause selbst auf, aktives bleibt unangetastet, fehlender/kaputter Wert pausiert nicht dauerhaft (#121)
  tests/opus-boost.test.sh Fixture-Tests (T1-T7): Label 'opus-boost' umgeht den Opus-Tagesdeckel je Ticket ohne Zähler-Reset, wird bei Nicht-Fortschritt abgezogen, no-escalation gewinnt, Erschöpfungsmeldung nur einmal/Tag (#136)
  tests/ci-watch.test.sh   Fixture-Tests (T1-T9): CI-Wache vor der Ticketauswahl -- laeuft noch/gruen/rot/nur-protected-paths-rot/noch-kein-PR/kein-Ticketwechsel waehrend CI laeuft (#147); Zustand 'behind' zieht main per git nach, Konflikt startet Fix-Agenten, geparkte Tickets ohne Agentenlauf (#160)
  tests/parked-label.test.sh Fixture-Tests: in-progress+needs-input wird zu 'parked' (Selbstheilung), ein zuvor geparktes Ticket wird vor Queue/Label-Kaskade fortgesetzt, Status nennt parkende Tickets zusätzlich (#145)
  tests/parked-ci-watch.test.sh Fixture-Tests (T1-T6): CI-Wache für ALLE 'parked'-Tickets gleichzeitig -- gruen wird freigegeben (ready+Auto-Merge, kein Agentenlauf), pending/rot bleibt geparkt, laufendes Ticket wird nicht verzögert, Status nennt die Freigabe (#154)
  tests/squash-close-guard.test.sh Fixture-Tests (T1-T5): pr_squash_merge() traegt eigenen PR-Titel als Subject, leeres Body statt Commit-Historie; fremde 'Closes #N' aus mitgezogenen Merge-Commits (nachgestellter Fall #163/#168) bleiben aussen vor; reopen_falsely_closed_issues() als Netz oeffnet faelschlich geschlossene Tickets mit offenem eigenen PR wieder (#172)
  bootstrap-github.sh       einmaliges GitHub-Setup (Labels, Milestones, Branch-Schutz)
  vercel-build.sh           Release-Schritt: wendet Migrationen vor next build an (nur Production)
  smoke-decide.sh           Post-Deploy-Smoke: HEALTHY/REVERT/AMBIGUOUS aus Health+Version+Playwright
  launchd-setup.md          Runner als Dienst auf macOS
  systemd-setup.md          Runner als Dienst auf Linux
.github/workflows/
  ci.yml                    Lint, Typecheck, Vitest, Playwright, Schema-Drift-Gate; läuft nur bei echten Code-Änderungen (opened/synchronize/reopened), nicht bei Label-Events (issue #164)
  guards.yml                Test-Integrity- und Protected-Paths-Gate; hören zusätzlich auf labeled/unlabeled, damit ein Label-Tap (human-approved/tests-exempt) nur diese beiden neu prüft statt der ganzen CI (issue #164)
  smoke.yml                 Post-Deploy-Smoke gegen Prod, Auto-Revert bei rot
  interaction-limit-reminder.yml  monatlicher Cron, erinnert 30 Tage vor Ablauf des Interaction Limit per Issue (#70)
  garmin-sync.yml           nächtlicher Cron, POST /api/garmin-sync mit Bearer-Secret, vendor-neutral statt Vercel-Cron (Regel 7, issue #186)
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
