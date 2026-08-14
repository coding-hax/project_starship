#!/usr/bin/env bash
# Aufsicht über die Runner-Flotte — für den unbeaufsichtigten Betrieb.
#
# Warum es diese Datei gibt:
# Der Runner heilt Tickets, aber niemand heilt den Runner. Jede Störung in der
# Liste unten hat die Flotte schon einmal stillgelegt, und jedes Mal hat ein
# Mensch sie von Hand wieder angeworfen. Ist dieser Mensch zwei Wochen
# unterwegs, steht die Flotte zwei Wochen.
#
# Was diese Datei ausdrücklich NICHT ist: ein Agent. Sie ruft kein `claude`,
# schreibt keinen Code und fasst nichts unter src/ an. Ihr Repertoire ist eine
# feste, endliche Liste bekannter Störungen mit je einem bekannten Handgriff.
# Genau deshalb darf sie das, was der Flotte verwehrt ist — beim Login
# automatisch starten (siehe REISE-MODUS).
#
# REISE-MODUS
# Die Slot-Plists liegen bewusst NICHT in ~/Library/LaunchAgents (fleet.sh,
# Vorfall 10.08.26: nach einem Neustart lief eine Agentenflotte, die niemand
# gestartet hatte). Diese Garantie bleibt unangetastet. Stattdessen wird DIESE
# Datei nach LaunchAgents gehängt, und sie startet die Flotte nur, solange
# $STATE_DIR/trip-mode existiert. Das Anlegen dieser Datei ist die bewusste
# Handlung, die früher das `fleet.sh start` war — sie überlebt nur zusätzlich
# den Neustart. Ohne sie meldet die Aufsicht nur und startet nie.
#
#   Aufruf:  scripts/runner-supervisor.sh [--dry-run] [--quiet]
set -uo pipefail

STATE_DIR="${SUPERVISOR_STATE_DIR:-$HOME/.starship-runner}"
REPO_DIR="${REPO_DIR:-$HOME/dev/project_starship}"
FLEET_SH="${FLEET_SH:-$STATE_DIR/fleet.sh}"
PLIST_DIR="${PLIST_DIR:-$STATE_DIR/launchd}"
STATUS_ISSUE="${STATUS_ISSUE:-1}"
TRIP_FILE="$STATE_DIR/trip-mode"
LOG="$STATE_DIR/supervisor.log"
PREFIX="de.starship.runner"

# Ein Bau-Lauf hat ein 45-Minuten-Fenster (CLAUDE.md, Regel 5). Doppelt plus
# Reserve: was so lange lebt, hängt und belegt einen Bauplatz für nichts.
MAX_AGENT_MIN="${MAX_AGENT_MIN:-95}"
# Freier Plattenplatz in GB, unter dem gemeldet wird. Ein volllaufendes
# Dateisystem killt pnpm, Playwright und Postgres gleichzeitig.
MIN_DISK_GB="${MIN_DISK_GB:-10}"
# So oft darf der TS-Kern hintereinander unbenutzbar sein, bevor die Aufsicht
# die Flotte anhält statt sie weiterlaufen zu lassen.
MAX_CORE_FAILS="${MAX_CORE_FAILS:-3}"

AGENT_PATTERN="claude -p --output-format json"

DRY_RUN=0
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --quiet)   QUIET=1 ;;
    *) echo "unbekanntes Argument: $arg" >&2; exit 2 ;;
  esac
done

# Was geheilt wurde (kommt in den Bericht) und was nicht heilbar ist (weckt
# den Menschen). Bewusst getrennt: Geheiltes ist Rauschen, Unheilbares nicht.
HEALED=()
ALARMS=()

heal() { HEALED+=("$1"); log "GEHEILT: $1"; }
alarm() { ALARMS+=("$1"); log "ALARM:   $1"; }
log() {
  printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG" 2>/dev/null || true
  [ "$QUIET" -eq 1 ] || printf '%s\n' "$1"
}

# Jeder verändernde Handgriff läuft hier durch — im Trockenlauf passiert
# nichts, gemeldet wird trotzdem. Das macht die Suite testbar, ohne dass sie
# eine echte Flotte braucht.
act() {
  if [ "$DRY_RUN" -eq 1 ]; then log "(trocken) würde: $*"; return 0; fi
  "$@"
}

trip_mode() { [ -f "$TRIP_FILE" ]; }

slot_labels() {
  find "$PLIST_DIR" -maxdepth 1 -name "$PREFIX.slot-*.plist" \
    -exec basename {} .plist \; 2>/dev/null | sort
}

repo_dir_of() {
  plutil -extract EnvironmentVariables.REPO_DIR raw -o - \
    "$PLIST_DIR/$1.plist" 2>/dev/null || true
}

# --- 1. Slots geladen? -------------------------------------------------------
# Nach einem Neustart ist die Flotte weg: launchd lädt nur ~/Library/
# LaunchAgents automatisch, und dort liegen die Slot-Plists mit Absicht nicht.
check_slots_loaded() {
  local label missing=0
  for label in $(slot_labels); do
    if launchctl list 2>/dev/null | grep -q "$label"; then continue; fi
    missing=1
    if ! trip_mode; then
      log "Slot $label nicht geladen — kein Reise-Modus, also nicht gestartet."
      continue
    fi
    local n="${label##*slot-}"
    if act "$FLEET_SH" start "$n" >/dev/null 2>&1; then
      heal "$label war nicht geladen, per fleet.sh gestartet"
    else
      alarm "$label ist nicht geladen und ließ sich nicht starten"
    fi
  done
  return $missing
}

# --- 2. Hängende und verwaiste Agenten ---------------------------------------
# `bootout` beendet die Runner-Shell, aber nicht den `claude -p` darunter — der
# hängt sich an PID 1 und startet seine Kinder munter weiter (fleet.sh). Ein
# solcher Waise schreibt in Worktrees, während der Slot glaubt, frei zu sein.
# macOS-`ps` kennt kein `etimes` (das ist procps/Linux), nur das formatierte
# `etime`: "MM:SS", "HH:MM:SS" oder "DD-HH:MM:SS". Diese Umrechnung ist der
# Grund, warum die Suite ihren ps-Stub im macOS-Format antworten lässt -- ein
# Stub, der `etimes` akzeptiert, macht den Test grün und die Aufsicht blind.
etime_minutes() {
  local e="$1" days=0 rest h=0 m=0
  case "$e" in
    *-*) days="${e%%-*}"; rest="${e#*-}" ;;
    *)   rest="$e" ;;
  esac
  local IFS=:
  set -- $rest
  case "$#" in
    3) h="$1"; m="$2" ;;
    2) h=0;    m="$1" ;;
    *) return 1 ;;
  esac
  # 10# gegen die Oktal-Falle: "08" und "09" wären sonst ungültige Zahlen.
  printf '%s' $(( days * 1440 + 10#$h * 60 + 10#$m ))
}

check_wedged_agents() {
  local pid etime mins ppid
  for pid in $(pgrep -f "$AGENT_PATTERN" 2>/dev/null || true); do
    etime=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    [ -n "$etime" ] || continue
    mins=$(etime_minutes "$etime") || continue

    if [ "${ppid:-0}" = "1" ]; then
      act kill -9 "$pid" 2>/dev/null
      heal "verwaister Agent $pid (an PID 1, seit ${mins} Min.) beendet"
      continue
    fi
    if [ "$mins" -ge "$MAX_AGENT_MIN" ]; then
      act kill -9 "$pid" 2>/dev/null
      heal "hängender Agent $pid (seit ${mins} Min., Grenze ${MAX_AGENT_MIN}) beendet"
    fi
  done
}

# --- 3. Verwaiste Run-Locks --------------------------------------------------
# Der Lock hält die PID im Klartext (claude-runner.sh, acquire_run_lock). Stirbt
# eine Sitzung hart, bleibt er liegen — und `status` meldet trotzdem grün,
# während der Slot bei jedem Tick sofort wieder aussteigt.
check_stale_locks() {
  local lock owner
  for lock in "$STATE_DIR"/lock "$STATE_DIR"/*/lock; do
    [ -f "$lock" ] || continue
    owner=$(cat "$lock" 2>/dev/null | tr -d ' ')
    case "$owner" in
      ''|*[!0-9]*) act rm -f "$lock"; heal "Lock $lock ohne gültige PID entfernt"; continue ;;
    esac
    if kill -0 "$owner" 2>/dev/null; then continue; fi
    act rm -f "$lock"
    heal "verwaister Lock $lock (tote PID $owner) entfernt"
  done
}

# --- 4. Tote node_modules-Verweise -------------------------------------------
# `git worktree remove` lässt die Top-Level-Links im Haupt-Checkout tot zurück,
# wenn dort je ein Install mit cwd im Worktree lief (#606). Der Runner feuert
# danach weiter und stirbt in derselben Sekunde; sichtbar nur in err.log.
check_node_modules() {
  local repo link broken
  for repo in $(all_repos); do
    [ -d "$repo/node_modules" ] || continue
    broken=0
    for link in "$repo"/node_modules/.bin/*; do
      [ -e "$link" ] && continue
      [ -L "$link" ] || continue
      broken=1; break
    done
    [ "$broken" -eq 1 ] || continue
    # Install NUR mit --dir auf den Checkout selbst -- nie mit cwd darin,
    # sonst entsteht genau der Schaden neu, der hier repariert wird.
    if act pnpm install --dir "$repo" >/dev/null 2>&1; then
      heal "tote node_modules-Links in $repo per pnpm install repariert"
    else
      alarm "tote node_modules-Links in $repo — pnpm install schlug fehl"
    fi
  done
}

# --- 5. Dreckiger Index ------------------------------------------------------
# Ein liegen gebliebener Index ist eine geladene Waffe (CLAUDE.md): er überlebt
# `checkout -- .` und `clean -fd` und macht beim nächsten Commit stillschweigend
# gemergte Arbeit rückgängig. Ein Catch-up-Merge hinterlässt ihn invertiert.
# Nur der Index wird geleert -- Arbeitsbaum und Dateien bleiben unangetastet.
check_dirty_index() {
  local dir
  for dir in $(all_repos) $(all_worktrees); do
    [ -d "$dir" ] || continue
    git -C "$dir" diff --cached --quiet 2>/dev/null && continue
    act git -C "$dir" reset -q 2>/dev/null
    heal "gestagte Änderungen in $dir aus dem Index genommen"
  done
}

# --- 6. Verwaiste Worktree-Einträge ------------------------------------------
check_worktrees() {
  local repo
  for repo in $(all_repos); do
    git -C "$repo" worktree prune 2>/dev/null || true
  done
}

# --- 7. Ist der Runner-Kern überhaupt noch benutzbar? ------------------------
# Der Bremsklotz gegen den einzigen Schaden, den die Aufsicht nicht reparieren
# kann: ein Lauf, der scripts/runner/ kaputt gemacht hat. Drei Slots würden
# sonst zwei Wochen lang Kontingent gegen einen toten Kern verfeuern. Also:
# anhalten und melden, nicht weiterlaufen lassen.
check_runner_core() {
  local fails_file="$STATE_DIR/supervisor-core-fails" fails=0
  fails=$(cat "$fails_file" 2>/dev/null | tr -d ' ')
  case "$fails" in ''|*[!0-9]*) fails=0 ;; esac

  if [ -x "$REPO_DIR/node_modules/.bin/tsx" ] \
     && "$REPO_DIR/node_modules/.bin/tsx" "$REPO_DIR/scripts/runner/cli.ts" \
        fleet-status 1 1 1 >/dev/null 2>&1; then
    [ "$fails" -gt 0 ] && act rm -f "$fails_file"
    return 0
  fi

  fails=$(( fails + 1 ))
  act sh -c "printf '%s' '$fails' > '$fails_file'"
  if [ "$fails" -ge "$MAX_CORE_FAILS" ]; then
    act "$FLEET_SH" stop >/dev/null 2>&1
    alarm "Runner-Kern seit $fails Läufen unbenutzbar — Flotte angehalten. Kein Bau-Lauf mehr, bis das behoben ist."
  else
    log "Runner-Kern nicht ausführbar ($fails/$MAX_CORE_FAILS) — noch kein Anhalten."
  fi
}

# --- 8. Umgebung -------------------------------------------------------------
check_environment() {
  local free
  free=$(df -g "$REPO_DIR" 2>/dev/null | awk 'NR==2 {print $4}')
  if [ -n "$free" ] && [ "$free" -lt "$MIN_DISK_GB" ] 2>/dev/null; then
    alarm "nur noch ${free} GB frei auf der Platte (Grenze ${MIN_DISK_GB})"
  fi
  if command -v pg_isready >/dev/null 2>&1; then
    pg_isready -q -h localhost -p 5432 2>/dev/null \
      || alarm "Postgres auf localhost:5432 antwortet nicht — jeder E2E-Lauf scheitert"
  fi
  # Schläft der Mac, tickt StartInterval nur beim Aufwachen. Im Reise-Modus ist
  # das der Unterschied zwischen einer arbeitenden und einer toten Flotte.
  if trip_mode && pmset -g custom 2>/dev/null \
       | sed -n '/AC Power/,$p' | grep -qE '^ sleep +[1-9]'; then
    alarm "Reise-Modus, aber der Mac schläft am Netzteil ein (pmset sleep != 0) — die Flotte tickt dann nur sporadisch"
  fi
}

all_repos() {
  local label d seen=""
  echo "$REPO_DIR"
  for label in $(slot_labels); do
    d=$(repo_dir_of "$label")
    [ -n "$d" ] && [ "$d" != "$REPO_DIR" ] && echo "$d"
  done
}

all_worktrees() {
  local repo
  for repo in $(all_repos); do
    git -C "$repo" worktree list --porcelain 2>/dev/null \
      | awk '/^worktree /{print $2}'
  done
}

# --- Bericht -----------------------------------------------------------------
# Zwei Wochen Rauschen liest niemand. Gemeldet wird nur, was jemanden angeht:
# ein Alarm immer, geheilte Störungen gesammelt. Ein stiller Lauf schreibt
# ausschließlich ins Log.
report() {
  [ "${#HEALED[@]}" -eq 0 ] && [ "${#ALARMS[@]}" -eq 0 ] && return 0
  command -v gh >/dev/null 2>&1 || return 0

  local body="" item
  if [ "${#ALARMS[@]}" -gt 0 ]; then
    body="🚨 **Aufsicht — Eingriff nötig**"$'\n\n'
    for item in "${ALARMS[@]}"; do body="$body- $item"$'\n'; done
    body="$body"$'\n'
  else
    body="🔧 **Aufsicht — selbst behoben**"$'\n\n'
  fi
  if [ "${#HEALED[@]}" -gt 0 ]; then
    body="${body}Selbst behoben:"$'\n'
    for item in "${HEALED[@]}"; do body="$body- $item"$'\n'; done
    body="$body"$'\n'
  fi
  body="${body}_$(date '+%d.%m. %H:%M') · $(hostname -s)_"

  act gh issue comment "$STATUS_ISSUE" --body "$body" >/dev/null 2>&1 \
    || log "Bericht konnte nicht ans Issue #$STATUS_ISSUE geschrieben werden."
}

main() {
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  trip_mode && log "Reise-Modus aktiv ($TRIP_FILE)"

  check_slots_loaded
  check_wedged_agents
  check_stale_locks
  check_node_modules
  check_dirty_index
  check_worktrees
  check_runner_core
  check_environment
  report

  [ "${#ALARMS[@]}" -eq 0 ]
}

# Source-Guard: Tests dürfen die Funktionen einzeln prüfen, ohne einen Lauf
# auszulösen (gleiche Bauart wie claude-runner.sh).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main
fi
