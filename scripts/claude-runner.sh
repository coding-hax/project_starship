#!/usr/bin/env bash
# Claude-Runner: pollt GitHub Issues, arbeitet EIN Ticket, überlebt Limits.
# Läuft per launchd (macOS) oder systemd (Linux) alle 5 Minuten.
#
# Braucht: gh, jq und die EIGENSTÄNDIGE claude-CLI im PATH.
# (Die VS-Code-Erweiterung zählt nicht — sie legt `claude` nicht in den PATH.)
#
# Bewusst OHNE flock und timeout: beides sind GNU-Werkzeuge und fehlen auf macOS.
# Das Skript bringt portable Ersatzlösungen mit und läuft so auf beiden Systemen.
set -uo pipefail

REPO_DIR="${REPO_DIR:-$HOME/dev/project_starship}"
STATUS_ISSUE="${STATUS_ISSUE:-0}"       # Nr. des angepinnten Runner-Status-Issues
QUEUE_ISSUE="${QUEUE_ISSUE:-0}"         # Nr. des Prioritäts-Queue-Issues (0 = aus)
MAX_RUNTIME="${MAX_RUNTIME:-2700}"      # Sekunden. Notbremse gegen hängende Läufe -- PRO LAUF.
MAX_ROUNDS="${MAX_ROUNDS:-3}"           # Ticket-Chaining (#61): max. Runden PRO TICK.
TICK_BUDGET="${TICK_BUDGET:-$MAX_RUNTIME}"  # Sek.-Budget/Tick, vor jeder neuen Runde geprüft.
RUNNER_TS="${RUNNER_TS:-1}"             # Kill-Switch (#198): 0 erzwingt den Bash-Pfad, siehe ts_run()
# Default wie bisher $REPO_DIR/.runner; ein vorab exportiertes STATE_DIR
# (Parity-Fixture #200) gewinnt -- UND wird seinerseits exportiert, damit der
# per ts_run() gestartete tsx-Kindprozess (scripts/runner/state.ts liest
# process.env.STATE_DIR) exakt dasselbe Verzeichnis sieht wie dieser Bash-Pfad.
STATE_DIR="${STATE_DIR:-$REPO_DIR/.runner}"
export STATE_DIR
LIMIT_UNTIL="$STATE_DIR/limit-until"   # Unix-Zeit, bis zu der das Kontingent leer ist

cd "$REPO_DIR" || { echo "REPO_DIR nicht gefunden: $REPO_DIR" >&2; exit 1; }
mkdir -p "$STATE_DIR"

for tool in gh jq claude; do
  command -v "$tool" >/dev/null 2>&1 || { echo "'$tool' fehlt im PATH." >&2; exit 1; }
done

ts() { date "+%d.%m. %H:%M"; }

# Unix-Zeit -> "Mo 14:51". BSD (macOS) und GNU (Linux) sprechen hier verschiedene
# Dialekte, deshalb jeweils beide Varianten. TS-Kern: scripts/runner/time.ts,
# `fmtHm()`/`dPlus()` (#199) -- ts_run() ist erst weiter unten definiert, das
# ist ok: Bash loest Funktionsnamen erst beim AUFRUF auf, nicht beim Sourcen.
fmt_hm_bash()  { date -r "$1" "+%a %H:%M" 2>/dev/null || date -d "@$1" "+%a %H:%M" 2>/dev/null; }
d_plus_bash()  { date -v+"$1"d "+$2" 2>/dev/null || date -d "+$1 day" "+$2" 2>/dev/null; }

fmt_hm() {   # $1 = Unix-Zeit -> "Mo 14:51"
  local out rc
  out=$(ts_run fmt-hm "$1"); rc=$?
  [ "$rc" -eq 127 ] && { fmt_hm_bash "$1"; return; }
  printf '%s' "$out"
  return "$rc"
}
d_plus() {   # $1 = Tage, $2 = date-Format -> "heute + $1 Tage" formatiert
  local out rc
  out=$(ts_run d-plus "$1" "$2"); rc=$?
  [ "$rc" -eq 127 ] && { d_plus_bash "$1" "$2"; return; }
  printf '%s' "$out"
  return "$rc"
}

# Wann kommt das Kontingent zurueck? Liest die Reset-Angabe aus der Claude-Meldung
# und gibt eine Unix-Zeit aus (oder nichts, wenn sie sich nicht deuten laesst).
#
# Die CLI formatiert den Zeitpunkt in genau zwei Formen (formatResetTime):
#   <= 24h entfernt:  "… session limit \xB7 resets 2:50pm (Europe/Berlin)"   -> nur Uhrzeit
#    > 24h entfernt:  "… weekly limit  \xB7 resets Jul 17, 5:09pm (…)"       -> mit Datum
#                     "… weekly limit  \xB7 resets Jan 30, 2027, 4:09pm (…)" -> mit Jahr
# Minuten fehlen bei :00 ("resets 9pm"). am/pm ist immer da (hour12).
#
# Trotzdem Best Effort: der Wortlaut ist nicht garantiert. Kein Treffer -> leer ->
# der Aufrufer faellt auf den 5-Minuten-Takt zurueck. Ein Fehlparsen darf den
# Runner nie stilllegen.
#
# Ueberall ERE (grep -E / sed -E), nirgends BRE-Alternation (\|) — die ist eine
# GNU-Erweiterung und tut auf macOS still gar nichts.
#
# TS-Kern: scripts/runner/time.ts, `resetEpoch()` (#199).
reset_epoch() {   # $1 = Claude-CLI-Meldungstext -> Unix-Zeit (Exit 1 = kein Treffer)
  local out rc
  out=$(ts_run reset-epoch "$1"); rc=$?
  [ "$rc" -eq 127 ] && { reset_epoch_bash "$1"; return; }
  printf '%s' "$out"
  return "$rc"
}

reset_epoch_bash() {
  local txt now rest mon dnum yr tm fmt ts_out cap
  txt=$(printf '%s' "$1" | tr 'A-Z' 'a-z')
  case "$txt" in *resets*) ;; *) return 1 ;; esac
  now=$(date +%s)

  # Nur der Teil hinter "resets"; die Zeitzone in Klammern fliegt raus.
  rest=${txt#*resets}
  rest=$(printf '%s' "$rest" | sed -E 's/\([^)]*\)//g')

  # Uhrzeit — am/pm ist Pflicht, sonst wuerde die Tageszahl ("17") mitgelesen.
  tm=$(printf '%s' "$rest" | grep -oE '[0-9]{1,2}(:[0-9]{2})?(am|pm)' | head -1)
  [ -z "$tm" ] && return 1

  # Bei glatter Stunde laesst die CLI die Minuten weg ("9pm"). Die muessen wir
  # ergaenzen: 'date -j -f' fuellt fehlende Felder aus der AKTUELLEN Zeit auf —
  # "9pm" um 17:41 ergaebe sonst 21:41 statt 21:00.
  case "$tm" in *:*) ;; *) tm=$(printf '%s' "$tm" | sed -E 's/^([0-9]{1,2})(am|pm)$/\1:00\2/') ;; esac

  # Monatskuerzel -> der Reset ist mehr als 24h weg (Wochenlimit).
  mon=$(printf '%s' "$rest" \
        | grep -oE '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)' | head -1)

  if [ -n "$mon" ]; then
    # Wochenlimit: Datum ist da, also exakt bestimmbar.
    dnum=$(printf '%s' "$rest" | sed -E "s/.*${mon}[^0-9]*([0-9]{1,2}).*/\1/")
    yr=$(printf '%s' "$rest" | grep -oE '[0-9]{4}' | head -1)
    [ -z "$yr" ] && yr=$(date +%Y)
    ts_out=$(date -j -f "%b %d %Y %I:%M%p" "$mon $dnum $yr $tm" "+%s" 2>/dev/null) \
      || ts_out=$(date -d "$mon $dnum $yr $tm" "+%s" 2>/dev/null)
    [ -z "${ts_out:-}" ] && return 1
    ts_out=$((ts_out + 60))                        # eine Minute Puffer
    [ $((ts_out - now)) -le 0 ] && return 1
    # Absurd weit weg (Guthaben-Reset in Monaten)? Hoechstens 7 Tage am Stueck
    # schlafen, dann neu bewerten. Zu frueh aufzuwachen kostet nichts: der Lauf
    # bekommt sofort wieder 429 und pausiert erneut.
    [ $((ts_out - now)) -gt 604800 ] && ts_out=$((now + 604800))
  else
    # Session-Limit: nur eine Uhrzeit, kein Datum -> sie liegt <= 24h voraus.
    ts_out=$(date -j -f "%I:%M%p" "$tm" "+%s" 2>/dev/null) \
      || ts_out=$(date -d "today $tm" "+%s" 2>/dev/null)
    [ -z "${ts_out:-}" ] && return 1
    # Liegt die Uhrzeit schon hinter uns, ist der Reset nach Mitternacht gemeint.
    [ "$ts_out" -le "$now" ] && ts_out=$((ts_out + 86400))
    ts_out=$((ts_out + 60))                        # eine Minute Puffer
    # Ein Session-Limit setzt nach spaetestens ~5h aus. Alles darueber ist ein
    # alter Log oder ein Fehlparsen — dann NICHT pausieren, sondern verwerfen und
    # den 5-Minuten-Takt weiterlaufen lassen. Lieber umsonst aufwachen (429 ist
    # gratis) als stundenlang blind schlafen.
    [ $((ts_out - now)) -gt 21600 ] && return 1
  fi

  printf '%s' "$ts_out"
}

# Status-Issue per EDIT aktualisieren, nicht per Kommentar
# (sonst bekommst du bei jedem Lauf eine Push-Nachricht aufs Handy).
#
# Die Farbe steht im TITEL, nicht nur im Text: auf dem Handy sieht man in der
# Issue-Liste sonst nur die statische Ampel und muss reinklicken, um den Zustand
# zu erfahren. Genau das soll man sich sparen.
#
#   🟠 arbeitet an #N   – Lauf ist unterwegs, vor dem `claude`-Aufruf gesetzt
#   🟢 wartet/nichts offen – Ruhe: nächster Takt startet ggf. automatisch, kein Eingreifen
#   🟡 wartet auf dich  – EINGREIFEN (Frage offen oder Freigabe nötig)
#   🔴 Fehler           – EINGREIFEN
#   🔵 Limit erreicht   – pausiert, läuft von selbst weiter
#   ⚪️ nichts zu tun    – kein Ticket auf `ready`
# Nur bei inhaltlicher Aenderung schreiben (#64): status() editierte bisher
# bedingungslos, "⚪️ nichts zu tun" landet so 72x am Tag identisch neu im
# Issue. sha1 ueber Titel+Emoji+Text -- ausdruecklich OHNE den "_Stand:_"-
# Zeitstempel, den die Funktion selbst erst unten anhaengt, sonst waere der
# Hash immer verschieden und die Optimierung wirkungslos. Datei bleibt leer
# (kein Schreiben), wenn gh fehlschlaegt -- der naechste Aufruf versucht es
# dann erneut, egal ob inhaltlich gleich oder nicht.
#
# RELEASED_PARKED_NOTE (#154): wird VOR jedem status()-Aufruf einmal pro
# Runde von der Parked-CI-Wache gesetzt (leer, wenn in dieser Runde nichts
# freigegeben wurde) und hier an JEDEN Text angehaengt -- so ist die Freigabe
# sichtbar, unabhaengig davon, welcher der vielen status()-Aufrufe im Rest der
# Runde tatsaechlich greift, ohne jede einzelne Aufrufstelle anzufassen.
STATUS_HASH_FILE="$STATE_DIR/status-hash"
status() {   # $1 = Titelzeile (ohne Emoji), $2 = Emoji, $3 = Text
  [ "$STATUS_ISSUE" -gt 0 ] 2>/dev/null || return 0
  local sig text
  text="$3${RELEASED_PARKED_NOTE:-}"
  # sha1_of_bash direkt, NICHT sha1_of(): ts_run() ruft bei rc=127 seinerseits
  # status() auf (TS-Naht-ausgefallen-Meldung) -- ueber den ts_run-Wrapper waere
  # das eine Endlosrekursion (status -> sha1_of -> ts_run -> status -> ...),
  # sobald tsx fehlt/kaputt ist. Gleiches Muster wie fmt_hm_bash im
  # Kontingent-Bailout: dieser Pfad muss ein garantierter No-Op-Baustein bleiben.
  sig=$(sha1_of_bash "$2 Runner · $1"$'\x1e'"$text")
  [ "$(cat "$STATUS_HASH_FILE" 2>/dev/null)" = "$sig" ] && return 0
  gh issue edit "$STATUS_ISSUE" \
    --title "$2 Runner · $1" \
    --body "$text

_Stand: $(ts)_" >/dev/null 2>&1 && printf '%s' "$sig" > "$STATUS_HASH_FILE"
}

# Traegt den skriptseitig bekannten Endgrund (Limit/Notbremse) in den
# BESTEHENDEN Fortschrittskommentar nach -- der Agent kennt beim Abbruch
# selbst nur "gate-rot"/"frage-offen" (siehe Prompt), nicht Limit/Timeout, denn
# der Prozess ist in dem Moment schon tot. Kein neuer Kommentar, keine Flut:
# nur anhaengen und per --edit-last zurueckschreiben. Gibt es (noch) keinen
# Fortschrittskommentar (Lauf brach ganz frueh ab), passiert nichts -- der
# Status-Issue-Text reicht dann aus.
append_end_reason() {   # $1 = Issue-Nr, $2 = Endgrund-Text
  local issue="$1" reason="$2" last
  last=$(gh issue view "$issue" --json comments -q '.comments[-1].body // empty' 2>/dev/null)
  case "$last" in
    *"Fortschritt (automatisch aktualisiert)"*)
      gh issue comment "$issue" --edit-last --body "$last

_Lauf-Ende $(ts): ${reason}, unfertig — nächster Lauf macht weiter._" >/dev/null 2>&1
      ;;
    *) ;;
  esac
}

# Wartet irgendein Ticket auf den Menschen? Dann ist Gelb die Wahrheit,
# auch wenn der Runner selbst gerade nichts zu tun hat.
# TS-Kern: scripts/runner/status.ts, `waitingIssues()` (#202 S5).
waiting_issues() {
  local out rc
  out=$(ts_run waiting-issues); rc=$?
  [ "$rc" -eq 127 ] && { waiting_issues_bash; return; }
  printf '%s' "$out"
  return "$rc"
}

waiting_issues_bash() {
  gh issue list --label needs-input --state open --limit 20 \
    --json number -q '[.[].number] | map("#" + tostring) | join(", ")' 2>/dev/null
}

# Liegt gerade ein 'parked'-Ticket (#145) herum, waehrend an einem anderen
# gebaut wird? Fuer den Status-Text der 🟠-"arbeitet an"-Meldung -- vorher
# konnte "wartet auf dich" und "arbeitet an X" nicht gleichzeitig gelten, jetzt
# schon, und das Status-Ticket muss beides zeigen (#145 AC6).
# TS-Kern: scripts/runner/status.ts, `parkedIssues()` (#202 S5).
parked_issues() {
  local out rc
  out=$(ts_run parked-issues); rc=$?
  [ "$rc" -eq 127 ] && { parked_issues_bash; return; }
  printf '%s' "$out"
  return "$rc"
}

parked_issues_bash() {
  gh issue list --label parked --state open --limit 20 \
    --json number -q '[.[].number] | map("#" + tostring) | join(", ")' 2>/dev/null
}

# Nimmt einem Ticket 'in-progress' ab und gibt 'parked' -- die zentrale Stelle
# fuer die Selbstheilung (#145), gebraucht sowohl fuer den Rundenanfang als
# auch sofort nach einem Lauf, in dem Claude selbst 'needs-input' gesetzt hat.
# TS-Kern: scripts/runner/status.ts, `parkIssue()` (#202 S5).
park_issue() {   # $1 = Issue-Nr
  local rc
  ts_run park-issue "$1" >/dev/null; rc=$?
  [ "$rc" -eq 127 ] && { park_issue_bash "$1"; return; }
  return "$rc"
}

park_issue_bash() {
  gh issue edit "$1" --remove-label in-progress --add-label parked >/dev/null 2>&1
}

# Einmaliger Schnappschuss aller offenen Issues mit Labels. Braucht 'createdAt'
# genau wie ROUND_SNAP (siehe run_round()) -- sonst sortiert queue_next() unten
# gegen ein fehlendes Feld und faellt auf die API-Reihenfolge zurueck, statt
# wirklich das aelteste Ticket zu waehlen (#149).
# TS-Kern: scripts/runner/status.ts, `queueSnapshot()` (#202 S5).
queue_snapshot() {
  local out rc
  out=$(ts_run queue-snapshot); rc=$?
  [ "$rc" -eq 127 ] && { queue_snapshot_bash; return; }
  printf '%s' "$out"
  return "$rc"
}

queue_snapshot_bash() {
  gh issue list --state open --limit 50 --json number,labels,createdAt 2>/dev/null || echo '[]'
}

# --- Prioritäts-Queue (#91, umgebaut #109) ----------------------------------
# Ein vom Menschen editierbares Issue (QUEUE_ISSUE) ist eine FLACHE REIHENFOLGE
# von '#NN'. Wer gelistet ist, wird bearbeitet — in genau dieser Reihenfolge,
# das Label ist für die AUSWAHL egal (das Eintragen ersetzt 'ready'). Ausnahmen,
# die erhalten bleiben: 'needs-input'/'no-opus' schließen weiter aus; die ROLLE
# kommt aus dem Label ('needs-plan' -> Planlauf, 'needs-research' -> Recherche,
# sonst bauen). Nicht Gelistetes läuft über den Fallback (Label-Reihenfolge nach
# createdAt). Leeres/fehlendes Queue-Issue -> exakt Fallback-Verhalten.

# Holt den Queue-Body EINMAL pro Tick (leer, wenn kein QUEUE_ISSUE gesetzt).
# TS-Kern: scripts/runner/status.ts, `queueBody()` (#202 S5).
queue_body() {
  local out rc
  out=$(ts_run queue-body "${QUEUE_ISSUE:-0}"); rc=$?
  [ "$rc" -eq 127 ] && { queue_body_bash; return; }
  printf '%s' "$out"
  return "$rc"
}

queue_body_bash() {
  [ "${QUEUE_ISSUE:-0}" -gt 0 ] 2>/dev/null || { printf ''; return 0; }
  gh issue view "$QUEUE_ISSUE" --json body -q '.body // ""' 2>/dev/null || printf ''
}

# $1 = Body-Text -> JSON-Array ALLER '#NN' in Dokumentreihenfolge
# (dublettenbereinigt). Überschriften/Text drumherum sind egal; es zählt nur die
# Reihenfolge der Nummern. Bogus-Nummern (kein offenes Ticket) sind harmlos — die
# Auswahl unten iteriert reale Tickets und ignoriert Ränge ohne Treffer.
#
# TS-Kern: scripts/runner/queue.ts, `queueOrderFlat()`/`queuePending()`/
# `queueNext()` (#199).
queue_order_flat() {   # $1 = Body-Text -> JSON-Array
  local out rc
  out=$(ts_run queue-order-flat "${1:-}"); rc=$?
  [ "$rc" -eq 127 ] && { queue_order_flat_bash "${1:-}"; return; }
  printf '%s' "$out"
  return "$rc"
}

queue_order_flat_bash() {
  local body="${1:-}"
  [ -n "$body" ] || { printf '[]'; return 0; }
  printf '%s\n' "$body" \
    | { grep -oE '#[0-9]+' || true; } \
    | tr -d '#' \
    | jq -R 'select(length > 0) | tonumber' \
    | jq -sc 'reduce .[] as $n ([]; if index($n) then . else . + [$n] end)'
}

# Offene Queue-Arbeit als "#a, #b" (leer = nichts offen).
# ready|needs-plan|needs-research, jeweils OHNE needs-input. (#1/Status-Issue
# trägt keins dieser Labels und fällt automatisch raus.)
queue_pending() {   # $1 = snapshot-json
  local out rc
  out=$(ts_run queue-pending "$1"); rc=$?
  [ "$rc" -eq 127 ] && { queue_pending_bash "$1"; return; }
  printf '%s' "$out"
  return "$rc"
}

queue_pending_bash() {
  printf '%s' "$1" | jq -r '
    [ .[] | (.labels|map(.name)) as $l
      | select( ($l|index("ready")) or ($l|index("needs-plan")) or ($l|index("needs-research")) )
      | select( ($l|index("needs-input"))|not )
      | .number ]
    | sort | map("#"+tostring) | join(", ")' 2>/dev/null
}

# Das Ticket, das der Runner beim NÄCHSTEN Takt tatsächlich nähme — dieselbe
# Präzedenz wie main(): in-progress -> needs-plan -> ready. Leer, wenn nichts
# baubereit ist (z. B. nur needs-research offen).
queue_next() {   # $1 = snapshot-json, $2 = queue-body (optional)
  local out rc
  out=$(ts_run queue-next "$1" "${2:-}"); rc=$?
  [ "$rc" -eq 127 ] && { queue_next_bash "$1" "${2:-}"; return; }
  printf '%s' "$out"
  return "$rc"
}

queue_next_bash() {
  printf '%s' "$1" | jq -r --argjson order "$(queue_order_flat_bash "${2:-}")" '
    def has($l): .labels | map(.name) | index($l);
    # Dieselbe Präzedenz wie die Auswahl in run_round: laufendes in-progress,
    # dann die flache Queue (Label egal), dann die Label-Reihenfolge als Fallback.
    ( ( [ .[] | select(has("in-progress")) | select(has("needs-input")|not) ]
          | sort_by(.createdAt) | .[0].number )
      // ( [ .[] | (.number) as $n | ($order|index($n)) as $r
            | select($r != null) | select(has("needs-input")|not) | select(has("no-opus")|not)
            | {number:$n, r:$r} ] | sort_by(.r) | .[0].number )
      // ( [ .[] | select(has("needs-plan")) | select(has("needs-input")|not) | select(has("no-opus")|not) ]
            | sort_by(.createdAt) | .[0].number )
      // ( [ .[] | select(has("ready")) | select(has("needs-input")|not)
              | select(has("needs-plan")|not) | select(has("needs-research")|not) ]
            | sort_by(.createdAt) | .[0].number )
    ) // empty' 2>/dev/null
}

# --- Modell-Eskalation beim Bauen (ADR-0007) --------------------------------
# Sourcebare Hilfsfunktionen, rein dateibasiert unter $STATE_DIR -- damit ohne
# einen echten Lauf testbar (siehe scripts/tests/escalation.test.sh). Betrifft
# ausschließlich RUN_ROLE=build; die nur-lesenden Denk-Rollen aus ADR-0005
# (Planung, Feature-Recherche) laufen unveraendert immer mit Opus, ohne Stufen.

# Portable sha1: macOS bringt 'shasum', Linux ueblicherweise 'sha1sum'.
# TS-Kern: scripts/runner/escalation.ts, `sha1Of()` (#200).
sha1_of() {   # $1 = Text -> Hex-Hash
  local out rc
  out=$(ts_run sha1-of "$1"); rc=$?
  [ "$rc" -eq 127 ] && { sha1_of_bash "$1"; return; }
  printf '%s' "$out"
  return "$rc"
}

sha1_of_bash() {
  printf '%s' "$1" | shasum -a 1 2>/dev/null | cut -d' ' -f1 \
    || printf '%s' "$1" | sha1sum 2>/dev/null | cut -d' ' -f1
}

# Aktuelle Bau-Modellstufe fuer ein Ticket. Kein tier-<nr> (noch nie
# eskaliert) -> Default aus dem Label 'model:haiku', sonst 'sonnet'.
# TS-Kern: scripts/runner/tier.ts, `tierCurrent()` (#200).
tier_current() {   # $1 = Issue-Nr -> sonnet|opus|haiku
  local out rc
  out=$(ts_run tier-current "$1"); rc=$?
  [ "$rc" -eq 127 ] && { tier_current_bash "$1"; return; }
  printf '%s' "$out"
  return "$rc"
}

tier_current_bash() {
  local issue="$1"
  local f="$STATE_DIR/tier-$issue"
  if [ -s "$f" ]; then
    cat "$f"
    return 0
  fi
  if gh issue view "$issue" --json labels -q '.labels[].name' 2>/dev/null \
       | grep -qx "model:haiku"; then
    echo haiku
  else
    echo sonnet
  fi
}

# Schaltet eine Stufe hoch. Die Leiter hat nur einen Sprung: sonnet/haiku -> opus.
# Auf opus (Spitze) angekommen: kein weiterer Bump, Rueckgabe 1 signalisiert
# "erschoepft" an den Aufrufer.
# TS-Kern: scripts/runner/tier.ts, `tierBump()` (#200).
tier_bump() {   # $1 = Issue-Nr
  ts_run tier-bump "$1" >/dev/null
  local rc=$?
  [ "$rc" -eq 127 ] && { tier_bump_bash "$1"; return; }
  return "$rc"
}

tier_bump_bash() {
  local issue="$1"
  [ "$(tier_current_bash "$issue")" = "opus" ] && return 1
  echo opus > "$STATE_DIR/tier-$issue"
  echo 0 > "$STATE_DIR/failcount-$issue"
  return 0
}

# Zurueck auf die Default-Stufe -- nach Fortschritt (siehe build_escalation_eval).
# TS-Kern: scripts/runner/tier.ts, `tierReset()` (#200).
tier_reset() {   # $1 = Issue-Nr
  ts_run tier-reset "$1" >/dev/null
  local rc=$?
  [ "$rc" -eq 127 ] && { tier_reset_bash "$1"; return; }
  return "$rc"
}

tier_reset_bash() {
  local issue="$1"
  rm -f "$STATE_DIR/tier-$issue" "$STATE_DIR/failcount-$issue" \
        "$STATE_DIR/blocker-sig-$issue" "$STATE_DIR/branch-head-$issue"
}

# Resume-Deckel (#62): Nach 20+ Minuten ist der Prompt-Cache kalt; ein --resume
# spielt die ganze bisherige Konversation als frische Input-Tokens erneut ein.
# Der Bau-Stand liegt ohnehin in Git + Fortschrittskommentar -- ein frischer
# Start ist also sicher. Deshalb: nach 2 Fortsetzungen einer Session frisch
# starten. Zaehler dateibasiert je Ticket unter $STATE_DIR (analog failcount).
# TS-Kern: scripts/runner/escalation.ts, `resumeAllowed()` (#200).
resume_allowed() {   # $1 = Issue-Nr -> 0 (resume ok, zaehlt hoch) / 1 (kappen, Reset)
  ts_run resume-allowed "$1" >/dev/null
  local rc=$?
  [ "$rc" -eq 127 ] && { resume_allowed_bash "$1"; return; }
  return "$rc"
}

resume_allowed_bash() {
  local issue="$1" f cnt
  f="$STATE_DIR/resume-count-$issue"
  cnt=$(cat "$f" 2>/dev/null || echo 0)
  if [ "${cnt:-0}" -ge 2 ]; then
    echo 0 > "$f"
    return 1
  fi
  echo $((cnt + 1)) > "$f"
  return 0
}

# sha1 der Blocker-Kennzeilen (Endgrund + Wiederaufnahmestelle) aus dem
# LETZTEN Kommentar -- aber nur, wenn das ueberhaupt der Fortschrittskommentar
# ist (#33). Kein Fortschrittskommentar (Lauf brach ganz frueh ab) -> leer.
# TS-Kern: scripts/runner/escalation.ts, `blockerSig()` (#200).
blocker_sig() {   # $1 = Issue-Nr
  local out rc
  out=$(ts_run blocker-sig "$1"); rc=$?
  [ "$rc" -eq 127 ] && { blocker_sig_bash "$1"; return; }
  printf '%s' "$out"
  return "$rc"
}

blocker_sig_bash() {
  local issue="$1" last body
  last=$(gh issue view "$issue" --json comments -q '.comments[-1].body // empty' 2>/dev/null)
  case "$last" in
    *"Fortschritt (automatisch aktualisiert)"*) ;;
    *) return 0 ;;
  esac
  body=$(printf '%s' "$last" | grep -E "Lauf-Ende|← HIER WEITER|Endgrund" 2>/dev/null)
  [ -z "$body" ] && return 0
  sha1_of_bash "$body"
}

# SHA der Feature-Branch-Spitze auf origin (leer, wenn (noch) kein Branch existiert).
branch_tip() {   # $1 = Issue-Nr
  local issue="$1"
  git ls-remote --heads origin \
        "feat/${issue}-*" "fix/${issue}-*" "chore/${issue}-*" 2>/dev/null \
    | awk '{print $1}' | head -1
}

# --- Draft-PR-Lifecycle (#147) -----------------------------------------------
# Der Bau-Agent endet nach dem Push und hinterlaesst hoechstens einen offenen
# Draft-PR. Ab hier wacht der Runner-TAKT selbst ueber die CI -- ein Agent
# startet nur noch, wenn es wirklich etwas zu TUN gibt (rote Checks).

# Offener PR zu einem Ticket, gefunden ueber die Branch-Konvention
# (feat|fix|chore/<nr>-<slug>) -- keine Textsuche im Titel noetig.
# TS-Kern: scripts/runner/pr.ts, `prForIssue()` (#201).
pr_for_issue() {   # $1 = Issue-Nr -> PR-Nummer (leer, wenn keiner offen)
  local out rc
  out=$(ts_run pr-for-issue "$1"); rc=$?
  [ "$rc" -eq 127 ] && { pr_for_issue_bash "$1"; return; }
  printf '%s' "$out"
  return "$rc"
}

pr_for_issue_bash() {
  local issue="$1"
  gh pr list --state open --limit 20 --json number,headRefName 2>/dev/null \
    | jq -r --arg pat "^(feat|fix|chore)/${issue}-" \
        '[.[] | select(.headRefName | test($pat))] | .[0].number // empty'
}

# CI-Gesamtzustand eines PR: pending | failing | behind | success. Reihenfolge
# ist Absicht (#160): 'pending' hat Vorrang vor 'failing' -- ein noch
# laufender Shard darf einen bereits roten Check nicht uebertoenen. 'behind'
# wird erst geprueft, NACHDEM feststeht, dass nichts mehr laeuft und nichts
# rot ist -- ein zurueckgefallener Branch mit rotem Check wird also erst
# repariert, nicht vorschnell nachgezogen.
# TS-Kern: scripts/runner/pr.ts, `prCiState()` (#201).
pr_ci_state() {   # $1 = PR-Nr
  local out rc
  out=$(ts_run pr-ci-state "$1"); rc=$?
  [ "$rc" -eq 127 ] && { pr_ci_state_bash "$1"; return; }
  printf '%s' "$out"
  return "$rc"
}

pr_ci_state_bash() {
  local pr="$1" json total pending failing
  json=$(gh pr checks "$pr" --json bucket,name,description,link 2>/dev/null)
  total=$(printf '%s' "$json" | jq 'length' 2>/dev/null || echo 0)
  if [ "${total:-0}" -eq 0 ]; then echo pending; return 0; fi
  pending=$(printf '%s' "$json" | jq '[.[] | select(.bucket=="pending")] | length')
  if [ "${pending:-0}" -gt 0 ]; then echo pending; return 0; fi
  failing=$(printf '%s' "$json" \
    | jq '[.[] | select(.bucket=="fail" or .bucket=="cancel")] | length')
  if [ "${failing:-0}" -gt 0 ]; then echo failing; return 0; fi
  if pr_is_behind_bash "$pr"; then echo behind; return 0; fi
  echo success
}

# GitHub berechnet mergeStateStatus serverseitig -- BEHIND heisst: der
# PR-Branch hat Commits von 'main' noch nicht. Kein eigener git-Vergleich
# noetig, kein 'gh pr update-branch' (#160: scheitert an Workflow-Dateien
# ohne 'workflow'-Scope).
# TS-Kern: scripts/runner/pr.ts, `prMergeState()` (#201) -- ts_run liefert
# das JSON unveraendert durch (oder gar nichts + Exit 1, wenn `gh` scheitert).
pr_merge_state() {   # $1 = PR-Nr -> JSON {headRefName, mergeStateStatus}
  local out rc
  out=$(ts_run pr-merge-state "$1"); rc=$?
  [ "$rc" -eq 127 ] && { pr_merge_state_bash "$1"; return; }
  printf '%s' "$out"
  return "$rc"
}

pr_merge_state_bash() {
  gh pr view "$1" --json headRefName,mergeStateStatus 2>/dev/null
}

# TS-Kern: scripts/runner/pr.ts, `prIsBehind()` (#201).
pr_is_behind() {   # $1 = PR-Nr -> 0 (hinter main) / 1 (aktuell/unbekannt)
  local rc
  ts_run pr-is-behind "$1" >/dev/null; rc=$?
  [ "$rc" -eq 127 ] && { pr_is_behind_bash "$1"; return; }
  return "$rc"
}

pr_is_behind_bash() {
  local pr="$1" state
  state=$(pr_merge_state_bash "$pr" | jq -r '.mergeStateStatus // empty' 2>/dev/null)
  [ "$state" = "BEHIND" ]
}

# Zieht 'main' per git in einen zurueckgefallenen PR-Branch: fetch + merge +
# push -- bewusst ueber git, nicht 'gh pr update-branch' (#160). Erwartet
# einen sauberen Arbeitsbaum (der Bau-Agent endet immer mit Push, nie mit
# offenen Aenderungen); ein dreckiger Baum hier waere ein Bug anderswo und
# wird konservativ als Fehler behandelt, statt riskant drueberzumergen oder
# ihn per 'git stash'/'--force' selbst wegzuraeumen (#171) -- was dort liegt
# kann unersetzlich sein, das Aufraeumen ist Sache eines Menschen.
#
# Scheitert der Merge an einem echten Konflikt: kein Commit, Merge wird
# abgebrochen, der Arbeitsbaum kehrt sauber zum vorherigen Branch zurueck --
# die Konfliktdateien landen als kommagetrennte Liste auf stdout, fuer den
# Fix-Agenten-Auftrag.
#
# Rueckgabewert (#171: die alte Sammel-2 fuer JEDEN Nicht-Konflikt-Fehler ist
# aufgeteilt, damit der Aufrufer die Ursache benennen kann):
#   0 nachgezogen+gepusht
#   1 Konflikt (Konfliktdateien auf stdout)
#   2 unsauberer Arbeitsbaum (stoerende Pfade auf stdout, hoechstens 5)
#   3 PR-Metadaten oder 'git fetch' nicht lesbar/erreichbar
#   4 'git checkout' auf den PR-Branch fehlgeschlagen
#   5 'git push' fehlgeschlagen
# TS-Kern: scripts/runner/catchup.ts, `prCatchUpBehind()` (#201) -- als
# discriminated union statt Zahlen-Exitcode; cli.ts bildet an der CLI-Kante
# wieder auf 0-5 ab, ts_run() reicht das transparent durch.
pr_catch_up_behind() {   # $1 = PR-Nr
  local out rc
  out=$(ts_run pr-catch-up-behind "$1"); rc=$?
  [ "$rc" -eq 127 ] && { pr_catch_up_behind_bash "$1"; return; }
  printf '%s' "$out"
  return "$rc"
}

pr_catch_up_behind_bash() {
  local pr="$1" branch cur rc conflicts dirty
  branch=$(pr_merge_state_bash "$pr" | jq -r '.headRefName // empty' 2>/dev/null)
  [ -z "$branch" ] && return 3

  dirty=$(git status --porcelain 2>/dev/null)
  if [ -n "$dirty" ]; then
    printf '%s' "$dirty" | head -5 | cut -c4- | tr '\n' ',' | sed 's/,$//'
    return 2
  fi

  cur=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ -z "$cur" ] || [ "$cur" = "HEAD" ]; then cur=main; fi

  git fetch origin main "$branch" --quiet 2>/dev/null || return 3
  git checkout -B "$branch" "origin/$branch" --quiet 2>/dev/null || return 4

  if git merge origin/main --no-edit --quiet 2>/dev/null; then
    git push origin "HEAD:$branch" --quiet 2>/dev/null
    rc=$?
    git checkout "$cur" --quiet 2>/dev/null
    [ "$rc" -eq 0 ] && return 0 || return 5
  fi

  conflicts=$(git diff --name-only --diff-filter=U 2>/dev/null | tr '\n' ',' | sed 's/,$//')
  git merge --abort 2>/dev/null
  git checkout "$cur" --quiet 2>/dev/null
  printf '%s' "$conflicts"
  return 1
}

# Klartext-Ursache je Nicht-Konflikt-Rueckgabewert von pr_catch_up_behind()
# (#171 AC1/AC2), fuers Statusticket UND fuers Wiederholungs-Tracking unten.
# TS-Kern: scripts/runner/catchup.ts, `catchupFailReason()` (#201).
catchup_fail_reason() {   # $1 = Rueckgabewert (2-5) -> Text
  local out rc
  out=$(ts_run catchup-fail-reason "$1"); rc=$?
  [ "$rc" -eq 127 ] && { catchup_fail_reason_bash "$1"; return; }
  printf '%s' "$out"
  return "$rc"
}

catchup_fail_reason_bash() {
  case "$1" in
    2) echo "unsauberer Arbeitsbaum" ;;
    3) echo "fetch fehlgeschlagen (PR-Metadaten oder \`git fetch\`)" ;;
    4) echo "checkout fehlgeschlagen" ;;
    5) echo "push fehlgeschlagen" ;;
    *) echo "unbekannter Fehler" ;;
  esac
}

# Zaehlt aufeinanderfolgende Nachzieh-Fehlschlaege je Ticket UND Ursache
# dateibasiert unter $STATE_DIR (#171 AC3, analog failcount-<issue>). Wechselt
# die Ursache oder gab es zuletzt einen Erfolg/Konflikt (catchup_fail_reset),
# beginnt die Zaehlung wieder bei 1. Ab der DRITTEN Runde in Folge mit
# derselben Ursache: Rueckgabe 0 ("eskaliert", Status soll 🟡 zeigen).
# TS-Kern: scripts/runner/catchup.ts, `catchupFailEscalated()` (#201).
catchup_fail_escalated() {   # $1 = Issue-Nr, $2 = Ursache-Text -> 0 eskaliert / 1 noch nicht
  local rc
  ts_run catchup-fail-escalated "$1" "$2" >/dev/null; rc=$?
  [ "$rc" -eq 127 ] && { catchup_fail_escalated_bash "$1" "$2"; return; }
  return "$rc"
}

catchup_fail_escalated_bash() {
  local issue="$1" reason="$2" f prev_reason prev_count count
  f="$STATE_DIR/catchup-fail-$issue"
  if [ -s "$f" ]; then
    prev_reason=$(sed -n '1p' "$f")
    prev_count=$(sed -n '2p' "$f")
  else
    prev_reason=""
    prev_count=0
  fi
  if [ "$prev_reason" = "$reason" ]; then
    count=$(( ${prev_count:-0} + 1 ))
  else
    count=1
  fi
  printf '%s\n%s\n' "$reason" "$count" > "$f"
  [ "$count" -ge 3 ] && return 0
  return 1
}

# Nach einem erfolgreichen Nachziehen oder einem echten Konflikt (eigener,
# schon sichtbarer Fund) faengt die Wiederholungs-Zaehlung wieder bei null an.
# TS-Kern: scripts/runner/catchup.ts, `catchupFailReset()` (#201).
catchup_fail_reset() {   # $1 = Issue-Nr
  ts_run catchup-fail-reset "$1" >/dev/null
  local rc=$?
  [ "$rc" -eq 127 ] && { catchup_fail_reset_bash "$1"; return; }
  return "$rc"
}

catchup_fail_reset_bash() {
  rm -f "$STATE_DIR/catchup-fail-$1"
}

# Sind ALLE roten Checks genau 'protected-paths'? Dann ist das kein Fund fuer
# einen Fix-Agenten, sondern die vorgesehene Genehmigungs-Schranke (CLAUDE.md,
# geschuetzte Pfade) -- die behebt kein Code, nur ein Mensch mit
# 'human-approved'.
# TS-Kern: scripts/runner/pr.ts, `prOnlyProtectedPathsRed()` (#201).
pr_only_protected_paths_red() {   # $1 = PR-Nr -> 0 (ja, nur protected-paths) / 1 (auch anderes rot)
  local rc
  ts_run pr-only-protected-paths-red "$1" >/dev/null; rc=$?
  [ "$rc" -eq 127 ] && { pr_only_protected_paths_red_bash "$1"; return; }
  return "$rc"
}

pr_only_protected_paths_red_bash() {
  local pr="$1" json other
  json=$(gh pr checks "$pr" --json bucket,name 2>/dev/null)
  other=$(printf '%s' "$json" | jq \
    '[.[] | select((.bucket=="fail" or .bucket=="cancel") and .name != "protected-paths")] | length')
  [ "${other:-0}" -eq 0 ]
}

# Squash-Merge mit EIGENEM Subject/Body statt GitHub die Commit-Historie
# sammeln zu lassen (#172): ohne --subject/--body haengt GitHub beim Squash
# alle Commit-Nachrichten des Branches aneinander -- inklusive fremder
# 'Closes #N' aus Merge-Commits, die beim Nachziehen von 'main' (#160)
# mitgezogen wurden. So hat ein Squash von PR #168 einmal faelschlich #163
# geschlossen, obwohl dessen eigentlicher PR (#166) noch offen war. Nur der
# Titel DIESES PR zaehlt -- der traegt genau EIN 'Closes #N', naemlich sein
# eigenes.
# TS-Kern: scripts/runner/pr.ts, `prSquashMerge()` (#201).
pr_squash_merge() {   # $1 = PR-Nr
  ts_run pr-squash-merge "$1" >/dev/null
  local rc=$?
  [ "$rc" -eq 127 ] && { pr_squash_merge_bash "$1"; return; }
  return "$rc"
}

pr_squash_merge_bash() {
  local pr="$1" title
  title=$(gh pr view "$pr" --json title -q .title 2>/dev/null)
  if [ -n "$title" ]; then
    gh pr merge --squash --auto --delete-branch --subject "$title" --body "" "$pr" >/dev/null 2>&1
  else
    gh pr merge --squash --auto --delete-branch "$pr" >/dev/null 2>&1
  fi
}

# Netz (#172, Plan B): trotz eigenem Subject/Body oben bleibt ein Rest-Risiko
# (z.B. ein von Hand gemergter PR, oder GitHub liest den PR-Titel selbst als
# schliessendes Schluesselwort noch waehrend der PR offen ist). Deshalb
# zusaetzlich NACHTRAEGLICH geprueft: traegt ein offener PR 'Closes #N' im
# Titel, aber Issue #N ist schon geschlossen, kann DIESER PR es nicht
# geschlossen haben -- das Ticket wird wieder geoeffnet, der Grund als
# Kommentar vermerkt. Reine gh-Aufrufe, kein Agentenlauf.
# TS-Kern: scripts/runner/pr.ts, `reopenFalselyClosedIssues()` (#201).
reopen_falsely_closed_issues() {
  ts_run reopen-falsely-closed-issues >/dev/null
  local rc=$?
  [ "$rc" -eq 127 ] && { reopen_falsely_closed_issues_bash; return; }
  return "$rc"
}

reopen_falsely_closed_issues_bash() {
  local open_prs pairs
  open_prs=$(gh pr list --state open --limit 100 --json number,title 2>/dev/null || echo '[]')
  pairs=$(printf '%s' "$open_prs" | jq -c \
    '[.[] | {pr: .number, issue: ((.title | (capture("[Cc]loses #(?<n>[0-9]+)").n)? // empty))}]
     | map(select(.issue != null and .issue != ""))' 2>/dev/null)
  [ -n "$pairs" ] || return 0
  [ "$(printf '%s' "$pairs" | jq 'length' 2>/dev/null)" -gt 0 ] || return 0

  printf '%s' "$pairs" | jq -c '.[]' | while IFS= read -r p; do
    local pr issue state
    pr=$(printf '%s' "$p" | jq -r '.pr')
    issue=$(printf '%s' "$p" | jq -r '.issue')
    state=$(gh issue view "$issue" --json state -q .state 2>/dev/null)
    if [ "$state" = "CLOSED" ]; then
      gh issue reopen "$issue" >/dev/null 2>&1
      gh issue comment "$issue" --body \
        "🔁 Automatisch wieder geöffnet: Dieses Ticket war geschlossen, obwohl PR #$pr (\`Closes #$issue\`) noch offen ist — kann also nicht der Schließer gewesen sein. Vermutlich hat ein Squash-Merge eines anderen PR ein fremdes \`Closes #$issue\` aus einem mitgezogenen Commit gelesen (#172). Der Bau macht hier normal weiter." \
        >/dev/null 2>&1
    fi
  done
}

# Knappe Zusammenfassung der roten Checks fuer den Fix-Agenten-Auftrag: Job,
# Kurzbeschreibung, ein begrenzter Log-Ausschnitt -- NICHT die rohe
# Log-Ausgabe (#147 AC). Hoechstens die ersten 3 roten Checks, sonst waechst
# der Auftrag mit jedem zusaetzlichen Shard unnoetig.
# TS-Kern: scripts/runner/pr.ts, `prFailureSummary()` (#201).
pr_failure_summary() {   # $1 = PR-Nr
  local out rc
  out=$(ts_run pr-failure-summary "$1"); rc=$?
  [ "$rc" -eq 127 ] && { pr_failure_summary_bash "$1"; return; }
  printf '%s' "$out"
  return "$rc"
}

pr_failure_summary_bash() {
  local pr="$1" json failing
  json=$(gh pr checks "$pr" --json name,bucket,description,link 2>/dev/null)
  failing=$(printf '%s' "$json" | jq -c \
    '[.[] | select((.bucket=="fail" or .bucket=="cancel") and .name != "protected-paths")] | .[0:3]')
  printf '%s' "$failing" | jq -c '.[]' | while IFS= read -r c; do
    local name desc link runid log
    name=$(printf '%s' "$c" | jq -r '.name')
    desc=$(printf '%s' "$c" | jq -r '.description')
    link=$(printf '%s' "$c" | jq -r '.link')
    runid=$(printf '%s' "$link" | grep -oE 'runs/[0-9]+' | head -1 | grep -oE '[0-9]+')
    printf -- '### %s\n%s\n' "$name" "$desc"
    if [ -n "$runid" ]; then
      log=$(gh run view "$runid" --log-failed 2>/dev/null \
              | tail -n 25 | iconv -f UTF-8 -t UTF-8 -c 2>/dev/null)
      [ -n "$log" ] && printf '```\n%s\n```\n' "$log"
    fi
  done
}

# --- Eine Wache statt zwei (#202, S5 von #184) --------------------------------
# Bisher standen die CI-Wache fuer EIN laufendes Bau-Ticket (#147/#160/#171)
# und die CI-Wache fuer ALLE geparkten Tickets (#154/#173) als zwei getrennte
# Bloecke in run_round() -- zwei Automaten, die denselben PR-Zustand je fuer
# sich auswerteten. Jetzt entscheidet EINE Uebergangstabelle
# (scripts/runner/watch.ts, `watchReaction()`), `parked` ist ein Eingabefeld.
# Die menschenlesbaren Statustexte bleiben bewusst HIER (nicht im TS-Kern) --
# ci-watch.test.sh/parked-ci-watch.test.sh pruefen sie 1:1 auf Wortlaut.
# TS-Kern: scripts/runner/watch.ts, `watchRunningIssue()` (#202).
watch_running_issue() {   # $1 = Issue-Nr, $2 = PR-Nr -> JSON {kind, ...}
  local out rc
  out=$(ts_run watch-running-issue "$1" "$2"); rc=$?
  [ "$rc" -eq 127 ] && { watch_running_issue_bash "$1" "$2"; return; }
  printf '%s' "$out"
  return "$rc"
}

watch_running_issue_bash() {
  local issue="$1" PR_NUM="$2"
  case "$(pr_ci_state "$PR_NUM")" in
    pending)
      jq -nc '{kind:"pending"}'
      ;;
    success)
      gh pr ready "$PR_NUM" >/dev/null 2>&1
      pr_squash_merge "$PR_NUM"
      jq -nc '{kind:"merged"}'
      ;;
    failing)
      if pr_only_protected_paths_red "$PR_NUM"; then
        gh issue edit "$issue" --add-label needs-input >/dev/null 2>&1
        jq -nc '{kind:"needs-input-protected"}'
      else
        local summary
        summary=$(pr_failure_summary "$PR_NUM")
        jq -nc --arg s "$summary" '{kind:"build-fix", summary:$s}'
      fi
      ;;
    behind)
      local catchup_out catchup_rc
      catchup_out=$(pr_catch_up_behind "$PR_NUM"); catchup_rc=$?
      case "$catchup_rc" in
        0)
          catchup_fail_reset "$issue"
          jq -nc '{kind:"caught-up"}'
          ;;
        1)
          catchup_fail_reset "$issue"
          jq -nc --arg issue "$issue" --arg pr "$PR_NUM" --arg files "$catchup_out" '
            (if ($files|length) == 0 then "unbekannt" else $files end) as $filelist
            | {kind:"build-fix",
               summary: ("### Merge-Konflikt beim Nachziehen von `main`\nPR #" + $pr + " (#" + $issue + ") liegt hinter `main`. Das automatische Nachziehen (`git fetch` +\n`git merge origin/main`) ist an einem echten Konflikt gescheitert.\n\nBetroffene Dateien: " + $filelist + "\n\nLöse den Konflikt auf dem bestehenden Branch: `git fetch origin main`,\n`git merge origin/main`, die genannten Dateien bereinigen, committen, pushen.")}'
          ;;
        *)
          local reason paths_json escalated_bool
          reason=$(catchup_fail_reason "$catchup_rc")
          if [ "$catchup_rc" -eq 2 ] && [ -n "$catchup_out" ]; then
            paths_json=$(printf '%s' "$catchup_out" | jq -R 'split(",")')
          else
            paths_json='[]'
          fi
          if catchup_fail_escalated "$issue" "$reason"; then escalated_bool=true; else escalated_bool=false; fi
          jq -nc --arg reason "$reason" --argjson paths "$paths_json" --argjson escalated "$escalated_bool" \
            '{kind:"retry", reason:$reason, paths:$paths, escalated:$escalated}'
          ;;
      esac
      ;;
  esac
}

# CI-Wache fuer ALLE geparkten Tickets (#154, erweitert um #173), ueber
# dieselbe Uebergangstabelle. $1 = JSON-Array [{number,createdAt,hasNeedsInput}],
# $2 = "1" (WIP-Slot frei) oder "" -- fix fuer die ganze Runde, wie in der
# bisherigen Bash-Implementierung (hoechstens EIN Ticket wird pro Runde
# entparkt, unabhaengig davon, wie viele Kandidaten es gibt).
# TS-Kern: scripts/runner/watch.ts, `watchParkedIssues()` (#202).
watch_parked_issues() {   # -> JSON {promoted:{issue,reason}|null, released:[...]}
  local out rc
  out=$(ts_run watch-parked-issues "$1" "${2:-}"); rc=$?
  [ "$rc" -eq 127 ] && { watch_parked_issues_bash "$1" "${2:-}"; return; }
  printf '%s' "$out"
  return "$rc"
}

watch_parked_issues_bash() {
  local snapshot="$1" wip_slot_free="${2:-}" promoted='null' released='[]'
  local sorted
  sorted=$(printf '%s' "$snapshot" | jq -c 'sort_by(.createdAt)')
  # Scratch-Dateien, um Ergebnisse aus der Pipe-Subshell unten (while-read
  # ueber eine Pipe laeuft in einer eigenen Subshell, Variablen darin gehen
  # beim Verlassen verloren) nach aussen zu tragen -- IMMER vorab geraeumt,
  # falls ein frueherer Aufruf hart abgebrochen ist.
  rm -f "$STATE_DIR/watch-parked-promoted" "$STATE_DIR/watch-parked-released"

  printf '%s' "$sorted" | jq -c '.[]' | while IFS= read -r item; do
    local n created has_input pr ci
    n=$(printf '%s' "$item" | jq -r '.number')
    has_input=$(printf '%s' "$item" | jq -r '.hasNeedsInput')
    pr=$(pr_for_issue "$n")
    [ -z "$pr" ] && continue
    ci=$(pr_ci_state "$pr")
    local reason=""

    if [ "$ci" = "behind" ]; then
      local catchup_out catchup_rc
      catchup_out=$(pr_catch_up_behind "$pr"); catchup_rc=$?
      [ "$catchup_rc" -eq 1 ] && reason='ein Merge-Konflikt beim Nachziehen von `main`'
    elif [ "$ci" = "failing" ] && ! pr_only_protected_paths_red "$pr"; then
      reason='rote Checks (mehr als nur `protected-paths`)'
    fi

    if [ -n "$reason" ]; then
      if [ "$has_input" != "true" ] && [ -z "$(cat "$STATE_DIR/watch-parked-promoted" 2>/dev/null)" ] \
           && [ "$wip_slot_free" = "1" ]; then
        gh issue edit "$n" --remove-label parked --add-label in-progress >/dev/null 2>&1
        jq -nc --argjson n "$n" --arg reason "$reason" '{issue:$n, reason:$reason}' > "$STATE_DIR/watch-parked-promoted"
      fi
      continue
    fi

    [ "$ci" = "success" ] || continue
    gh pr ready "$pr" >/dev/null 2>&1
    pr_squash_merge "$pr"
    gh issue edit "$n" --remove-label parked --remove-label needs-input >/dev/null 2>&1
    echo "$n" >> "$STATE_DIR/watch-parked-released"
  done

  [ -f "$STATE_DIR/watch-parked-promoted" ] && promoted=$(cat "$STATE_DIR/watch-parked-promoted")
  if [ -f "$STATE_DIR/watch-parked-released" ]; then
    released=$(jq -Rsc 'split("\n") | map(select(length>0) | tonumber)' "$STATE_DIR/watch-parked-released")
  fi
  rm -f "$STATE_DIR/watch-parked-promoted" "$STATE_DIR/watch-parked-released"
  jq -nc --argjson promoted "$promoted" --argjson released "$released" '{promoted:$promoted, released:$released}'
}

# --- Ticketauswahl aus run_round (#202, S5 von #184) -------------------------
# TS-Kern: scripts/runner/select.ts, `selfHealPark()`/`pickTicket()`. Zwei
# Schritte, wie in der bisherigen Bash-Implementierung: erst die Selbstheilung
# (#145), dann die eigentliche Auswahl-Kaskade (laufend > Resume eines
# geparkten Tickets > Prioritaets-Queue > needs-plan > needs-research > ready).
# Der Bau-Prompt/`claude`-Aufruf selbst bleibt Bash (S6, siehe Nicht-Ziele).
self_heal_park() {   # $1 = Snapshot-JSON -> JSON {snapshot, parked:[...]}
  local out rc
  out=$(ts_run self-heal-park "$1"); rc=$?
  [ "$rc" -eq 127 ] && { self_heal_park_bash "$1"; return; }
  printf '%s' "$out"
  return "$rc"
}

self_heal_park_bash() {
  local snapshot="$1" to_park parked_ok='[]' updated
  to_park=$(printf '%s' "$snapshot" | jq -r \
    '[.[] | select(.labels | map(.name) | index("in-progress"))
          | select(.labels | map(.name) | index("needs-input"))
          | .number] | .[]' 2>/dev/null)
  if [ -n "$to_park" ]; then
    while IFS= read -r n; do
      [ -z "$n" ] && continue
      # park_issue_bash() direkt (nicht der Wrapper) -- Konvention aus S2/S3:
      # eine _bash-Komposition ruft nie ueber ts_run zurueck.
      if park_issue_bash "$n"; then
        parked_ok=$(printf '%s' "$parked_ok" | jq --argjson n "$n" '. + [$n]')
      fi
    done <<< "$to_park"
  fi
  updated=$(printf '%s' "$snapshot" | jq --argjson ok "$parked_ok" \
    '[.[] | if (.number as $n | $ok | index($n) != null) then
              (.labels |= (map(select(.name != "in-progress")) + [{"name":"parked"}]))
            else . end]')
  jq -nc --argjson snapshot "$updated" --argjson parked "$parked_ok" '{snapshot:$snapshot, parked:$parked}'
}

# $1 = Snapshot-JSON (NACH self_heal_park), $2 = Queue-Body -> JSON
# {kind:"blocked", issues:[...]} | {kind:"ticket", issue, role, mode} | {kind:"none"}
pick_ticket() {
  local out rc
  out=$(ts_run pick-ticket "$1" "${2:-}"); rc=$?
  [ "$rc" -eq 127 ] && { pick_ticket_bash "$1" "${2:-}"; return; }
  printf '%s' "$out"
  return "$rc"
}

pick_ticket_bash() {
  local snapshot="$1" queue_body="${2:-}" order still_blocked

  still_blocked=$(printf '%s' "$snapshot" | jq -c \
    '[.[] | select(.labels | map(.name) | index("in-progress"))
          | select(.labels | map(.name) | index("needs-input")) | .number]')
  if [ "$(printf '%s' "$still_blocked" | jq 'length')" -gt 0 ]; then
    jq -nc --argjson issues "$still_blocked" '{kind:"blocked", issues:$issues}'
    return 0
  fi

  # laufendes in-progress (ohne needs-input)
  local pick
  pick=$(printf '%s' "$snapshot" | jq -r \
    '[.[] | select(.labels | map(.name) | index("in-progress"))
          | select((.labels | map(.name) | index("needs-input"))|not)]
        | sort_by(.createdAt) | .[0].number // empty')
  if [ -n "$pick" ]; then
    jq -nc --argjson issue "$pick" '{kind:"ticket", issue:$issue, role:"build", mode:"resume"}'
    return 0
  fi

  # Resume eines geparkten Tickets (#145) -- geht vor Queue/Fallback.
  pick=$(printf '%s' "$snapshot" | jq -r \
    '[.[] | select(.labels | map(.name) | index("parked"))
          | select((.labels | map(.name) | index("needs-input"))|not)]
        | sort_by(.createdAt) | .[0].number // empty')
  if [ -n "$pick" ]; then
    gh issue edit "$pick" --add-label in-progress --remove-label parked >/dev/null 2>&1
    jq -nc --argjson issue "$pick" '{kind:"ticket", issue:$issue, role:"build", mode:"resume"}'
    return 0
  fi

  # Prioritaets-Queue (S2) -- Label egal fuer den Rang, Rolle kommt aus dem Label.
  # queue_order_flat_bash() direkt (nicht der Wrapper) -- Konvention aus S2/S3:
  # eine _bash-Komposition ruft nie ueber ts_run zurueck.
  order=$(queue_order_flat_bash "$queue_body")
  local qpick
  qpick=$(printf '%s' "$snapshot" | jq -r --argjson order "$order" '
    [ .[] | (.labels|map(.name)) as $l | (.number) as $n
      | ($order|index($n)) as $rank
      | select($rank != null)
      | select( ($l|index("needs-input"))|not )
      | select( ($l|index("no-opus"))|not )
      | { n:$n, rank:$rank,
          role: (if ($l|index("needs-plan")) then "plan"
                 elif ($l|index("needs-research")) then "research"
                 else "build" end) } ]
    | sort_by(.rank) | .[0] // {}
    | if .n then "\(.n) \(.role)" else "" end')
  if [ -n "$qpick" ]; then
    local qissue qrole
    qissue=${qpick%% *}
    qrole=${qpick##* }
    if [ "$qrole" = build ]; then
      gh issue edit "$qissue" --add-label in-progress --remove-label ready >/dev/null 2>&1
      jq -nc --argjson issue "$qissue" --arg role "$qrole" '{kind:"ticket", issue:$issue, role:$role, mode:"start"}'
    else
      local mode=start
      [ -s "$STATE_DIR/session-$qissue" ] && mode=resume
      jq -nc --argjson issue "$qissue" --arg role "$qrole" --arg mode "$mode" '{kind:"ticket", issue:$issue, role:$role, mode:$mode}'
    fi
    return 0
  fi

  # Label-Fallback: needs-plan -> needs-research -> ready, je aeltestes createdAt.
  pick=$(printf '%s' "$snapshot" | jq -r \
    '[.[] | select(.labels | map(.name) | index("needs-plan"))
          | select((.labels | map(.name) | index("needs-input")) | not)
          | select((.labels | map(.name) | index("no-opus")) | not)]
        | sort_by(.createdAt) | .[0].number // empty')
  if [ -n "$pick" ]; then
    local mode=start
    [ -s "$STATE_DIR/session-$pick" ] && mode=resume
    jq -nc --argjson issue "$pick" --arg mode "$mode" '{kind:"ticket", issue:$issue, role:"plan", mode:$mode}'
    return 0
  fi

  pick=$(printf '%s' "$snapshot" | jq -r \
    '[.[] | select(.labels | map(.name) | index("needs-research"))
          | select((.labels | map(.name) | index("needs-input")) | not)
          | select((.labels | map(.name) | index("no-opus")) | not)]
        | sort_by(.createdAt) | .[0].number // empty')
  if [ -n "$pick" ]; then
    local mode=start
    [ -s "$STATE_DIR/session-$pick" ] && mode=resume
    jq -nc --argjson issue "$pick" --arg mode "$mode" '{kind:"ticket", issue:$issue, role:"research", mode:$mode}'
    return 0
  fi

  pick=$(printf '%s' "$snapshot" | jq -r \
    '[.[] | select(.labels | map(.name) | index("ready"))
          | select((.labels | map(.name) | index("needs-input")) | not)
          | select((.labels | map(.name) | index("needs-plan")) | not)
          | select((.labels | map(.name) | index("needs-research")) | not)]
        | sort_by(.createdAt) | .[0].number // empty')
  if [ -n "$pick" ]; then
    gh issue edit "$pick" --add-label in-progress --remove-label ready >/dev/null 2>&1
    jq -nc --argjson issue "$pick" '{kind:"ticket", issue:$issue, role:"build", mode:"start"}'
    return 0
  fi

  jq -nc '{kind:"none"}'
}

# Fortschritts-/Fehlschlag-Auswertung. Wird NUR an den inhaltlich "fertigen"
# Ausgaengen der Bau-Rolle aufgerufen (RC=0-Zweig, letzter Fehlschlag-Zweig) --
# ausdruecklich NICHT bei Limit/429, Notbremse oder einem noch laufenden
# Transient-Retry: dort ist gar nicht zu Ende gearbeitet worden (Infrastruktur,
# nicht Inhalt), das darf kein Fehlversuch sein.
# TS-Kern: scripts/runner/escalation.ts, `buildEscalationEval()` (#200).
build_escalation_eval() {
  local out rc
  out=$(ts_run build-escalation-eval "$ISSUE" "$RUN_ROLE" "${LABELS:-}" "${BEFORE_TIP:-}" "${MODEL:-}"); rc=$?
  [ "$rc" -eq 127 ] && { build_escalation_eval_bash; return; }
  return "$rc"
}

build_escalation_eval_bash() {
  [ "$RUN_ROLE" = "build" ] || return 0
  case "$LABELS" in *no-escalation*) return 0 ;; esac

  local after
  after=$(branch_tip "$ISSUE")
  if [ -n "$after" ] && [ "$after" != "${BEFORE_TIP:-}" ]; then
    tier_reset_bash "$ISSUE"     # Fortschritt -- zurueck auf die Default-Stufe.
    return 0
  fi

  # opus-boost (#136) wird von einem ERGEBNISLOSEN Opus-Bau-Lauf verbraucht --
  # ein Tap deckt genau einen erfolglosen Versuch ab. Bei Fortschritt (Zweig
  # oben) bleibt das Label bewusst haengen, auf einem anderen Modell als Opus
  # waere der Verbrauch verschwendet.
  if [ "${MODEL:-}" = "opus" ]; then
    case "$LABELS" in
      *opus-boost*) gh issue edit "$ISSUE" --remove-label opus-boost >/dev/null 2>&1 ;;
    esac
  fi

  local sig prev fc
  sig=$(blocker_sig_bash "$ISSUE")
  prev=$(cat "$STATE_DIR/blocker-sig-$ISSUE" 2>/dev/null || echo "")
  [ -n "$sig" ] && printf '%s' "$sig" > "$STATE_DIR/blocker-sig-$ISSUE"

  # Nur eine ECHTE Aenderung gegenueber einer bereits bekannten Signatur zaehlt
  # als "die Wand hat sich bewegt". Gibt es noch keine gespeicherte Signatur
  # (erster Fehlversuch ueberhaupt), ist das keine Aenderung, sondern die
  # Baseline -- der Fehlversuch selbst zaehlt trotzdem (siehe fc++ unten).
  if [ -n "$prev" ] && [ -n "$sig" ] && [ "$sig" != "$prev" ]; then
    echo 0 > "$STATE_DIR/failcount-$ISSUE"
    return 0
  fi

  fc=$(( $(cat "$STATE_DIR/failcount-$ISSUE" 2>/dev/null || echo 0) + 1 ))
  echo "$fc" > "$STATE_DIR/failcount-$ISSUE"
  [ "$fc" -ge 3 ] || return 0

  if tier_bump_bash "$ISSUE"; then
    gh issue comment "$ISSUE" --body \
      "🤖 Drei Läufe ohne Fortschritt auf der aktuellen Modellstufe — der nächste Bau-Versuch eskaliert auf Opus (siehe ADR-0007, Deckel 2 Opus-Bau-Läufe/Tag)." \
      >/dev/null 2>&1
  else
    gh issue comment "$ISSUE" --body \
      "🤖 Auch Opus ist dreimal in Folge ohne Fortschritt stecken geblieben. Die Eskalation ist erschöpft." \
      >/dev/null 2>&1
    gh issue edit "$ISSUE" --add-label needs-input >/dev/null 2>&1
  fi
}

# Harter Opus-Bau-Deckel (ADR-0007): hoechstens 2 Opus-Bau-Laeufe pro Ticket
# und Kalendertag. Eigener, tagesgestempelter Zaehler -- unabhaengig vom
# (inzwischen abgeschafften, PR #46) Deckel der nur-lesenden Denk-Rollen, weil
# Opus hier tatsaechlich schreibt statt nur zu lesen.
# TS-Kern: scripts/runner/cap.ts, `opusBuildCapReached()` (#200).
opus_build_cap_reached() {   # $1 = Issue-Nr, $2 = LABELS (optional) -> 0 (Deckel erreicht) / 1 (noch Luft)
  ts_run opus-cap-reached "$1" "${2:-}" >/dev/null
  local rc=$?
  [ "$rc" -eq 127 ] && { opus_build_cap_reached_bash "$1" "${2:-}"; return; }
  return "$rc"
}

opus_build_cap_reached_bash() {
  local issue="$1" labels="${2:-}" count
  case "$labels" in *opus-boost*) return 1 ;; esac
  count=$(cat "$STATE_DIR/opus-build-$(date +%Y%m%d)-$issue" 2>/dev/null || echo 0)
  [ "${count:-0}" -ge 2 ] 2>/dev/null
}

# TS-Kern: scripts/runner/cap.ts, `opusBuildCapReserve()` (#200).
opus_build_cap_reserve() {   # $1 = Issue-Nr -- verbraucht einen der 2 Slots fuer heute
  ts_run opus-cap-reserve "$1" >/dev/null
  local rc=$?
  [ "$rc" -eq 127 ] && { opus_build_cap_reserve_bash "$1"; return; }
  return "$rc"
}

opus_build_cap_reserve_bash() {
  local issue="$1"
  local f="$STATE_DIR/opus-build-$(date +%Y%m%d)-$issue"
  local count
  count=$(cat "$f" 2>/dev/null || echo 0)
  echo $((count + 1)) > "$f"
}

# Baut einen lesbaren Fehlerausschnitt fuer Issue-Kommentare (#64): bei
# '--output-format json' ist $LOG oft eine einzige Riesenzeile -- 'tail -n 20'
# postet diese Zeile bisher komplett und ungekuerzt ins Ticket. Bevorzugt
# '.result' aus dem geparsten JSON (das ist bereits lesbarer Klartext, keine
# JSON-Huelle), mit hartem Zeichenlimit. Schlaegt das Parsen fehl (z.B. hat
# die Notbremse mitten in der Antwort abgebrochen -> kaputtes JSON), auf das
# ebenfalls gekuerzte Rohlog zurueckfallen.
ERROR_EXCERPT_LIMIT=1500
error_excerpt() {   # kein Argument -- liest $OUT und $LOG
  local txt
  txt=$(printf '%s' "$OUT" | jq -r '.result // empty' 2>/dev/null)
  [ -z "$txt" ] && txt=$(tail -n 20 "$LOG" 2>/dev/null)
  if [ "${#txt}" -gt "$ERROR_EXCERPT_LIMIT" ]; then
    # Byteweises Schneiden (C-Locale) kann mitten in ein Mehrbyte-UTF-8-Zeichen
    # (Umlaute!) treffen -- iconv -c wirft am Ende ein angeschnittenes Zeichen
    # sauber weg, statt eine kaputte Byte-Sequenz zu posten.
    printf '%s\n…(gekürzt)' \
      "$(printf '%s' "${txt:0:$ERROR_EXCERPT_LIMIT}" | iconv -f UTF-8 -t UTF-8 -c 2>/dev/null)"
  else
    printf '%s' "$txt"
  fi
}

# --- Ersatz für `timeout` (fehlt auf macOS) --------------------------------
# Killt bisher nur den direkten 'claude'-Prozess -- ein haengengebliebenes
# Kind (z.B. 'pnpm e2e', das claude selbst per Bash-Tool startet) ueberlebt
# die Notbremse und laeuft munter weiter (#64). Deshalb die ganze
# Prozessgruppe killen, nicht nur den einen PID.
#
# 'setsid' waere der uebliche Weg dahin, ist aber ein util-linux-Tool und
# fehlt auf macOS (siehe Kopf-Kommentar zu flock/timeout) -- 'set -m'
# (bash-Jobcontrol) erreicht denselben Effekt portabel: ein im Monitor-Modus
# gestarteter Hintergrund-Job bekommt eine EIGENE Prozessgruppe, deren
# Gruppen-ID gleich der PID seines ersten Prozesses ist. 'kill -- -$pid'
# (negative PID = Gruppen-ID) trifft damit die ganze Gruppe.
TIMED_OUT="$STATE_DIR/timed-out"
run_limited() {   # $1 = Sekunden, Rest = Befehl. Ausgabe geht nach $LOG.
  local secs="$1"; shift
  rm -f "$TIMED_OUT"

  set -m
  "$@" > "$LOG" 2>&1 &
  local cmd_pid=$!
  set +m

  (
    sleep "$secs"
    if kill -0 "$cmd_pid" 2>/dev/null; then
      touch "$TIMED_OUT"
      kill -TERM -- "-$cmd_pid" 2>/dev/null
      sleep 10
      kill -KILL -- "-$cmd_pid" 2>/dev/null
    fi
  ) &
  local watchdog=$!

  wait "$cmd_pid" 2>/dev/null; local rc=$?
  kill "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  return $rc
}

# --- Naht zu TypeScript (S1, #198) -------------------------------------------
# Ab hier wandern Bash-Funktionen schrittweise nach `scripts/runner/cli.ts`
# (TS-Kern) um -- `ts_run()` ist die einzige Bruecke dorthin. Vertrag: stdout
# und Exit-Code kommen exakt von cli.ts durch, nichts wird hier ausgewertet
# oder umgedeutet.
#
# `RUNNER_TS=0` ist der Kill-Switch: erzwingt sofort den Bash-Pfad, `tsx` wird
# gar nicht erst gestartet. Der Aufrufer erkennt das am Rueckgabewert 127 und
# faellt selbst auf seine eigene Bash-Logik zurueck -- exakt derselbe
# Rueckgabewert wie im "tsx fehlt/kaputt"-Fall unten, bewusst nicht
# unterschieden: fuer den Aufrufer zaehlt nur "kein TS-Pfad diesmal".
# Ein fehlendes/kaputtes `tsx` (ENOENT -> Exit 127, bash meldet das bei einem
# nicht existierenden Pfad von selbst so) meldet sich zusaetzlich HOERBAR
# ueber status() -- ein unbeaufsichtigter Lauf darf das nicht still schlucken.
ts_run() {   # $1 = Kommando, Rest = Argumente -> stdout/Exit-Code wie cli.ts
  local cmd="$1"
  [ "$RUNNER_TS" = "0" ] && return 127

  local out rc
  out=$("$REPO_DIR/node_modules/.bin/tsx" "$REPO_DIR/scripts/runner/cli.ts" "$@")
  rc=$?
  if [ "$rc" -eq 127 ]; then
    status "TS-Naht ausgefallen" "🔴" \
      "🔴 \`tsx\` fehlt oder \`node_modules\` ist kaputt -- Kommando \`$cmd\` läuft weiter über den Bash-Pfad."
    return 127
  fi
  printf '%s' "$out"
  return "$rc"
}

# --- .runner/ räumt sich auf (#64) -------------------------------------------
# tier-/failcount-/opus-build-<datum>-/opus-cap-msg-<datum>-/session--Dateien
# geschlossener Tickets blieben bisher fuer immer liegen. Einmal PRO TICK
# (nicht pro Runde) alles aelter als 7 Tage weg. Ausdruecklich verschont:
# 'limit-until' (kein Ticket-Bezug, gehoert nicht zu den Mustern) und die
# Session-Datei des GERADE laufenden Tickets, egal wie alt (z. B. ein Ticket,
# das laenger als 7 Tage an einem Wochenlimit haengt).
cleanup_state_dir() {
  local keep_session
  keep_session=$(gh issue list --label in-progress --state open --limit 5 \
                   --json number -q '.[0].number // empty' 2>/dev/null)
  local -a find_args=(
    "$STATE_DIR" -maxdepth 1
    '(' -name 'tier-*' -o -name 'failcount-*' -o -name 'opus-build-*' -o -name 'opus-cap-msg-*' -o -name 'session-*' ')'
    -mtime +7
  )
  [ -n "$keep_session" ] && find_args+=(-not -name "session-$keep_session")
  find "${find_args[@]}" -delete 2>/dev/null
}

# --- Der imperative Hauptteil ------------------------------------------------
# Gekapselt in main(), damit Tests die obigen Funktionen sourcen koennen, ohne
# einen echten Lauf zu starten (Source-Guard ganz unten).
#
# Ticket-Chaining (#61): main() haelt Lock + Limit-Check (Tick-Ebene, genau
# einmal) und schleift darum eine Chain-Schleife, die run_round() bis zu
# MAX_ROUNDS mal aufruft -- so laeuft nach einem sauber beendeten Lauf sofort
# das naechste baubereite Ticket, statt den Tick zu beenden und bis zu 20 (jetzt
# 5) Minuten auf den naechsten Takt zu warten. run_round() enthaelt die
# komplette bisherige Ticketwahl+Bau/Plan/Recherche-Logik, unveraendert bis auf
# 'exit N' -> 'return N' (main() soll den Tick erst NACH der letzten Runde
# verlassen, nicht die Funktion nach der ersten).
main() {

# --- Nie zwei Läufe gleichzeitig -------------------------------------------
# mkdir ist atomar auf POSIX — das ersetzt flock, das es auf macOS nicht gibt.
LOCK="$STATE_DIR/lock.d"
if ! mkdir "$LOCK" 2>/dev/null; then
  OWNER=$(cat "$LOCK/pid" 2>/dev/null || echo "")
  if [ -n "$OWNER" ] && kill -0 "$OWNER" 2>/dev/null; then
    echo "läuft bereits (PID $OWNER)"; exit 0
  fi
  # Verwaister Lock (Rechner abgestürzt, Prozess tot) — übernehmen.
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null || { echo "läuft bereits"; exit 0; }
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

cleanup_state_dir

# --- Kontingent erschöpft? Dann gar nicht erst starten ----------------------
# Der Timer tickt weiter alle 5 Minuten. Solange das Limit nachweislich noch
# steht, hat es keinen Sinn, einen Agenten hochzufahren. Die Datei enthält eine
# Unix-Zeit und entsteht unten aus der Reset-Angabe von 'claude -p'.
# Fehlt sie oder ist sie abgelaufen, läuft alles wie immer — ein Fehlparsen darf
# den Runner nie dauerhaft stilllegen.
if [ -s "$LIMIT_UNTIL" ]; then
  UNTIL=$(cat "$LIMIT_UNTIL" 2>/dev/null)
  NOW=$(date +%s)
  if [ -n "$UNTIL" ] && [ "$UNTIL" -gt "$NOW" ] 2>/dev/null; then
    # fmt_hm_bash direkt, NICHT die ts_run-Variante (#199): dieser Zweig muss
    # ein garantierter No-Op nach aussen bleiben (kein tsx-Start, kein gh-Aufruf,
    # selbst wenn tsx fehlt und ts_run das laut ueber status() melden wuerde) --
    # genau das prueft limit-until.test.sh AC3.
    echo "Kontingent erschöpft bis $(fmt_hm_bash "$UNTIL") — Lauf übersprungen."
    exit 0
  fi
  rm -f "$LIMIT_UNTIL"
fi

# --- Chain-Schleife: mehrere Runden pro Tick (#61) --------------------------
# Weiter nur nach einem SAUBER gruenen run_round() (RC=0, keine offene Frage --
# siehe run_round: CHAIN_STATUS wird dort ganz oben auf 'stop' gesetzt und nur
# im gruenen Zweig auf 'continue' umgeschaltet). Jeder andere Ausgang
# (needs-input, blocked-limit, Notbremse, Transient-Retry, roter/harter Exit,
# Opus-Deckel, Read-only-Netz-Verletzung, 'nichts zu tun') laesst 'stop' stehen
# und bricht die Kette sofort ab. Die erste Runde laeuft immer; TICK_BUDGET
# wird erst VOR jeder weiteren Runde geprueft -- die laufende Runde selbst
# bleibt durch MAX_RUNTIME gedeckelt (Notbremse bleibt PRO LAUF).
ROUND=0; CHAIN_STATUS=continue; DID_WORK=0; LAST_ISSUE=""; RC=0
TICK_START=$(date +%s)
while [ "$CHAIN_STATUS" = continue ] && [ "$ROUND" -lt "$MAX_ROUNDS" ]; do
  if [ "$ROUND" -gt 0 ]; then
    NOW_TS=$(date +%s)
    [ $((NOW_TS - TICK_START)) -ge "$TICK_BUDGET" ] && break
  fi
  ROUND=$((ROUND + 1))
  run_round; RC=$?
done
exit "$RC"

}

run_round() {
CHAIN_STATUS=stop

# --- Netz gegen faelschlich geschlossene Tickets (#172) ---------------------
# Vor jeder Ticketauswahl, damit ein hier wieder geoeffnetes Ticket noch im
# selben Schnappschuss (ROUND_SNAP) unten auftaucht statt erst naechste Runde.
reopen_falsely_closed_issues

# --- Welches Ticket? --------------------------------------------------------
# EIN Schnappschuss aller offenen Issues (Nr., Labels, Erstellt-Datum) statt
# fuenf sequenzieller 'gh issue list'-Aufrufe (needs-input, in-progress,
# needs-plan, needs-research, ready) -- lokal mit jq gefiltert. Die
# Praezedenz bleibt exakt erhalten: in-progress -> needs-plan ->
# needs-research -> ready, je aelteste zuerst (createdAt), inklusive aller
# Ausschluesse (needs-input, no-opus, Beide-Label-Guard).
ROUND_SNAP=$(gh issue list --state open --limit 100 \
               --json number,labels,createdAt 2>/dev/null || echo '[]')

# Prioritäts-Queue (#109) EINMAL einlesen (ein gh-Aufruf): der Body wird
# unten an pick_ticket() durchgereicht, das seine flache Reihenfolge selbst
# ableitet (queue_order_flat, S2). Leer, solange kein QUEUE_ISSUE gesetzt/leer
# ist -> die Queue-Auswahl greift dann nicht und es bleibt bei der
# Label-Reihenfolge.
QUEUE_BODY=$(queue_body)

# --- Selbstheilung (#145): in-progress + needs-input darf nicht koexistieren -
# Eine Frage waehrend eines Laufs (Skript- oder Agent-seitig per gh issue edit)
# hinterlaesst bisher 'in-progress' UND 'needs-input' gleichzeitig -- genau das
# blockierte frueher den ganzen Runner (Schritt 1 unten, "PARKED"), auch fuer
# Tickets, die fachlich nichts damit zu tun haben. Hier, VOR jeder Ticketwahl,
# wird das aufgeloest: 'in-progress' weg, dafuer 'parked' -- sichtbar wartend,
# aber ohne Bauplatz zu belegen. 'ready' waere falsch: die Wiederaufnahme unten
# (Schritt 1b) braucht MODE=resume, nicht "von vorn". Nur ERFOLGREICH
# umgelabelte Tickets werden auch im Snapshot umgeschrieben -- schlaegt der
# gh-Aufruf fehl, bleibt das Ticket in-progress+needs-input und faellt unten in
# den alten Sicherheitszweig (blockiert alles), statt riskant ein zweites
# Ticket parallel anzufangen.
SELF_HEAL_OUT=$(self_heal_park "$ROUND_SNAP")
ROUND_SNAP=$(printf '%s' "$SELF_HEAL_OUT" | jq -c '.snapshot')

# --- CI-Wache fuer GEPARKTE Tickets (#154, erweitert um #173) ----------------
# Die Wache oben (#147) beobachtet nur das eine 'in-progress'-Ticket -- ein
# 'parked'-Ticket faellt durch beide Raster: es traegt kein 'in-progress' mehr
# (#145 gibt den Bauplatz frei) und die Ticketauswahl greift es erst wieder auf,
# wenn 'needs-input' manuell weg ist. Wird sein PR in der Zwischenzeit
# komplett gruen (z.B. weil ein Mensch 'human-approved' gesetzt hat und
# 'protected-paths' nachgelaufen ist), blieb der Draft bisher fuer immer
# Draft -- niemand hat mehr hingeschaut. Hier werden ALLE 'parked'-Tickets
# geprueft, nicht nur eins, aeltestes zuerst.
#
# 'behind' (#160): liegt ein geparkter PR hinter 'main', wird per git
# nachgezogen -- sonst wartet ein laengst freigegebener PR ewig weiter, weil
# ihn ausser dieser Wache niemand mehr anfasst. Reines Nachziehen (kein
# Konflikt) bleibt ein Git-Vorgang ohne Agent (AC1).
#
# 'conflict' (echtes Scheitern des Nachziehens) und 'failing' (rote Checks
# ueber 'protected-paths' hinaus, #173): das ist inhaltliche Arbeit, kein
# Wartezustand -- hier wird EIN Ticket entparkt (in-progress statt parked),
# WENN gerade wirklich kein anderes in-progress ist (WIP-Limit=1, CLAUDE.md
# Regel 1) UND keine offene Frage (needs-input) mehr aussteht -- eine
# ungeklaerte menschliche Antwort geht vor jedem automatischen Entparken
# (CLAUDE.md Regel 11). Hoechstens EIN Ticket wird so pro Runde entparkt;
# alle weiteren bleiben geparkt und werden im naechsten Takt erneut geprueft.
# Das entparkte Ticket wird NICHT hier direkt gebaut -- es landet nur mit
# 'in-progress' zurueck in $ROUND_SNAP, die WIP-Auswahl gleich danach greift
# es dann wie ein ganz normales laufendes Ticket auf, und die bestehende
# CI-Wache fuer laufende Tickets (#147/#160, gleich im Anschluss) leitet
# daraus CI_FIX/CI_SUMMARY (Konfliktdateien bzw. Fehler-Summary) ab und
# startet den Fix-Agenten -- keine doppelte Logik noetig. Wiederholte
# Fehlschlaege auf diesem Weg zaehlen ganz normal in die bestehende
# Eskalation ein (build_escalation_eval, ADR-0007), weil RUN_ROLE=build
# unveraendert bleibt.
#
# 'failing' NUR bei 'protected-paths' bleibt die vorgesehene Genehmigungs-
# Schranke -- kein Fund, kein Entparken, das Ticket wartet weiter auf
# 'human-approved'.
RELEASED_PARKED_NOTE=""
PARKED_SNAP=$(printf '%s' "$ROUND_SNAP" | jq -c \
  '[.[] | select(.labels | map(.name) | index("parked"))
        | {number:.number, createdAt:.createdAt,
           hasNeedsInput:((.labels|map(.name)|index("needs-input")) != null)}]' 2>/dev/null)
if [ "$(printf '%s' "${PARKED_SNAP:-[]}" | jq 'length' 2>/dev/null)" -gt 0 ]; then
  WIP_TAKEN_BEFORE=$(printf '%s' "$ROUND_SNAP" \
    | jq '[.[] | select(.labels | map(.name) | index("in-progress"))] | length' 2>/dev/null)
  WIP_SLOT_FREE=""
  [ "${WIP_TAKEN_BEFORE:-0}" -eq 0 ] && WIP_SLOT_FREE=1
  WATCH_PARKED_OUT=$(watch_parked_issues "$PARKED_SNAP" "$WIP_SLOT_FREE")

  PROMOTED_PARKED_ISSUE=$(printf '%s' "$WATCH_PARKED_OUT" | jq -r '.promoted.issue // empty')
  if [ -n "$PROMOTED_PARKED_ISSUE" ]; then
    PROMOTE_REASON=$(printf '%s' "$WATCH_PARKED_OUT" | jq -r '.promoted.reason')
    ROUND_SNAP=$(printf '%s' "$ROUND_SNAP" | jq --argjson n "$PROMOTED_PARKED_ISSUE" \
      '[.[] | if .number == $n then
                (.labels |= (map(select(.name != "parked")) + [{"name":"in-progress"}]))
              else . end]')
    RELEASED_PARKED_NOTE="$RELEASED_PARKED_NOTE

🔓 **Geparktes Ticket entparkt:** #$PROMOTED_PARKED_ISSUE hing an $PROMOTE_REASON fest — der nächste freie Bauplatz startet einen Fix-Lauf."
  fi

  RELEASED_PARKED_NUMS=$(printf '%s' "$WATCH_PARKED_OUT" | jq -c '.released')
  if [ "$(printf '%s' "$RELEASED_PARKED_NUMS" | jq 'length')" -gt 0 ]; then
    ROUND_SNAP=$(printf '%s' "$ROUND_SNAP" | jq --argjson released "$RELEASED_PARKED_NUMS" \
      '[.[] | if (.number as $n | $released | index($n) != null) then
                (.labels |= map(select(.name != "parked" and .name != "needs-input")))
              else . end]')
    RELEASED_LIST=$(printf '%s' "$RELEASED_PARKED_NUMS" | jq -r 'map("#" + (.|tostring)) | join(", ")')
    RELEASED_PARKED_NOTE="$RELEASED_PARKED_NOTE

🔓 **Geparktes Ticket freigegeben:** CI komplett grün — Draft auf \`ready\`, Auto-Merge aktiviert: $RELEASED_LIST."
  fi
fi

# 1) Läuft schon eins? -> fortsetzen (WIP-Limit = 1)
#    'needs-input' schließt aus: dieses Ticket wartet auf den Menschen. Ohne den
#    Filter nimmt der Timer es alle 5 Minuten neu auf — mit derselben offenen
#    Frage und vollem Token-Verbrauch.
WIP=$(printf '%s' "$ROUND_SNAP" \
        | jq -c '[.[] | select(.labels | map(.name) | index("in-progress"))]')

ISSUE=$(echo "$WIP" | jq -r '[.[] | select((.labels | map(.name)
             | index("needs-input")) | not)]
           | sort_by(.createdAt) | .[0].number // empty')
MODE=resume
RUN_ROLE=build

# --- CI-Wache fuer ein laufendes Bau-Ticket (#147) --------------------------
# Der Bau-Agent endet beim Push und hinterlaesst hoechstens einen offenen
# Draft-PR. BEVOR ueberhaupt an Fortsetzung oder eine neue Ticketwahl gedacht
# wird: hat DIESES Ticket schon einen offenen PR, entscheidet allein dessen
# CI-Zustand den Takt -- kein Agentenlauf fuers Warten, kein Wechsel auf ein
# anderes Ticket, solange hier noch etwas offen ist.
CI_FIX=0
CI_SUMMARY=""
if [ -n "$ISSUE" ]; then
  PR_NUM=$(pr_for_issue "$ISSUE")
  if [ -n "$PR_NUM" ]; then
    WATCH_OUT=$(watch_running_issue "$ISSUE" "$PR_NUM")
    case "$(printf '%s' "$WATCH_OUT" | jq -r '.kind')" in
      pending)
        status "CI läuft für #$ISSUE" "🟢" \
          "🟢 **CI läuft für #$ISSUE** (PR #$PR_NUM) — kein laufender Prozess hier.

Der nächste Takt prüft erneut, sobald die Checks durch sind. **Kein Eingreifen nötig.**"
        return 0
        ;;
      merged)
        status "wartet auf Merge · #$ISSUE" "🟢" \
          "🟢 **CI grün für #$ISSUE** (PR #$PR_NUM) — als \`ready\` markiert, Auto-Merge aktiviert.

GitHub mergt, sobald alle Required Checks final durch sind. **Kein Eingreifen nötig.**"
        return 0
        ;;
      needs-input-protected)
        status "wartet auf dich (#$ISSUE)" "🟡" \
          "🟡 **PR #$PR_NUM für #$ISSUE braucht deine Freigabe.**

Der Check \`protected-paths\` ist rot, weil geschützte Pfade berührt sind (Begründung
steht als Kommentar am Ticket). Setze \`human-approved\` am PR **und entferne**
\`needs-input\` vom Issue — der Check läuft dann automatisch neu, und der nächste
Takt beobachtet die CI weiter."
        return 0
        ;;
      build-fix)
        CI_FIX=1
        CI_SUMMARY=$(printf '%s' "$WATCH_OUT" | jq -r '.summary')
        ;;
      caught-up)
        status "CI läuft für #$ISSUE" "🟢" \
          "🟢 **Branch für #$ISSUE nachgezogen** (PR #$PR_NUM lag hinter \`main\`) — per \`git\` gemergt und gepusht, kein Agentenlauf. CI läuft jetzt neu.

Der nächste Takt prüft erneut. **Kein Eingreifen nötig.**"
        return 0
        ;;
      retry)
        # #171: Ursache immer benennen (AC1/AC2), stoerende Pfade bei
        # unsauberem Arbeitsbaum mitliefern (AC1), ab der dritten Runde in
        # Folge mit DERSELBEN Ursache auf 🟡 wechseln (AC3) -- alles bereits
        # in watch_running_issue() entschieden (watchReaction/'behind-retry').
        CATCHUP_REASON=$(printf '%s' "$WATCH_OUT" | jq -r '.reason')
        CATCHUP_PATHS_LIST=$(printf '%s' "$WATCH_OUT" | jq -r '.paths | join(",")')
        CATCHUP_PATHS=""
        [ -n "$CATCHUP_PATHS_LIST" ] && CATCHUP_PATHS="

Störende Pfade: \`${CATCHUP_PATHS_LIST}\`"
        if [ "$(printf '%s' "$WATCH_OUT" | jq -r '.escalated')" = "true" ]; then
          status "wartet auf dich (#$ISSUE)" "🟡" \
            "🟡 **Nachziehen von \`main\` für #$ISSUE (PR #$PR_NUM) hängt fest.**

Ursache seit drei Runden in Folge dieselbe: $CATCHUP_REASON.${CATCHUP_PATHS}

Das löst sich nicht von selbst — der Runner räumt keine fremden Dateien weg. Bitte
im Arbeitsbaum des Runners nachsehen und aufräumen, dann läuft der nächste Takt normal weiter."
          return 0
        fi
        status "CI läuft für #$ISSUE" "🟢" \
          "🟢 **CI läuft für #$ISSUE** (PR #$PR_NUM) — Branch liegt hinter \`main\`, das Nachziehen ist gerade nicht möglich ($CATCHUP_REASON).${CATCHUP_PATHS} Nächster Takt versucht es erneut. **Kein Eingreifen nötig.**"
        return 0
        ;;
    esac
  fi
fi

if [ -z "$ISSUE" ]; then
  PICK_OUT=$(pick_ticket "$ROUND_SNAP" "$QUEUE_BODY")
  case "$(printf '%s' "$PICK_OUT" | jq -r '.kind')" in
    blocked)
      # Sicherheitsnetz (#145): normalerweise hat die Selbstheilung oben jedes
      # in-progress+needs-input-Ticket schon zu 'parked' umgelabelt. Landet
      # hier trotzdem noch etwas (der gh-Aufruf der Selbstheilung ist
      # fehlgeschlagen), gilt weiterhin: lieber blockieren als riskant ein
      # zweites Ticket parallel anzufangen, waehrend am ersten unklar ist,
      # wer daran sitzt.
      PARKED=$(printf '%s' "$PICK_OUT" | jq -r '.issues | map("#" + (.|tostring)) | join(", ")')
      status "wartet auf dich ($PARKED)" "🟡" \
        "🟡 **Ich warte auf eine Antwort von dir.**

Ticket $PARKED ist in Arbeit, hängt aber an einer offenen Frage.

Antworte als Kommentar am Ticket und **entferne dann das Label \`needs-input\`** —
erst dann arbeite ich weiter. Bis dahin fasse ich es nicht an."
      return 0
      ;;
    ticket)
      ISSUE=$(printf '%s' "$PICK_OUT" | jq -r '.issue')
      RUN_ROLE=$(printf '%s' "$PICK_OUT" | jq -r '.role')
      MODE=$(printf '%s' "$PICK_OUT" | jq -r '.mode')
      ;;
    none)
      # Nichts zu holen. Aber liegt etwas bei DIR? Dann ist Gelb die Wahrheit —
      # "nichts zu tun" wäre hier eine Lüge, die dich das Ticket übersehen lässt.
      WAITING=$(printf '%s' "$ROUND_SNAP" | jq -r \
                  '[.[] | select(.labels | map(.name) | index("needs-input"))]
                    | sort_by(.number) | map("#" + (.number|tostring)) | join(", ")')
      if [ -n "$WAITING" ]; then
        status "wartet auf dich ($WAITING)" "🟡" \
          "🟡 **Ich warte auf eine Antwort von dir.**

Offene Fragen an: $WAITING

Antworte als Kommentar am Ticket und **entferne dann das Label \`needs-input\`** —
sonst starte ich in 5 Minuten mit derselben offenen Frage neu."
      else
        # ready/needs-plan sind an dieser Stelle schon ausgeschlossen (siehe
        # pick_ticket()) -- einzig needs-research kaeme hier noch als
        # Queue-Arbeit in Frage, ist aber (mangels Runner-Zweig, siehe #43)
        # nicht baubereit.
        SNAP=$(queue_snapshot)
        PENDING=$(queue_pending "$SNAP")
        if [ -n "$PENDING" ]; then
          status "wartet auf nächsten Lauf · Queue: $PENDING" "🟢" \
            "🟢 **Ich warte auf den nächsten Lauf — gerade läuft kein Prozess.**

In der Queue liegt noch Arbeit ($PENDING), aber derzeit kein baubereites Ticket
(z. B. nur Recherche). **Kein Eingreifen nötig.**"
        elif [ "${DID_WORK:-0}" = 1 ]; then
          # Chaining (#61): eine frühere Runde in diesem Tick hat produktiv
          # gearbeitet, jetzt ist die Queue leer -- ⚪️ "nichts zu tun" wäre
          # hier eine Lüge (klingt nach "nie etwas getan"), 🟢 ist korrekt.
          status "läuft · zuletzt #$LAST_ISSUE" "🟢" \
            "🟢 **Nichts offen.** Zuletzt an #$LAST_ISSUE gearbeitet, die Queue ist leer.
Kein Eingreifen nötig."
        else
          status "nichts zu tun" "⚪️" \
            "⚪️ Kein Ticket mit Label \`ready\`, \`needs-plan\` oder \`needs-research\`. Ich habe nichts zu arbeiten.

Gib ein Ticket frei, indem du ihm das Label \`ready\` gibst."
        fi
      fi
      return 0
      ;;
  esac
fi

# Kein Tages-Deckel fürs Denken (Planung/Recherche): ein komplexer Plan darf so
# viele Opus-Läufe kosten, wie er braucht — ihn nach zwei Läufen für einen Tag zu
# parken widerspräche dem Ziel unbeaufsichtigten Fortschritts. Die Obergrenze ist
# das echte Nutzungs-/Session-Limit des Plans (429 -> blocked-limit, wird unten
# behandelt und läuft von selbst weiter), die Handbremse der Kill-Switch 'no-opus'
# in der Ticket-Auswahl. Siehe ADR-0005. Fürs Bauen gilt das NICHT: die
# Eskalations-Rolle (ADR-0007) hat einen harten Tages-Deckel, siehe unten bei
# der Modellwahl.

SID_FILE="$STATE_DIR/session-$ISSUE"
LOG="$STATE_DIR/last-run.log"

# Ab hier ist $ISSUE fest und der claude-Aufruf steht kurz bevor. Genau das war
# die Luecke aus #19: zwischen Ticketwahl und Rueckkehr des Laufs (bis zu
# MAX_RUNTIME = 45 Minuten) stand im Status-Ticket noch der Stand des LETZTEN
# Laufs. Deshalb hier -- VOR dem claude-Aufruf -- schon "arbeitet an" setzen.
#
# Bricht dieser Lauf hart ab (Absturz, Stromausfall), bleibt zwar "arbeitet an"
# stehen -- aber der naechste Lauf ueberschreibt es sofort wieder an genau
# dieser Stelle (Start oder Resume), bevor er selbst zu arbeiten beginnt. Ein
# irrefuehrender Zustand ueberlebt also nie mehr als bis zum naechsten Takt.
START_HM=$(date "+%H:%M")

# Seit #145 kann ein 'parked'-Ticket (wartet auf dich) neben dem aktiven
# koexistieren -- die Busy-Meldung darf das nicht verschweigen (AC6), sonst
# sieht man auf dem Handy nur "🟠 arbeitet an #X" und uebersieht, dass woanders
# eine Antwort faellig ist.
PARKED_NOW=$(parked_issues)
PARKED_NOTE=""
if [ -n "$PARKED_NOW" ]; then
  PARKED_NOTE="

🟡 Wartet zusätzlich auf dich: $PARKED_NOW (Antwort + \`needs-input\` entfernen setzt die Arbeit dort fort)."
fi

if [ "$RUN_ROLE" = "plan" ]; then
  status "plant #$ISSUE (seit $START_HM)" "🟠" \
    "🟠 **Plant gerade #$ISSUE** (Opus, nur lesend), seit $START_HM.

Laeuft bis zu $((MAX_RUNTIME / 60)) Minuten. **Kein Eingreifen noetig**, solange
hier keine anderen Status (🟡/🔴) folgen.${PARKED_NOTE}"
elif [ "$RUN_ROLE" = "research" ]; then
  status "recherchiert #$ISSUE (seit $START_HM)" "🟠" \
    "🟠 **Recherchiert gerade #$ISSUE** (Opus, nur lesend), seit $START_HM.

Laeuft bis zu $((MAX_RUNTIME / 60)) Minuten. **Kein Eingreifen noetig**, solange
hier keine anderen Status (🟡/🔴) folgen.${PARKED_NOTE}"
else
  status "arbeitet an #$ISSUE (seit $START_HM)" "🟠" \
    "🟠 **Arbeitet gerade an #$ISSUE**, seit $START_HM.

Laeuft bis zu $((MAX_RUNTIME / 60)) Minuten. **Kein Eingreifen noetig**, solange
hier keine anderen Status (🟡/🔴) folgen.${PARKED_NOTE}"
fi

# --- Modell nach Rolle/Label/Eskalationsstufe --------------------------------
# Planer- und Recherche-Rolle laufen immer mit Opus (siehe ADR-0005),
# unabhängig vom Label. Bau-Rolle: 'tier_current' liefert die aktuelle
# Eskalationsstufe (ADR-0007) -- Default 'sonnet' bzw. 'haiku' bei Label
# 'model:haiku', nach drei erfolglosen Läufen 'opus'. Kill-Switch
# 'no-escalation' friert auf der Default-Stufe ein, unabhaengig von einer
# eventuell schon gesetzten Stufe.
LABELS=$(gh issue view "$ISSUE" --json labels -q '.labels[].name' | tr '\n' ' ')
if [ "$RUN_ROLE" = "plan" ] || [ "$RUN_ROLE" = "research" ]; then
  MODEL="opus"
else
  case "$LABELS" in
    *no-escalation*)
      case "$LABELS" in
        *model:haiku*) MODEL="haiku" ;;
        *)             MODEL="sonnet" ;;
      esac
      ;;
    *) MODEL=$(tier_current "$ISSUE") ;;
  esac
fi

# --- Opus-Bau-Deckel (ADR-0007) ----------------------------------------------
# Nur relevant, wenn die Eskalation tatsaechlich bei Opus angekommen ist. Der
# Deckel greift VOR dem claude-Aufruf, damit ein erschoepftes Tagesbudget nicht
# noch einen (teuren) dritten Opus-Lauf kostet.
if [ "$RUN_ROLE" = "build" ] && [ "$MODEL" = "opus" ]; then
  if opus_build_cap_reached "$ISSUE" "$LABELS"; then
    # Meldung hoechstens einmal je Ticket und Tag (#136) -- eine tagesgestempelte
    # Stempeldatei statt bei jedem Tick erneut zu posten.
    CAP_MSG_STAMP="$STATE_DIR/opus-cap-msg-$(date +%Y%m%d)-$ISSUE"
    if [ ! -e "$CAP_MSG_STAMP" ]; then
      gh issue comment "$ISSUE" --body \
        "🤖 Opus-Tagesbudget (2 Bau-Läufe) für #$ISSUE ist für heute erschöpft — die Eskalation bleibt auf der höchsten Stufe stecken.

Morgen geht ein neuer Opus-Bau-Versuch automatisch weiter. Setze das Label \`opus-boost\`, um für dieses Ticket noch heute einen weiteren Opus-Bau-Versuch freizugeben (wird nur bei ausbleibendem Fortschritt wieder abgezogen). Willst du dauerhaft bei Sonnet/Haiku bleiben, setze stattdessen das Label \`no-escalation\`." \
        >/dev/null 2>&1
      touch "$CAP_MSG_STAMP"
    fi
    gh issue edit "$ISSUE" --add-label needs-input >/dev/null 2>&1
    status "wartet auf dich (#$ISSUE)" "🟡" \
      "🟡 **Opus-Tagesbudget für #$ISSUE erschöpft.** Ich warte auf dich."
    return 0
  fi
  opus_build_cap_reserve "$ISSUE"
fi

# Vor dem Lauf die Branch-Spitze merken -- der Vergleich danach entscheidet
# in build_escalation_eval, ob dieser Lauf Fortschritt gebracht hat (ADR-0007).
BEFORE_TIP=""
[ "$RUN_ROLE" = "build" ] && BEFORE_TIP=$(branch_tip "$ISSUE")

# --- Der Bau-Prompt -----------------------------------------------------------
read -r -d '' PROMPT <<EOF
Du arbeitest UNBEAUFSICHTIGT. Es sitzt niemand am Terminal.

Arbeite an Issue #$ISSUE in diesem Repo.

**Dateizugriff bleibt im Repo.** Führe keine rekursiven oder dateisystemweiten Suchen
außerhalb dieses Repos (des ausgecheckten Arbeitsbaums) aus — kein 'find', 'grep -r',
'mdfind' oder 'locate' über das Home-Verzeichnis, '/' oder '/Volumes' — und betritt
niemals '/Volumes' oder '~/Library/Mobile Documents' (iCloud). Solche Zugriffe lösen
auf macOS einen modalen TCC-Dialog aus, der den unbeaufsichtigten Lauf blockiert, bis
die Notbremse ihn abwürgt (siehe #38). Gezielte Einzeldatei-Reads außerhalb des Repos
nur, wenn ein Ticket sie ausdrücklich verlangt.

Ablauf:
1. Pflichtlektüre ist NUR CLAUDE.md und docs/CODEMAP.md. Nichts sonst liest du
   vorab. Weitere Dokumente liest du gezielt, sobald das Ticket sie nennt oder
   einer dieser Auslöser zutrifft:
   - Schema-/Migrations-Arbeit → docs/ARCHITECTURE.md + docs/adr/0003-m0-dependencies.md
   - UI-/Design-Arbeit → docs/DESIGN_SYSTEM.md
   - Journal-/Krypto-Arbeit → docs/adr/0004-journal-metadaten-verschluesseln.md
   - Architektur-/Grundsatzfrage → das passende ADR unter docs/adr/
   Die im Ticket unter „Betroffene Dateien"/„Betroffene Docs" genannten Pfade
   sind Pflicht — lies sie selektiv, nie das halbe Repo.
2. Lies das Issue: gh issue view $ISSUE --comments
3. Falls es bereits einen Branch und einen Fortschrittskommentar gibt:
   checke den Branch aus, lies den Fortschrittskommentar und 'git log',
   und mach beim nächsten offenen Punkt weiter. Fang NICHT von vorne an.
4. Arbeite die Akzeptanzkriterien ab. Committe nach jedem abgeschlossenen
   Schritt. Bevor du pushst: lass die schnellen Tore lokal laufen —
   'pnpm lint', 'pnpm typecheck', 'pnpm test' (zusammen unter einer Minute) —
   und behebe Rot dort selbst. Kein voller 'pnpm e2e' lokal, das kostet zu
   viel vom Zeitfenster und die volle Suite läuft ohnehin in CI.
   Unmittelbar vor dem finalen Push ziehst du 'main' proaktiv nach, damit
   der PR nicht schon als „behind" entsteht: erst sicherstellen, dass der
   Arbeitsbaum sauber ist (alles committet — niemals in einen unsauberen
   Baum mergen), dann 'git fetch origin main' + 'git merge origin/main
   --no-edit'. Merge sauber: normal weiterpushen. Merge-Konflikt: du löst
   ihn direkt auf deinem Branch auf (du kennst deine eigenen Änderungen am
   besten), committest die Auflösung, pushst — kein separater, kalt
   einsteigender Fix-Lauf nötig. 'pr_catch_up_behind()' im Runner-Takt
   bleibt zusätzlich als Sicherheitsnetz bestehen, falls unmittelbar nach
   deinem Push noch ein weiterer PR merged. Dann pushe den Branch.
5. Halte den Fortschrittskommentar am Issue nach JEDEM Schritt aktuell. Bevor du
   feststeckst oder der Lauf endet, ohne dass das Ticket fertig ist: ergaenze im
   Fortschrittskommentar einen Blocker-Abschnitt (nicht nur "← HIER WEITER"):
   - aktuelle Wiederaufnahmestelle (wie bisher),
   - bei rotem Gate: der konkrete Testname + Kernursache, ein bis zwei Zeilen,
     KEIN Log-Dump,
   - Endgrund: 'gate-rot' oder 'frage-offen' (Limit/Timeout traegt das Runner-
     Skript selbst nach, das musst du nicht tun).
   Steht im Fortschrittskommentar bereits ein Abschnitt "## Was schon versucht
   wurde": lies ihn ZUERST und schlage keinen dort als ausgeschlossen
   vermerkten Weg erneut ein -- das waere ein Fehlschlag des Tickets, nicht
   nur verlorene Zeit. Ab dem ERSTEN erfolglosen Bau-Lauf haengst du selbst
   an diesen Abschnitt an (er waechst, wird nie ueberschrieben): was du
   versucht hast, woran es scheiterte, was damit ausgeschlossen ist -- in
   Klartext, kein Signatur-Hash. Ab demselben Zeitpunkt schneidest du die
   Checkliste feiner: ein Haken je Fehlereinheit (je rotem Test, je rotem
   Check) statt je Phase, mit Gruppenkopf "(N von M gruen)"; jede geloeste
   Einheit einzeln committen und pushen, der Marker "← HIER WEITER" ruckt auf
   die naechste offene Einheit, geloeste bleiben abgehakt.
6. Wenn du eine Entscheidung brauchst: Kommentar am Issue mit konkreten
   Optionen und deiner Empfehlung, Label 'needs-input' setzen, beenden.
   Rate niemals. Schreib die Frage NICHT nach stdout.
7. Existiert für dieses Ticket noch KEIN PR: öffne einen **Draft**-PR
   ('gh pr create --draft --fill --title "… — Closes #$ISSUE"'), Titel
   enthält 'Closes #$ISSUE'. Existiert bereits einer (z. B. bei einer
   Fortsetzung): pushe nur weiter auf denselben Branch, KEIN zweiter PR.
   Berührt dein Diff einen geschützten Pfad (src/db/, src/crypto/,
   src/local/, src/app/api/sync/, auth, .github/, scripts/): kommentiere
   JETZT am Issue, was du geändert hast, warum, und was schiefgehen könnte,
   und setze SELBST 'gh issue edit $ISSUE --add-label needs-input' — nimm
   es in diesem Lauf NICHT wieder ab. Das parkt das Ticket (#145) sofort,
   der Runner wählt als nächstes ein anderes, statt auf das rote
   CI-Ergebnis zu warten, das du ohnehin nicht mehr live mitbekommst.
8. Endet dein Lauf hier SAUBER — also über diesen Schritt, nicht über
   Schritt 6 (offene Frage) —: hebe deinen PR SELBST aus dem Entwurf und
   aktiviere Auto-Merge, auch wenn du gerade in Schritt 7 wegen eines
   geschützten Pfads 'needs-input' gesetzt hast:
   'gh pr ready' und 'gh pr merge --squash --auto --delete-branch'
   (ohne PR-Nummer — wirkt auf den PR des aktuellen Branches). Du musst
   NICHT wissen, ob CI schon grün ist: GitHub merged automatisch nur bei
   grünen Required Checks. Bei geschütztem Pfad hält 'protected-paths'
   ohnehin rot, bis ein Mensch 'human-approved' setzt — der PR ist dann
   zwar kein Entwurf mehr, wartet aber trotzdem. Dein Lauf endet danach.
   **Kein** 'gh pr checks --watch', **kein** voller 'pnpm e2e' lokal — der
   Runner-Takt beobachtet ab hier die CI und holt dich nur zurück, wenn
   dort etwas rot wird.
EOF

# --- Der CI-Fix-Prompt (#147) -------------------------------------------------
# Wird statt $PROMPT verwendet, wenn die CI-Wache (siehe pr_ci_state oben)
# rote Checks am Draft-PR gefunden hat, die NICHT ausschliesslich
# 'protected-paths' sind. Der Agent bekommt die Ursache direkt mit statt sie
# erst muehsam neu zu suchen -- deshalb startet er hier gezielt, nicht routinemaessig.
read -r -d '' CI_FIX_PROMPT <<EOF
Du arbeitest UNBEAUFSICHTIGT. Es sitzt niemand am Terminal.

Der Draft-PR zu Issue #$ISSUE hat rote CI. Der Runner-Takt hat gewartet, bis
alle Checks durch waren, und startet dich JETZT gezielt, weil es etwas zu TUN
gibt.

**Dateizugriff bleibt im Repo.** Führe keine rekursiven oder dateisystemweiten Suchen
außerhalb dieses Repos (des ausgecheckten Arbeitsbaums) aus — kein 'find', 'grep -r',
'mdfind' oder 'locate' über das Home-Verzeichnis, '/' oder '/Volumes' — und betritt
niemals '/Volumes' oder '~/Library/Mobile Documents' (iCloud). Solche Zugriffe lösen
auf macOS einen modalen TCC-Dialog aus, der den unbeaufsichtigten Lauf blockiert, bis
die Notbremse ihn abwürgt (siehe #38). Gezielte Einzeldatei-Reads außerhalb des Repos
nur, wenn ein Ticket sie ausdrücklich verlangt.

## Was rot ist

$CI_SUMMARY

## Ablauf

1. Checke den bestehenden Branch aus, lies den Fortschrittskommentar am Issue
   (gh issue view $ISSUE --comments) und 'git log'. Steht dort bereits ein
   Abschnitt „## Was schon versucht wurde": lies ihn ZUERST und schlage
   keinen dort ausgeschlossenen Weg erneut ein.
2. Bei einem roten Playwright-Trace: erst den Trace lesen
   ('npx playwright show-trace test-results/…/trace.zip'), dann verstehen,
   dann fixen. Die Ursache beheben — NIE den Test aufweichen: kein
   '.skip', kein hochgesetzter Timeout, kein gelockertes Assert, kein
   'waitForTimeout'.
3. Vor dem Push die schnellen Tore lokal grün: 'pnpm lint', 'pnpm typecheck',
   'pnpm test'.
4. Committe, pushe auf denselben Branch. Kein neuer PR — der Draft existiert
   bereits.
5. Aktualisiere den Fortschrittskommentar (Marker „← HIER WEITER" rückt vor;
   bei erneutem Fehlschlag wächst „## Was schon versucht wurde", wird nie
   überschrieben).
6. Endet dein Lauf hier SAUBER (Fix gepusht) — also nicht über Schritt 7
   (offene Frage) —: 'gh pr ready' und
   'gh pr merge --squash --auto --delete-branch' (ohne PR-Nummer — wirkt
   auf den PR des aktuellen Branches). Meist ist der PR das schon (ein
   früherer sauberer Bau-Lauf hat das erledigt) — der Aufruf ist folgenlos,
   wenn er es bereits ist, und das Sicherheitsnetz, falls nicht. Dein Lauf
   endet danach. **Kein** 'gh pr checks --watch' — das übernimmt wieder
   der Runner-Takt.
7. Brauchst du eine Entscheidung: Kommentar am Issue mit konkreten Optionen +
   deiner Empfehlung, Label 'needs-input' setzen, beenden. Rate niemals.
EOF

# --- Der Planer-Prompt (RUN_ROLE=plan, siehe ADR-0005) -----------------------
# Nur lesend: kein Edit/Write, kein Branch, kein Commit. Schreibt den Plan
# inkrementell in EINEN Kommentar und flippt needs-plan -> ready erst, wenn
# der Plan wirklich fertig ist.
read -r -d '' PLAN_PROMPT <<EOF
Du arbeitest UNBEAUFSICHTIGT als **Planer** (Opus, nur lesend). Ändere KEINEN
Code, lege KEINEN Branch an, committe NICHT.

**Dateizugriff bleibt im Repo.** Führe keine rekursiven oder dateisystemweiten Suchen
außerhalb dieses Repos (des ausgecheckten Arbeitsbaums) aus — kein 'find', 'grep -r',
'mdfind' oder 'locate' über das Home-Verzeichnis, '/' oder '/Volumes' — und betritt
niemals '/Volumes' oder '~/Library/Mobile Documents' (iCloud). Solche Zugriffe lösen
auf macOS einen modalen TCC-Dialog aus, der den unbeaufsichtigten Lauf blockiert, bis
die Notbremse ihn abwürgt (siehe #38). Gezielte Einzeldatei-Reads außerhalb des Repos
nur, wenn ein Ticket sie ausdrücklich verlangt.

1. Lies CLAUDE.md, docs/ (v. a. docs/adr/, docs/ARCHITECTURE.md), das Issue
   (gh issue view $ISSUE --comments) und den **aktuellen Code** der betroffenen
   Dateien.
2. Existiert bereits ein Plan-Kommentar mit „🧠 Plan (Opus) — Status: in
   Arbeit": **setze ihn fort** ab dem Marker „← HIER WEITER BEIM PLANEN",
   statt neu zu beginnen.
3. Erstelle/ergänze in **einem** Kommentar (gh issue comment --edit-last)
   einen **dateiweisen** Umsetzungsplan: pro Datei was sich ändert, Testplan,
   Risiko/Rückweg, Wiederaufnahmepunkte. Statuszeile oben: „🧠 Plan (Opus) —
   Status: **in Arbeit**" + Marker „← HIER WEITER BEIM PLANEN: <Abschnitt>".
4. Brauchst du eine **menschliche Entscheidung** (nicht nur einen Plan):
   Statuszeile auf „Status: **wartet auf Entscheidung**", Label
   'needs-input' setzen, beenden. Rate nie.
5. Ist der Plan **vollständig**: Statuszeile „Status: **fertig**", Marker
   entfernen, dann gh issue edit $ISSUE --remove-label needs-plan --add-label
   ready. Erst dieser abschließende Schritt flippt das Label.
EOF

# --- Der Recherche-Prompt (RUN_ROLE=research, siehe ADR-0005 + #43) ----------
# Nur lesend: kein Edit/Write, kein Branch, kein Commit. Idee-/Feature-Ebene
# (Ob & Was, grober Schnitt) -- KEIN dateiweiser Plan, das ist RUN_ROLE=plan.
# Schreibt die Überlegung inkrementell in EINEN Kommentar und flippt
# needs-research -> needs-input erst, wenn die Überlegung wirklich fertig ist
# (auch dann, wenn die Idee der Vision widerspricht -- nie eigenmächtig
# verwerfen, das entscheidet der Mensch).
read -r -d '' RESEARCH_PROMPT <<EOF
Du arbeitest UNBEAUFSICHTIGT als **Feature-Rechercheur** (Opus, nur lesend).
Ändere KEINEN Code, lege KEINEN Branch an, committe NICHT.

**Dateizugriff bleibt im Repo.** Führe keine rekursiven oder dateisystemweiten Suchen
außerhalb dieses Repos (des ausgecheckten Arbeitsbaums) aus — kein 'find', 'grep -r',
'mdfind' oder 'locate' über das Home-Verzeichnis, '/' oder '/Volumes' — und betritt
niemals '/Volumes' oder '~/Library/Mobile Documents' (iCloud). Solche Zugriffe lösen
auf macOS einen modalen TCC-Dialog aus, der den unbeaufsichtigten Lauf blockiert, bis
die Notbremse ihn abwürgt (siehe #38). Gezielte Einzeldatei-Reads außerhalb des Repos
nur, wenn ein Ticket sie ausdrücklich verlangt.

1. Verstehe die Idee im Issue (gh issue view $ISSUE --comments).
2. Prüfe den Fit gegen docs/VISION.md, docs/ARCHITECTURE.md, docs/DESIGN_SYSTEM.md
   und den bestehenden Code. Optional knappe Web-Recherche (bounded) über das
   WebSearch-Werkzeug.
3. Existiert bereits ein Rechercheergebnis-Kommentar mit „🔎 Recherche — Status:
   in Arbeit": **setze ihn fort** ab dem Marker „← HIER WEITER BEI DER
   RECHERCHE", statt neu zu beginnen.
4. Erstelle/ergänze in **einem** Kommentar (gh issue comment --edit-last) eine
   **Überlegung** auf Idee-/Feature-Ebene: Was ist es? Passt es zur Vision
   (auch: passt es *nicht* — das klar benennen, nicht eigenmächtig verwerfen)?
   2–3 Ansätze mit Trade-offs, Empfehlung, grober Scope. **Kein Code, keine
   dateiweise Umsetzung** — das ist der spätere Planer-Lauf (needs-plan).
   Statuszeile oben: „🔎 Recherche — Status: **in Arbeit**" + Marker „← HIER
   WEITER BEI DER RECHERCHE: <Abschnitt>".
5. Ist die Überlegung **vollständig** (auch wenn das Ergebnis ein Widerspruch
   zur Vision ist): Statuszeile „Status: **fertig**", Marker entfernen, dann
   gh issue edit $ISSUE --remove-label needs-research --add-label needs-input.
   Erst dieser abschließende Schritt flippt das Label — der Mensch entscheidet
   danach, ob daraus needs-plan wird oder die Idee verworfen wird.
EOF

# --- Claude starten ---------------------------------------------------------
# Praeventiv statt nur detektiv (#63): die Denk-Rollen bekommen keinen
# pauschalen Bash-Zugriff mehr, sondern eine Allowlist, die genau das erlaubt,
# was ihr Auftrag braucht -- 'gh' fuer Kommentare/Labels/Issue-Lektuere, sowie
# lesende git-Inspektion. Das git-status-Netz weiter unten bleibt zusaetzlich
# bestehen (Netz und doppelter Boden, siehe ADR-0005), faengt aber jetzt nur
# noch ab, was trotz Allowlist irgendwie durchrutscht.
READONLY_TOOLS="Read,Grep,Glob,Bash(gh:*),Bash(git log:*),Bash(git diff:*),Bash(git show:*)"

case "$RUN_ROLE" in
  plan)
    ARGS=(-p "$PLAN_PROMPT" --output-format json
          --model "$MODEL"
          --allowedTools "$READONLY_TOOLS")
    ;;
  research)
    ARGS=(-p "$RESEARCH_PROMPT" --output-format json
          --model "$MODEL"
          --allowedTools "$READONLY_TOOLS,WebSearch")
    ;;
  *)
    BUILD_PROMPT="$PROMPT"
    [ "$CI_FIX" = "1" ] && BUILD_PROMPT="$CI_FIX_PROMPT"
    ARGS=(-p "$BUILD_PROMPT" --output-format json
          --model "$MODEL"
          --allowedTools "Read,Edit,Write,Glob,Grep,Bash")
    ;;
esac
# Opus ist fuer den Runner tabu (siehe docs/TOKEN-BUDGET.md) -- ausser in den
# nur-lesenden Denk-Rollen aus docs/adr/0005-opus-im-runner.md (RUN_ROLE=plan,
# RUN_ROLE=research) und der Eskalations-Rolle aus
# docs/adr/0007-opus-eskalation-baut.md: dort baut Opus als letzte Modellstufe
# tatsaechlich (RUN_ROLE=build, MODEL=opus, siehe tier_current oben), mit
# Deckel 2 Laeufe/Ticket/Tag und Kill-Switch no-escalation.

if [ "$MODE" = "resume" ] && [ -s "$SID_FILE" ]; then
  # Resume-Deckel nur fuers Bauen (#62): die Denk-Rollen (plan/research) tragen
  # ihren Kontext bewusst in der Session -- dort ist die breite Lektuere der
  # Auftrag. Fuers Bauen liegt der Stand in Git + Fortschrittskommentar.
  if [ "$RUN_ROLE" != "build" ] || resume_allowed "$ISSUE"; then
    ARGS+=(--resume "$(cat "$SID_FILE")")
  fi
  # sonst: Deckel erreicht -> frischer Start ohne --resume (Zaehler wurde
  # in resume_allowed auf 0 zurueckgesetzt).
fi

run_limited "$MAX_RUNTIME" claude "${ARGS[@]}"
RC=$?
OUT=$(cat "$LOG" 2>/dev/null || echo "")

# Session-ID sichern (nur Komfort — die echte Wahrheit liegt in Git + Issue).
# Nach einem Timeout-Kill (Notbremse) oder sonst kaputtem $OUT ist '.result'
# kein valides JSON -> jq liefert leer -> eine leere Zeile wuerde die noch
# gueltige alte ID ueberschreiben, und der naechste Lauf koennte nicht mehr
# per --resume fortsetzen (#64). Nur bei einem NICHT-leeren Treffer schreiben,
# alte Datei sonst unangetastet lassen.
NEW_SID=$(echo "$OUT" | jq -r '.session_id // empty' 2>/dev/null)
[ -n "$NEW_SID" ] && printf '%s' "$NEW_SID" > "$SID_FILE"

# Ein frueherer Lauf koennte blocked-limit gesetzt haben. Wenn wir hier ankommen,
# ist das Limit vorbei (sonst waeren wir oben schon uebersprungen worden) — das
# Label ist also in JEDEM Ausgang unten stale, egal ob Erfolg oder Fehler. Weg
# damit, bevor wir es weiter unten bei Bedarf (429) neu setzen.
gh issue edit "$ISSUE" --remove-label blocked-limit >/dev/null 2>&1

# --- Read-only-Netz für Planer & Rechercheur (ADR-0005 + #63) ----------------
# Opus laeuft in RUN_ROLE=plan/research ohne Edit/Write und ohne pauschalen
# Bash-Zugriff -- nur die Allowlist $READONLY_TOOLS oben. Dieses Netz ist die
# zweite Absicherung, kein Ersatz dafuer: selbst mit enger Allowlist koennte
# ein Fehlverhalten (z.B. ueber ein erlaubtes Werkzeug) den Baum beschmutzen.
# Das darf nie unbemerkt durchrutschen: verwerfen, als Fehler behandeln,
# unabhaengig von RC (auch ein "erfolgreicher" Lauf zaehlt hier nicht).
if { [ "$RUN_ROLE" = "plan" ] || [ "$RUN_ROLE" = "research" ]; } \
   && [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  git checkout -- . 2>/dev/null
  git clean -fd 2>/dev/null
  ROLE_LABEL="Planer-Lauf"
  [ "$RUN_ROLE" = "research" ] && ROLE_LABEL="Recherche-Lauf"
  gh issue comment "$ISSUE" --body "🤖 Der $ROLE_LABEL (Opus, nur lesend) hat entgegen der Regel Dateien im Arbeitsbaum verändert. Verworfen, kein Commit. Siehe ADR-0005 (Read-only-Netz)." >/dev/null 2>&1
  gh issue edit "$ISSUE" --add-label needs-input >/dev/null 2>&1
  status "Fehler bei #$ISSUE" "🔴" \
    "🔴 **Fehler bei #$ISSUE.** Der $ROLE_LABEL hat unerwartet Dateien geändert — verworfen, kein Commit.

Details stehen als Kommentar am Ticket. Ich fasse #$ISSUE nicht wieder an, solange \`needs-input\` hängt."
  return 1
fi

TRANSIENT_FILE="$STATE_DIR/transient-$ISSUE"

# --- Auswertung -------------------------------------------------------------
if [ $RC -eq 0 ]; then
  rm -f "$TRANSIENT_FILE"

  # Fortschritts-/Fehlschlag-Auswertung fuer die Eskalation (ADR-0007) -- ein
  # sauberer Lauf kann trotzdem "sauber-aber-festhaengend" sein (kein Commit).
  build_escalation_eval

  # Der Lauf war sauber — aber hat Claude bei GENAU DIESEM Ticket eine Frage
  # gestellt? Bewusst NICHT global geprueft (#145): ein woanders schon
  # 'parked' wartendes Ticket darf die Chain-Fortsetzung eines unabhaengigen,
  # sauberen Laufs nicht verhindern -- die alte Pruefung ('waiting_issues()'
  # direkt) fragte den ganzen Bestand statt nur $ISSUE ab.
  POST_LABELS=$(gh issue view "$ISSUE" --json labels -q '.labels[].name' 2>/dev/null | tr '\n' ' ')
  SELF_WAITS=0
  case " $POST_LABELS " in *" needs-input "*) SELF_WAITS=1 ;; esac

  if [ "$SELF_WAITS" -eq 1 ]; then
    park_issue "$ISSUE"
    WAITING=$(waiting_issues)
    status "wartet auf dich ($WAITING)" "🟡" \
      "🟡 **Ich warte auf eine Antwort von dir.**

Offene Fragen an: $WAITING

Antworte als Kommentar am Ticket und **entferne dann das Label \`needs-input\`**.
Betrifft es einen PR mit geschützten Pfaden, setzt du stattdessen \`human-approved\`."
  else
    # Einzige Stelle, die die Chain-Schleife in main() fortsetzt (#61) --
    # sauberer Lauf, keine offene Frage. Jeder andere Zweig in run_round()
    # laesst das eingangs gesetzte CHAIN_STATUS=stop stehen.
    CHAIN_STATUS=continue
    DID_WORK=1
    LAST_ISSUE="$ISSUE"

    SNAP=$(queue_snapshot)
    PENDING=$(queue_pending "$SNAP")
    NEXT=$(queue_next "$SNAP" "${QUEUE_BODY:-}")
    if [ -n "$PENDING" ]; then
      if [ -n "$NEXT" ]; then
        status "wartet auf nächsten Lauf · als Nächstes #$NEXT" "🟢" \
          "🟢 **Ich warte auf den nächsten Lauf — gerade läuft kein Prozess.**

Zuletzt an #$ISSUE gearbeitet. Als Nächstes ist **#$NEXT** dran. Der nächste Takt
startet automatisch (~5 Min) — **kein Eingreifen nötig.**

Offene Queue: $PENDING"
      else
        status "wartet auf nächsten Lauf · Queue: $PENDING" "🟢" \
          "🟢 **Ich warte auf den nächsten Lauf — gerade läuft kein Prozess.**

Zuletzt an #$ISSUE gearbeitet. In der Queue liegt noch Arbeit ($PENDING), aber
derzeit kein baubereites Ticket (z. B. nur Recherche). **Kein Eingreifen nötig.**"
      fi
    else
      status "nichts offen · zuletzt #$ISSUE" "🟢" \
        "🟢 **Nichts offen.** Zuletzt an #$ISSUE gearbeitet, die Queue ist leer.
Kein Eingreifen nötig."
    fi
  fi
  return 0
fi

# Exit-Codes von 'claude -p' sind nicht dokumentiert stabil
# -> auf null/nicht-null prüfen und die Ausgabe lesen.
#
# Zuerst der Statuscode: 429 ist stabil, der Begleitsatz nicht. Genau daran ist
# die alte Erkennung gescheitert — sie kannte "usage limit", aber nicht
# "session limit", und hat ein harmloses Limit als Absturz durchgereicht (roter
# Status, 'needs-input', exit 1). Der Grep bleibt nur noch als Netz.
API_STATUS=$(echo "$OUT" | jq -r '.api_error_status // empty' 2>/dev/null)

if [ "$API_STATUS" = "429" ] \
   || echo "$OUT" | grep -qiE "usage limit|rate limit|session limit|limit reached|quota"; then

  RESULT_TXT=$(echo "$OUT" | jq -r '.result // empty' 2>/dev/null)
  TS=$(reset_epoch "$RESULT_TXT" || true)

  if [ -n "${TS:-}" ]; then
    echo "$TS" > "$LIMIT_UNTIL"
    WHEN=" Nächster Versuch: $(fmt_hm "$TS") Uhr."
  else
    # Nicht deutbar -> 5-Minuten-Takt wie bisher (die Retries kosten im Limit
    # nichts, sie kommen sofort als 429 zurueck). Den Wortlaut aber mitschreiben:
    # so haben wir beim naechsten unbekannten Limit-Text die Vorlage zum Nachschaerfen.
    printf '%s\t%s\n' "$(ts)" "$RESULT_TXT" >> "$STATE_DIR/unparsed-limits.log"
    WHEN=" Nächster Versuch: in ~5 Minuten."
  fi

  gh issue edit "$ISSUE" --add-label blocked-limit >/dev/null
  append_end_reason "$ISSUE" "Session-Limit"
  status "Limit erreicht · #$ISSUE pausiert" "🔵" \
    "🔵 **Limit erreicht.** Ticket #$ISSUE ist angehalten und wird automatisch
fortgesetzt, sobald wieder Kontingent da ist.${WHEN}

**Kein Eingreifen nötig.** Der Arbeitsstand liegt in Git und im Fortschrittskommentar,
nicht in der Session."
  return 0     # kein Fehler — der Timer probiert es einfach wieder
fi

if [ -f "$TIMED_OUT" ]; then
  rm -f "$TIMED_OUT"
  append_end_reason "$ISSUE" "Notbremse ${MAX_RUNTIME}s"
  status "Notbremse bei #$ISSUE" "🔵" \
    "🔵 Lauf an #$ISSUE nach ${MAX_RUNTIME}s abgebrochen (Notbremse gegen hängende Läufe).
Wird beim nächsten Lauf fortgesetzt. **Kein Eingreifen nötig.**"
  return 0
fi

# --- Vorübergehender API-Fehler? ---------------------------------------------
# Weder Limit noch inhaltlicher Fehlschlag am Ticket — ein Hänger mitten in der
# Antwort (5xx, "overloaded", abgebrochene Verbindung, Timeout). Der Arbeitsstand
# liegt in Git und im Fortschrittskommentar; der richtige Umgang ist ein neuer
# Versuch beim nächsten Takt, kein needs-input. Zaehlt bewusst NICHT als
# Eskalations-Fehlversuch (ADR-0007) -- Infrastruktur, kein Inhalt.
RESULT_TXT=$(echo "$OUT" | jq -r '.result // empty' 2>/dev/null)
API_STATUS=$(echo "$OUT" | jq -r '.api_error_status // empty' 2>/dev/null)

IS_TRANSIENT=0
case "$API_STATUS" in
  500|502|503|504|529) IS_TRANSIENT=1 ;;
esac
if [ "$IS_TRANSIENT" -eq 0 ] \
   && printf '%s\n%s' "$OUT" "$RESULT_TXT" \
        | grep -qiE "api error|server error|overloaded|connection error|timed? ?out"; then
  IS_TRANSIENT=1
fi

if [ "$IS_TRANSIENT" -eq 1 ]; then
  COUNT=$(( $(cat "$TRANSIENT_FILE" 2>/dev/null || echo 0) + 1 ))

  if [ "$COUNT" -lt 3 ]; then
    echo "$COUNT" > "$TRANSIENT_FILE"
    status "vorübergehender API-Fehler bei #$ISSUE" "🔵" \
      "🔵 **Vorübergehender API-Fehler bei #$ISSUE** (Versuch $COUNT von 3). Neuer
Versuch beim nächsten Takt. **Kein Eingreifen nötig.** Der Arbeitsstand liegt in
Git und im Fortschrittskommentar, nicht in der Session."
    return 0     # kein Fehler — der Timer probiert es einfach wieder
  fi

  # Drittes Mal in Folge — das ist kein Zufall mehr.
  rm -f "$TRANSIENT_FILE"
  gh issue comment "$ISSUE" --body "🤖 Der Runner ist dreimal in Folge an einem
vorübergehenden API-Fehler gescheitert (zuletzt Exit $RC).
Letzte Zeilen:
\`\`\`
$(error_excerpt)
\`\`\`"
  gh issue edit "$ISSUE" --add-label needs-input >/dev/null
  status "Fehler bei #$ISSUE" "🔴" \
    "🔴 **Fehler bei #$ISSUE.** Dreimal in Folge ein vorübergehender API-Fehler —
das ist kein Zufall mehr.

Die Details stehen als Kommentar am Ticket. Ich fasse #$ISSUE nicht wieder an,
solange das Label \`needs-input\` hängt."
  return 1
fi

# Ein "echter" inhaltlicher Fehlschlag (weder Limit noch Notbremse noch
# Infrastruktur) -- das zaehlt als Eskalations-Fehlversuch (ADR-0007).
build_escalation_eval

gh issue comment "$ISSUE" --body "🤖 Der Runner ist mit einem Fehler abgebrochen (Exit $RC).
Letzte Zeilen:
\`\`\`
$(error_excerpt)
\`\`\`"
gh issue edit "$ISSUE" --add-label needs-input >/dev/null
status "Fehler bei #$ISSUE" "🔴" \
  "🔴 **Fehler bei #$ISSUE.** Der Runner ist abgebrochen (Exit $RC).

Die Details stehen als Kommentar am Ticket. Ich fasse #$ISSUE nicht wieder an,
solange das Label \`needs-input\` hängt."
return 1

}

# Nur ausfuehren, wenn direkt gestartet -- nicht beim Sourcen durch Tests.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
