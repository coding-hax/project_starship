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
# Ab wann ein Slot als stehengeblieben gilt. Der Runner-Takt ist 120s; wer 30
# Minuten lang keinen Zustand geschrieben hat, tickt nicht mehr. Kein Alarm
# ohne die zweite Bedingung: dass dort auch kein Agent läuft (ein Bau-Lauf
# darf 45 Minuten dauern und schreibt währenddessen nichts).
STALE_SLOT_MIN="${STALE_SLOT_MIN:-30}"
# Zeilen, die im Log stehen bleiben. Bei einer Takt-Zeile alle 10 Minuten sind
# 5000 Zeilen gut fünf Wochen -- lang genug für jede Abwesenheit, kurz genug,
# dass die Datei nie jemanden interessieren muss.
LOG_KEEP_LINES="${LOG_KEEP_LINES:-5000}"

AGENT_PATTERN="claude -p --output-format json"

DRY_RUN=0
QUIET=0
STATUS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --quiet)   QUIET=1 ;;
    --status)  STATUS_ONLY=1 ;;
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

# `cmd | grep -q muster` ist unter `set -o pipefail` unbrauchbar: grep steigt
# beim ersten Treffer aus, der Produzent stirbt an SIGPIPE, und pipefail macht
# die Pipeline rot -- obwohl gefunden wurde. Ob das passiert, ist ein Rennen
# gegen die Ausgabelänge, also mal so, mal so.
#
# Am 14.08. hat genau das die Aufsicht bei jedem Lauf melden lassen, keiner der
# drei Slots sei geladen; sie hat alle drei "neu gestartet". Harmlos nur, weil
# `fleet.sh start` idempotent ist. Deshalb: erst einfangen, dann prüfen --
# ohne Pipe, ohne Rennen.
contains() {   # $1 = Heuhaufen, $2 = Nadel
  case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac
}

# `launchctl list` einmal je Lauf, nicht einmal je Slot.
LC_SNAPSHOT=""
launchctl_snapshot() {
  [ -n "$LC_SNAPSHOT" ] && return 0
  LC_SNAPSHOT=$(launchctl list 2>/dev/null || true)
}

# Nach einem Eingriff stimmt die Aufnahme nicht mehr. Die Takt-Zeile soll den
# Zustand am ENDE des Laufs zeigen -- sonst meldet sie "1/3 geladen", nachdem
# sie gerade drei Slots gestartet hat.
launchctl_refresh() {
  LC_SNAPSHOT=""
  launchctl_snapshot
}

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
    launchctl_snapshot
    if contains "$LC_SNAPSHOT" "$label"; then continue; fi
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

# --- 6b. Stehengebliebene Slots ----------------------------------------------
# Jeder Slot schreibt je Takt seinen Zustand nach $STATE_DIR/slots/<n>/state.json
# (fleet.ts). Das Alter dieses Eintrags ist der einzige verlässliche Puls eines
# Slots -- ein geladener launchd-Job sagt nur, dass er starten DÜRFTE.
#
# Zwei Bedingungen, nie eine: Ein Bau-Lauf darf 45 Minuten laufen und schreibt
# in dieser Zeit nichts. Erst „lange still UND kein Agent hier" heißt
# stehengeblieben. Ein Neustart des Slots ist dann verlustfrei, weil der nächste
# Lauf Branch, git log und Fortschrittskommentar liest und dort weitermacht.
#
# Was hier ausdrücklich NICHT passiert: einem offenen Ticket sein `in-progress`
# oder seinen Claim wegnehmen. claimSweep() in scripts/runner/claim.ts lässt das
# bewusst stehen -- „das gäbe es der Flotte weg, obwohl es niemand gelöst hat".
# Diese Aufsicht widerspricht der Entscheidung nicht, sie meldet nur.
slot_age_min() {   # $1 = Slot-Nummer; leer, wenn es keinen Zustand gibt
  local f="$STATE_DIR/slots/$1/state.json" ms now_ms
  [ -f "$f" ] || return 1
  ms=$(sed -n 's/.*"updatedAtMs":\([0-9]*\).*/\1/p' "$f" | tail -1)
  [ -n "$ms" ] || return 1
  now_ms=$(( $(date +%s) * 1000 ))
  printf '%s' $(( (now_ms - ms) / 60000 ))
}

# Läuft unter $1 (Repo-Verzeichnis eines Slots) ein Agent? Über das
# Arbeitsverzeichnis, wie fleet.sh: die Kommandozeile trägt die Slot-Nummer
# nicht, das cwd schon.
agents_under() {
  local dir="$1" pid n=0
  [ -n "$dir" ] || { printf '0'; return; }
  for pid in $(pgrep -f "$AGENT_PATTERN" 2>/dev/null || true); do
    cwds=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null || true)
    contains "$cwds" "n$dir" && n=$(( n + 1 ))
  done
  printf '%s' "$n"
}

check_stuck_slots() {
  local label n age repo agents
  for label in $(slot_labels); do
    n="${label##*slot-}"
    age=$(slot_age_min "$n") || { log "Slot $n hat noch keinen Zustand geschrieben."; continue; }
    [ "$age" -ge "$STALE_SLOT_MIN" ] || continue

    repo=$(repo_dir_of "$label")
    agents=$(agents_under "$repo")
    if [ "$agents" -gt 0 ]; then
      log "Slot $n still seit ${age} Min., aber $agents Agent(en) laufen dort — das ist ein Bau-Lauf, kein Stillstand."
      continue
    fi

    if ! trip_mode; then
      alarm "Slot $n tickt seit ${age} Minuten nicht und hat keinen laufenden Agenten (kein Reise-Modus, also nicht neu gestartet)"
      continue
    fi
    if act "$FLEET_SH" stop "$n" >/dev/null 2>&1 && act "$FLEET_SH" start "$n" >/dev/null 2>&1; then
      heal "Slot $n stand seit ${age} Min. ohne Agenten — neu gestartet (Arbeitsstand bleibt: Branch und Fortschrittskommentar tragen ihn)"
    else
      alarm "Slot $n steht seit ${age} Minuten und ließ sich nicht neu starten"
    fi
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
  local ac_sleep
  ac_sleep=$(pmset -g custom 2>/dev/null | sed -n '/AC Power/,$p' \
    | sed -n 's/^ sleep  *\([0-9][0-9]*\).*/\1/p' | head -1)
  if trip_mode && [ -n "$ac_sleep" ] && [ "$ac_sleep" -ne 0 ] 2>/dev/null; then
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
# `gh` bestimmt das Repository sonst aus dem Arbeitsverzeichnis -- unter launchd
# ist das `/`, und jeder Aufruf scheitert stumm. Genau daran ging der erste
# echte Bericht verloren ("Bericht konnte nicht ans Issue #1 geschrieben
# werden", 14.08.). Deshalb trägt jeder gh-Aufruf hier sein --repo selbst.
repo_slug() {
  [ -n "${REPO_SLUG:-}" ] && { printf '%s' "$REPO_SLUG"; return 0; }
  local url
  url=$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null) || return 1
  printf '%s' "$url" | sed -E 's#^(git@|ssh://git@|https://)github\.com[:/]##; s#\.git$##'
}

report() {
  [ "${#HEALED[@]}" -eq 0 ] && [ "${#ALARMS[@]}" -eq 0 ] && return 0
  command -v gh >/dev/null 2>&1 || return 0

  local slug
  slug=$(repo_slug) || { log "Repository nicht bestimmbar — Bericht bleibt im Log."; return 0; }

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

  act gh issue comment "$STATUS_ISSUE" --repo "$slug" --body "$body" >/dev/null 2>&1 \
    || log "Bericht konnte nicht ans Issue #$STATUS_ISSUE geschrieben werden."
}

# --- Takt-Zeile --------------------------------------------------------------
# Eine Zeile je Lauf, immer -- auch wenn nichts zu tun war. Ohne sie sieht ein
# gesunder Lauf exakt aus wie eine tote Aufsicht: kein Eintrag, keine Meldung.
# Genau dieser blinde Fleck ist der Grund, warum es den Totmann-Schalter für die
# Flotte gibt; die Aufsicht darf ihn nicht selbst wieder aufmachen.
#
# Bewusst EINE greppbare Zeile statt eines Berichts: `tail -f` soll lesbar
# bleiben, und über zwei Wochen sind das ~2000 Zeilen.
heartbeat_line() {
  local label n loaded=0 total=0 ages="" age agents=0 pid
  launchctl_refresh
  for label in $(slot_labels); do
    total=$(( total + 1 ))
    contains "$LC_SNAPSHOT" "$label" && loaded=$(( loaded + 1 ))
    n="${label##*slot-}"
    age=$(slot_age_min "$n") || age="?"
    ages="$ages${ages:+,}$n:${age}m"
  done
  for pid in $(pgrep -f "$AGENT_PATTERN" 2>/dev/null || true); do
    agents=$(( agents + 1 ))
  done

  printf '%s  TAKT slots=%d/%d agenten=%d alter=[%s] reise=%s geheilt=%d alarme=%d\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$loaded" "$total" "$agents" "$ages" \
    "$(trip_mode && echo ja || echo nein)" "${#HEALED[@]}" "${#ALARMS[@]}" \
    >> "$LOG" 2>/dev/null || true
}

# Das Log darf über eine lange Abwesenheit nicht unbegrenzt wachsen. Gekürzt
# wird über eine temporäre Datei und `mv` -- ein `> "$LOG"` mitten im Lauf
# verlöre die Zeilen, die parallel geschrieben werden.
trim_log() {
  local lines tmp
  [ -f "$LOG" ] || return 0
  lines=$(wc -l < "$LOG" 2>/dev/null | tr -d ' ')
  case "$lines" in ''|*[!0-9]*) return 0 ;; esac
  [ "$lines" -gt "$LOG_KEEP_LINES" ] || return 0
  tmp="$LOG.trim.$$"
  tail -n "$LOG_KEEP_LINES" "$LOG" > "$tmp" 2>/dev/null && mv "$tmp" "$LOG" 2>/dev/null
  rm -f "$tmp" 2>/dev/null || true
}

# --- Lagebild auf Zuruf ------------------------------------------------------
# Für den Menschen am Rechner: was die Aufsicht gerade sieht, ohne dass sie
# etwas anfasst. Verändert nichts, meldet nichts ans Issue.
print_status() {
  local label n age repo agents core
  launchctl_snapshot
  echo "Aufsicht — Lagebild $(date '+%d.%m. %H:%M')"
  echo
  echo "Reise-Modus:  $(trip_mode && echo "aktiv ($TRIP_FILE)" || echo 'aus — kein Slot wird nach einem Neustart gestartet')"
  if [ -x "$REPO_DIR/node_modules/.bin/tsx" ] \
     && "$REPO_DIR/node_modules/.bin/tsx" "$REPO_DIR/scripts/runner/cli.ts" \
        fleet-status 1 1 1 >/dev/null 2>&1; then core="benutzbar"; else core="ROT"; fi
  echo "Runner-Kern:  $core"
  echo
  printf '%-6s %-9s %-8s %-8s %s\n' "Slot" "launchd" "Puls" "Agenten" "Repo"
  for label in $(slot_labels); do
    n="${label##*slot-}"
    age=$(slot_age_min "$n") || age="?"
    repo=$(repo_dir_of "$label")
    agents=$(agents_under "$repo")
    printf '%-6s %-9s %-8s %-8s %s\n' "$n" \
      "$(contains "$LC_SNAPSHOT" "$label" && echo geladen || echo FEHLT)" \
      "${age}m" "$agents" "${repo:-?}"
  done
  echo
  echo "Letzte Einträge:"
  tail -n 8 "$LOG" 2>/dev/null | sed 's/^/  /' || echo "  (noch keine)"
}

main() {
  mkdir -p "$STATE_DIR" 2>/dev/null || true

  if [ "$STATUS_ONLY" -eq 1 ]; then
    print_status
    return 0
  fi

  check_slots_loaded
  check_wedged_agents
  check_stale_locks
  check_node_modules
  check_dirty_index
  check_worktrees
  check_stuck_slots
  check_runner_core
  check_environment

  # Erst die Takt-Zeile, dann der Bericht: Die Zeile zählt, was dieser Lauf
  # gefunden hat, und muss auch dann im Log stehen, wenn der Bericht ans Issue
  # scheitert (kein Netz, gh nicht angemeldet).
  heartbeat_line
  trim_log
  report

  [ "${#ALARMS[@]}" -eq 0 ]
}

# Source-Guard: Tests dürfen die Funktionen einzeln prüfen, ohne einen Lauf
# auszulösen (gleiche Bauart wie claude-runner.sh).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main
fi
