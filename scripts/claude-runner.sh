#!/usr/bin/env bash
# Claude-Runner: pollt GitHub Issues, arbeitet EIN Ticket, überlebt Limits.
# Läuft per launchd (macOS) oder systemd (Linux) alle 5 Minuten.
#
# Braucht: gh, jq und die EIGENSTÄNDIGE claude-CLI im PATH (die
# VS-Code-Erweiterung zählt nicht -- sie legt `claude` nicht in den PATH).
#
# Seit S6 (#203, letzte Stufe von #184) nur noch Einstiegspunkt: die
# Entscheidungslogik liegt in scripts/runner/*.ts und wird über ts_run()
# gerufen. In Bash bleibt nur, was in Node ein Rückschritt wäre -- Lock,
# Limit-Gate, Chain-Schleife, run_limited, `claude`-Aufruf. Begründung je
# Stück: docs/CODEMAP.md, Abschnitt claude-runner.sh.
set -uo pipefail

# Wurzel des Checkouts, aus dem der Runner GESTARTET wurde -- getrennt von
# $REPO_DIR (dem Arbeitsbaum, an dem gebaut wird): der Shim holt dieses Skript
# aus origin/main, cli.ts muss aus demselben Stand kommen. Ein vorab
# exportierter Wert gewinnt (Testfixture), analog STATE_DIR unten.
RUNNER_HOME="${RUNNER_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

REPO_DIR="${REPO_DIR:-$HOME/dev/project_starship}"
STATUS_ISSUE="${STATUS_ISSUE:-0}"       # Nr. des angepinnten Runner-Status-Issues
QUEUE_ISSUE="${QUEUE_ISSUE:-0}"         # Nr. des Prioritäts-Queue-Issues (0 = aus)
MAX_RUNTIME="${MAX_RUNTIME:-2700}"      # Sekunden. Notbremse gegen hängende Läufe -- PRO LAUF.
MAX_ROUNDS="${MAX_ROUNDS:-3}"           # Ticket-Chaining (#61): max. Runden PRO TICK.
TICK_BUDGET="${TICK_BUDGET:-$MAX_RUNTIME}"  # Sek.-Budget/Tick, vor jeder neuen Runde geprüft.
# #331: solange der `claude`-Aufruf laeuft (bis zu MAX_RUNTIME), veroeffentlicht
# der Leitslot die Flottenanzeige trotzdem im Hintergrund weiter, statt erst
# nach Rundenende -- siehe start_fleet_publisher() unten.
FLEET_PUBLISH_INTERVAL="${FLEET_PUBLISH_INTERVAL:-300}"
# Ein vorab exportiertes STATE_DIR (Testfixture) gewinnt -- und wird selbst
# exportiert, damit der tsx-Kindprozess dasselbe Verzeichnis sieht.
STATE_DIR="${STATE_DIR:-$REPO_DIR/.runner}"
export STATE_DIR

# --- Mehrere Slots (#204) -----------------------------------------------------
# Ein Slot = eine launchd-Instanz + ein eigener Arbeitsbaum (eigener Clone,
# siehe scripts/launchd-setup.md) + ein eigenes .runner/ -- Letzteres ist durch
# STATE_DIR unter REPO_DIR schon erledigt, zwei Arbeitsbäume heißt automatisch
# zwei .runner/. SLOT_ID ist die einzige slotspezifische Variable hier;
# REPO_DIR/STATUS_ISSUE kommen bewusst aus der jeweiligen plist, NICHT aus
# SLOT_ID abgeleitet -- nur so bleibt SLOT_ID=1 verhaltensgleich zu vor #204
# (AK9). SHARED_DIR liegt AUSSERHALB jedes Arbeitsbaums: was dort liegt
# (Claims, Herzschlag, limit-until) muss slotübergreifend gelten.
SLOT_ID="${SLOT_ID:-1}"
SLOT_COUNT="${SLOT_COUNT:-1}"
LEAD_SLOT="${LEAD_SLOT:-1}"
SHARED_DIR="${SHARED_DIR:-$HOME/.starship-runner}"
export SLOT_ID SLOT_COUNT LEAD_SLOT SHARED_DIR
# Nur ein Startwert (z. B. fuer Bash-Suiten, die run_round() ueberspringen).
# run_round() bestimmt IS_LEAD/EFF_LEAD ab E5 JEDE Runde neu ueber
# fleet-effective-lead -- faellt der konfigurierte LEAD_SLOT aus (kein
# frischer Herzschlag mehr), uebernimmt automatisch der niedrigste lebende
# Slot (AK5).
IS_LEAD=0; [ "$SLOT_ID" = "$LEAD_SLOT" ] && IS_LEAD=1
EFF_LEAD="$LEAD_SLOT"
export IS_LEAD EFF_LEAD

# Deckel gegen Vertipper (AK8): keine Zahl oder außerhalb 1-10 bricht sofort
# ab, bevor auch nur ein gh/tsx-Aufruf passiert.
case "$SLOT_COUNT" in
  ''|*[!0-9]*)
    echo "SLOT_COUNT muss eine positive Zahl sein, ist aber '$SLOT_COUNT'." >&2
    exit 1
    ;;
esac
if [ "$SLOT_COUNT" -lt 1 ] || [ "$SLOT_COUNT" -gt 10 ]; then
  echo "SLOT_COUNT=$SLOT_COUNT außerhalb des erlaubten Bereichs 1-10 (Deckel gegen Vertipper)." >&2
  exit 1
fi

# Wurzel aller Ticket-Worktrees (#242) -- gitignored seit #226. Ein Bau-Lauf
# bekommt darin sein eigenes Verzeichnis, statt im Haupt-Checkout zu bauen.
WORKTREE_BASE="${WORKTREE_BASE:-$REPO_DIR/.claude/worktrees}"
# Liegt bewusst unter SHARED_DIR, nicht STATE_DIR: sonst rennt Slot 2 weiter in
# 429er, während Slot 1 schon korrekt pausiert hat (das Kontingent ist EINS,
# nicht pro Slot). Geschrieben wird sie vom TS-Kern über ctx.sharedState
# (roundEval, einzige Schreibstelle: der 429-Zweig) -- beide Seiten müssen
# gemeinsam auf SHARED_DIR zeigen, sonst liest das Gate hier eine Datei, die
# nie jemand schreibt, und kein Slot pausiert mehr.
LIMIT_UNTIL="$SHARED_DIR/limit-until"   # Unix-Zeit, bis zu der das Kontingent leer ist
LOG="$STATE_DIR/last-run.log"           # stdout+stderr des letzten claude-Laufs
TIMED_OUT="$STATE_DIR/timed-out"        # Marker der Notbremse, siehe run_limited()
ROUND_FILE="$STATE_DIR/round.json"      # Plan der laufenden Runde, Übergabe an round-eval

cd "$REPO_DIR" || { echo "REPO_DIR nicht gefunden: $REPO_DIR" >&2; exit 1; }
mkdir -p "$STATE_DIR" "$SHARED_DIR/claims" "$SHARED_DIR/slots"

for tool in gh jq claude; do
  command -v "$tool" >/dev/null 2>&1 || { echo "'$tool' fehlt im PATH." >&2; exit 1; }
done

# Unix-Zeit -> "Mo 14:51"; BSD und GNU sprechen verschiedene Dialekte, daher
# beide Varianten. Bleibt in Bash: einziger Aufrufer ist das Limit-Gate, und
# das muss ohne tsx-Start auskommen.
fmt_hm() { date -r "$1" "+%a %H:%M" 2>/dev/null || date -d "@$1" "+%a %H:%M" 2>/dev/null; }

# Status-Issue per EDIT aktualisieren, nicht per Kommentar -- sonst gibt es bei
# jedem Lauf eine Push-Nachricht aufs Handy. Die Ampel steht im TITEL, weil in
# der Issue-Liste sonst nur das statische Symbol sichtbar wäre. Was die
# einzelnen Farben bedeuten: docs/CODEMAP.md, Abschnitt claude-runner.sh.
#
# Nur bei inhaltlicher Änderung schreiben (#64): sha1 über Titel+Emoji+Text,
# ausdrücklich OHNE den "_Stand:_"-Zeitstempel unten, sonst wäre der Hash immer
# verschieden. Schlägt gh fehl, bleibt die Datei leer und der nächste Aufruf
# versucht es erneut. Die Texte baut seit S6 der TS-Kern (round.ts).
STATUS_HASH_FILE="$STATE_DIR/status-hash"
status() {   # $1 = Titelzeile (ohne Emoji), $2 = Emoji, $3 = Text
  [ "$STATUS_ISSUE" -gt 0 ] 2>/dev/null || return 0
  local sig
  sig=$(printf '%s' "$2 Runner · $1"$'\x1e'"$3" \
          | { shasum -a 1 2>/dev/null || sha1sum 2>/dev/null; } | cut -d' ' -f1)
  [ "$(cat "$STATUS_HASH_FILE" 2>/dev/null)" = "$sig" ] && return 0
  gh issue edit "$STATUS_ISSUE" \
    --title "$2 Runner · $1" \
    --body "$3

_Stand: $(date "+%d.%m. %H:%M")_" >/dev/null 2>&1 && printf '%s' "$sig" > "$STATUS_HASH_FILE"
}

# --- Naht zu TypeScript ------------------------------------------------------
# Einzige Brücke zum TS-Kern. Vertrag: stdout und Exit-Code kommen exakt von
# cli.ts durch, nichts wird hier umgedeutet. Aufgelöst über $RUNNER_HOME (siehe
# oben). Ein fehlendes `tsx` (Exit 127) ist seit S6 ein harter Fehler -- es gibt
# keinen Bash-Pfad mehr -- und geht über status() aufs Handy.
ts_run() {   # $1 = Kommando, Rest = Argumente -> stdout/Exit-Code wie cli.ts
  local cmd="$1"
  local out rc
  out=$("$RUNNER_HOME/node_modules/.bin/tsx" "$RUNNER_HOME/scripts/runner/cli.ts" "$@")
  rc=$?
  if [ "$rc" -eq 127 ]; then
    status "TS-Kern ausgefallen" "🔴" \
      "🔴 \`tsx\` fehlt oder \`node_modules\` ist kaputt -- Kommando \`$cmd\` konnte nicht laufen.

Der Runner kann ohne den TS-Kern nichts entscheiden. Bitte im Arbeitsbaum des
Runners \`pnpm install\` ausführen."
    return 127
  fi
  printf '%s' "$out"
  return "$rc"
}

# Traegt den von round.ts gebauten Status in den EIGENEN Slot-Zustand ein
# (#204, E5) -- IMMER, auch ohne inhaltliche Aenderung: sonst haelt fleet.ts
# diesen Slot faelschlich fuer ausgefallen, sobald er lange genug nichts
# Neues zu melden hat (z. B. "CI laeuft noch" ueber mehrere Runden). NUR der
# EFFEKTIVE Leitslot ($EFF_LEAD, von run_round() vor dieser Runde bestimmt)
# aggregiert danach ALLE Slot-Zustaende zu EINEM StatusUpdate und schreibt es
# ans Status-Issue -- alles andere ueberschriebe sich zwischen den Slots
# abwechselnd.
apply_status() {   # $1 = JSON mit optionalem .status
  local s agg
  s=$(printf '%s' "$1" | jq -c '.status // empty' 2>/dev/null)
  if [ -z "$s" ] || [ "$s" = "null" ]; then
    ts_run fleet-write-state "$SLOT_ID" >/dev/null
  else
    ts_run fleet-write-state "$SLOT_ID" \
      "$(printf '%s' "$s" | jq -r '.emoji')" \
      "$(printf '%s' "$s" | jq -r '.title')" \
      "$(printf '%s' "$s" | jq -r '.text')" >/dev/null
  fi

  # #488 (F14): frische Pruefung statt des bei Rundenbeginn festgehaltenen
  # IS_LEAD -- der Hintergrund-Publisher (start_fleet_publisher) ruft
  # apply_status() bis zu FLEET_PUBLISH_INTERVAL lang erneut auf, waehrend
  # die Fuehrung laengst gewechselt haben kann (AK3). Der Keep-alive-`renew`
  # in fleet-verify-lead haelt die Lease waehrend eines laufenden Bau-Laufs
  # frisch, solange dieser Slot sie noch haelt.
  ts_run fleet-verify-lead >/dev/null 2>&1 || return 0
  agg=$(ts_run fleet-status "$SLOT_COUNT" "$LEAD_SLOT" "$EFF_LEAD")
  [ -z "$agg" ] || [ "$agg" = "null" ] && return 0
  status "$(printf '%s' "$agg" | jq -r '.title')" \
         "$(printf '%s' "$agg" | jq -r '.emoji')" \
         "$(printf '%s' "$agg" | jq -r '.text')"
}

# #331: Die Ampel oben friert ein, solange der Leitslot in einem langen
# `claude`-Aufruf (bis zu MAX_RUNTIME, planend gern deutlich laenger als ein
# Bau-Lauf) steckt -- apply_status() liefe erst nach dessen Rueckkehr wieder.
# Waehrenddessen schreiben andere Slots ihren Zustand trotzdem unbeirrt
# weiter (siehe apply_status()); nur ihn zu veroeffentlichen fehlte. Deshalb
# laesst NUR der Leitslot (IS_LEAD) waehrend des `claude`-Aufrufs einen
# Hintergrund-Takt mitlaufen, der denselben apply_status() periodisch erneut
# aufruft -- EIN Schreiber bleibt es trotzdem (AK4 aus #331): der
# Vordergrund-Prozess ruft apply_status() erst nach dem Beenden dieses Takts
# wieder selbst auf (stop_fleet_publisher() toetet und wartet ihn ab, siehe
# unten), nie gleichzeitig. FLEET_PUB_PID ist bewusst eine globale Variable
# statt eines Rueckgabewerts per `$(...)`: Letzteres forkt eine eigene
# Subshell fuers Erfassen von `$!`, und der darin gestartete Hintergrundjob
# waere ausserhalb dieser Funktion nicht mehr sauber greifbar -- derselbe
# Grund, warum run_limited() sein `cmd_pid` direkt (ohne Command-Substitution)
# erfasst.
FLEET_PUB_PID=""
start_fleet_publisher() {
  FLEET_PUB_PID=""
  [ "$IS_LEAD" -eq 1 ] || return 0
  ( while sleep "$FLEET_PUBLISH_INTERVAL"; do apply_status '{}'; done ) &
  FLEET_PUB_PID=$!
}

stop_fleet_publisher() {
  [ -n "$FLEET_PUB_PID" ] || return 0
  kill "$FLEET_PUB_PID" 2>/dev/null
  wait "$FLEET_PUB_PID" 2>/dev/null
  FLEET_PUB_PID=""
}

# --- Ersatz für `timeout` (fehlt auf macOS) ----------------------------------
# Bleibt in Bash: hängt an Signalen und Prozessgruppen, in Node wäre das ein
# Rückschritt. Beendet die ganze Prozessgruppe, nicht nur das Kind.
run_limited() {   # $1 = Sekunden, $2 = cwd, Rest = Befehl. Ausgabe geht nach $LOG.
  local secs="$1"; shift
  local cwd="$1"; shift
  rm -f "$TIMED_OUT"

  # `<&0` ist kein No-Op: ein Hintergrundjob OHNE ausdrueckliche Umlenkung
  # bekommt stdin von /dev/null -- der Prompt aus der Pipe (run_round) kaeme nie
  # bei `claude` an, die linke Seite stuerbe an EPIPE. `exec` in der Subshell
  # ersetzt nur den Subshell-Prozess, die Prozessgruppen-/Signal-Logik unten
  # (Notbremse) trifft weiter den ganzen Baum.
  set -m
  ( cd "$cwd" && exec "$@" ) <&0 > "$LOG" 2>&1 &
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

# --- Worktree je Ticket (#242) ------------------------------------------------
# Vorfall #196: der Runner baute im geteilten Haupt-Checkout, ein anderer
# Branch stand aus, und eine ganze Ticket-Arbeit landete unter einem fremden
# PR. Ein Bau-Lauf bekommt seither einen eigenen Worktree als cwd. Aktiv nur,
# wenn REPO_DIR ein echter git-Arbeitsbaum ist -- die Bash-Suiten stubben git
# als reines "exit 0" mit leerem REPO_DIR, `rev-parse` liefert dort nie
# "true", das Feature bleibt für sie unsichtbar inaktiv.
worktrees_enabled() {
  [ "$(git -C "$REPO_DIR" rev-parse --is-inside-work-tree 2>/dev/null)" = "true" ]
}

# Branchname zu einer Ticketnummer -- erst lokal, dann remote. Leere Ausgabe
# heisst: kein Branch vorhanden (frischer Start ab origin/main).
branch_for_issue() {   # $1 = Ticketnummer -> Branchname auf stdout
  local nr="$1" ref
  ref=$(git -C "$REPO_DIR" for-each-ref --format='%(refname:short)' \
          "refs/heads/feat/$nr-*" "refs/heads/fix/$nr-*" "refs/heads/chore/$nr-*" \
          2>/dev/null | head -1)
  if [ -n "$ref" ]; then printf '%s' "$ref"; return 0; fi
  git -C "$REPO_DIR" ls-remote --heads origin \
        "feat/$nr-*" "fix/$nr-*" "chore/$nr-*" 2>/dev/null \
    | head -1 | awk '{print $2}' | sed 's#^refs/heads/##'
}

# Idempotent: verlinkt node_modules/.env.local aus dem Haupt-Checkout, damit
# lint/typecheck/test im Worktree ohne eigenes 'pnpm install' laufen -- beide
# sind gitignored und fehlen in einem frischen Worktree sonst ganz.
bootstrap_worktree() {   # $1 = Worktree-Pfad
  local wt="$1"
  [ -e "$wt/node_modules" ] || ln -s "$REPO_DIR/node_modules" "$wt/node_modules" 2>/dev/null
  if [ ! -e "$wt/.env.local" ] && [ -f "$REPO_DIR/.env.local" ]; then
    ln -s "$REPO_DIR/.env.local" "$wt/.env.local" 2>/dev/null
  fi
  # Push-Netz gegen Doppelbau (#449, ADR-0020): absoluter Pfad IN den
  # Worktree, damit die eingecheckte Hook-Datei auf jedem Branch da ist --
  # unabhaengig vom Haupt-Checkout. Nur Bau-Worktrees (nicht
  # readonly_worktree(): Lese-Rollen pushen nie).
  git -C "$wt" config core.hooksPath "$wt/scripts/git-hooks" 2>/dev/null
  return 0
}

# Legt den Ticket-Worktree an oder nutzt einen vorhandenen wieder. Pfad auf
# stdout, Exit ungleich 0 = Abbruch -- der Aufrufer weicht dann NICHT in den
# Haupt-Checkout aus (AK4: belegt/unsauber bricht ab, statt auszuweichen).
ensure_worktree() {   # $1 = Ticketnummer -> Worktree-Pfad auf stdout
  local nr="$1"
  local wt="$WORKTREE_BASE/issue-$nr" branch
  mkdir -p "$WORKTREE_BASE"

  if git -C "$REPO_DIR" worktree list --porcelain 2>/dev/null | grep -qF "worktree $wt"; then
    if [ -d "$wt" ]; then
      bootstrap_worktree "$wt"
      printf '%s' "$wt"
      return 0
    fi
    echo "Worktree-Eintrag fuer $wt existiert, Verzeichnis fehlt (siehe 'git worktree prune')." >&2
    return 1
  fi

  if [ -e "$wt" ]; then
    echo "Worktree-Pfad $wt ist belegt, aber kein registrierter Worktree -- Abbruch statt Ausweichen." >&2
    return 1
  fi

  branch=$(branch_for_issue "$nr")
  if [ -n "$branch" ]; then
    if ! git -C "$REPO_DIR" worktree add "$wt" "$branch" >&2; then
      git -C "$REPO_DIR" worktree add --track -b "$branch" "$wt" "origin/$branch" >&2 || return 1
    fi
  else
    git -C "$REPO_DIR" fetch origin main >&2 || return 1
    git -C "$REPO_DIR" worktree add --detach "$wt" origin/main >&2 || return 1
  fi

  [ -d "$wt" ] || { echo "Worktree-Anlage fuer $wt fehlgeschlagen." >&2; return 1; }
  bootstrap_worktree "$wt"
  printf '%s' "$wt"
}

# #325: Read-only-Laeufe (plan/research) bekommen wie Bau-Laeufe einen
# eigenen Worktree als cwd -- statt im geteilten Haupt-Checkout zu lesen.
# Anders als ensure_worktree() ist das hier ein WEGWERF-Worktree: immer
# frisch ab origin/main, nie wiederverwendet. Das loest nebenbei einen
# veralteten oder auf der falschen Branch stehenden Haupt-Checkout (siehe
# Ticket-Diskussion #325) und macht den Haupt-Checkout fuer JEDE Rolle
# unveraendert -- das alte Read-only-Netz in round.ts wird damit zum reinen
# Zusatz-Tripwire statt Primaerschutz. Pfad bleibt stabil je Ticket
# (readonly-<nr>), damit --resume dieselbe Session wiederfindet, auch wenn
# der Worktree zwischen zwei Laeufen jedes Mal neu angelegt wird.
readonly_worktree() {   # $1 = Ticketnummer -> Wegwerf-Worktree-Pfad auf stdout
  local nr="$1"
  local wt="$WORKTREE_BASE/readonly-$nr"
  mkdir -p "$WORKTREE_BASE"

  # Rest eines abgebrochenen Laufs zuerst wegwerfen -- ein Wegwerf-Worktree
  # ist nie eine Wiederverwendung, sondern startet jedes Mal frisch. Kein
  # '--force' (T20 verbietet die Bypass-Flags im Skript): ein sauberer
  # 'remove' reicht im Normalfall, der rm -rf-Fallback unten faengt den Rest.
  if git -C "$REPO_DIR" worktree list --porcelain 2>/dev/null | grep -qF "worktree $wt"; then
    git -C "$REPO_DIR" worktree remove "$wt" >/dev/null 2>&1
  fi
  if [ -e "$wt" ]; then
    rm -rf "$wt"
    git -C "$REPO_DIR" worktree prune >/dev/null 2>&1
  fi

  git -C "$REPO_DIR" fetch origin main >&2 || return 1
  git -C "$REPO_DIR" worktree add --detach "$wt" origin/main >&2 || return 1

  # Kein bootstrap_worktree(): Lese-Rollen lint/typecheck/bauen nicht, nur
  # Read/Grep/Glob/`gh`/`git log|diff|show` -- kein node_modules noetig.
  [ -d "$wt" ] || { echo "Wegwerf-Worktree-Anlage fuer $wt fehlgeschlagen." >&2; return 1; }
  printf '%s' "$wt"
}

# --- Eine Runde --------------------------------------------------------------
# Drei Aufrufe in den TS-Kern, dazwischen genau ein `claude`-Lauf:
#   round-plan   -> Wächter, Ticketwahl, CI-Wache, Modell, Deckel, Prompt
#   round-prompt -> der fertige Prompt nach stdout, hier in `claude` gepipet
#   round-eval   -> Session-ID, Read-only-Netz, Limit/Notbremse/Fehlschlag
run_round() {
  CHAIN_STATUS=stop
  # Chain-Zustände gehören main(); die Bash-Suiten rufen run_round aber auch
  # einzeln auf, wo `set -u` sonst abbräche.
  : "${DID_WORK:=0}" "${LAST_ISSUE:=}"

  # #204 (E5): WER faehrt diese Runde die globalen Waechter? Vor round-plan
  # bestimmt, nicht danach -- die Waechter darin (reopenFalselyClosedIssues,
  # CI-Wache fuer wartende Tickets, claimSweep) muessen wissen, ob sie laufen
  # duerfen, BEVOR sie liefen. EFF_LEAD bleibt fuer die ganze Runde fest (auch
  # fuer apply_status() nach round-eval) -- kein Flackern zwischen den beiden
  # ts_run-Aufrufen derselben Runde.
  #
  # #488 (F14): fleet-effective-lead berechnet EFF_LEAD weiter wie bisher
  # (Herzschlag-Berechtigung), versucht aber ALS SEITENEFFEKT die Lease unter
  # SHARED_DIR/lead zu uebernehmen. IS_LEAD kommt NICHT mehr aus einem
  # simplen Vergleich SLOT_ID=EFF_LEAD (zwei Slots koennten das am
  # Frischerand unterschiedlich auswerten), sondern aus fleet-verify-lead --
  # nur wer die Lease TATSAECHLICH haelt, ist Leitslot.
  EFF_LEAD=$(ts_run fleet-effective-lead "$SLOT_COUNT" "$LEAD_SLOT")
  IS_LEAD=0; ts_run fleet-verify-lead >/dev/null 2>&1 && IS_LEAD=1
  export EFF_LEAD IS_LEAD

  local plan plan_rc kind rc timed eval_out
  # "${STATUS_ISSUE:-0}" statt "$STATUS_ISSUE": die Variable wird oben (Z. 22)
  # nur EINMAL beim Skriptstart defaultet -- unter `set -u` crasht jede Runde
  # fatal, sollte STATUS_ISSUE danach je unbound werden (beobachtet in
  # waiting-label.test.sh, dessen Testblock 5 die Variable bewusst wieder
  # `unset`, um ein Slot-Setup ohne Status-Issue zu simulieren).
  plan=$(ts_run round-plan "$QUEUE_ISSUE" "$MAX_RUNTIME" "$DID_WORK" "$LAST_ISSUE" "$IS_LEAD" "${STATUS_ISSUE:-0}")
  plan_rc=$?
  # round-plan MUSS Exit 0 UND ein gültiges JSON-Objekt (mit .kind) liefern.
  # Jeder andere Ausgang (leeres/kaputtes plan) ist fatal: 127 hat ts_run schon
  # über status() gemeldet, alles andere meldet sich HIER -- statt jq später
  # still auf Müll laufen zu lassen (#257).
  if [ "$plan_rc" -ne 0 ] || ! printf '%s' "$plan" | jq -e 'has("kind")' >/dev/null 2>&1; then
    if [ "$plan_rc" -ne 127 ]; then
      status "Runde ohne Plan" "🔴" "🔴 round-plan scheiterte (Exit $plan_rc) oder lieferte kein gültiges JSON -- die Runde konnte nicht starten. Der nächste Tick versucht es erneut."
    fi
    return 1
  fi
  printf '%s' "$plan" > "$ROUND_FILE"
  apply_status "$plan"

  kind=$(printf '%s' "$plan" | jq -r '.kind')
  if [ "$kind" != "run" ]; then
    return "$(printf '%s' "$plan" | jq -r '.rc // 0')"
  fi

  local model tools resume role issue run_cwd denyTools used_resume
  model=$(printf '%s' "$plan" | jq -r '.model')
  tools=$(printf '%s' "$plan" | jq -r '.tools')
  resume=$(printf '%s' "$plan" | jq -r '.resume')
  role=$(printf '%s' "$plan" | jq -r '.role')
  issue=$(printf '%s' "$plan" | jq -r '.issue')
  denyTools=$(printf '%s' "$plan" | jq -r '.denyTools')

  # Jede Rolle bekommt einen eigenen Worktree als cwd, nie den geteilten
  # Haupt-Checkout: Bau (#242) einen wiederverwendeten je Ticket, Lese-Rollen
  # (#325) einen Wegwerf-Worktree frisch ab origin/main. Scheitert Anlage/
  # Wiederverwendung, bricht die Runde ab statt in den Haupt-Checkout
  # auszuweichen (AK4).
  run_cwd="$REPO_DIR"
  if worktrees_enabled; then
    if [ "$role" = "build" ]; then
      if ! run_cwd=$(ensure_worktree "$issue"); then
        status "Worktree-Fehler · #$issue" "🔴" \
          "🔴 Worktree für #$issue konnte nicht angelegt oder wiederverwendet werden -- kein Bau-Lauf gestartet. Details im Runner-Log."
        CHAIN_STATUS=stop
        return 1
      fi
    else
      if ! run_cwd=$(readonly_worktree "$issue"); then
        status "Worktree-Fehler · #$issue" "🔴" \
          "🔴 Wegwerf-Worktree für #$issue konnte nicht angelegt werden -- kein Lese-Lauf gestartet. Details im Runner-Log."
        CHAIN_STATUS=stop
        return 1
      fi
    fi
  fi

  # Welches Modell erlaubt ist, hat round-plan entschieden (ADR-0005/0007);
  # hier wird es nur durchgereicht. O3 (#325): denyTools ist die harte
  # Zusatzgrenze neben der Allowlist, nur fuer Lese-Rollen gesetzt.
  #
  # base_args OHNE --resume (#356, B): der Frischversuch weiter unten braucht
  # exakt dieselben Argumente minus --resume -- getrennt halten statt aus
  # 'args' herauszufiltern.
  local -a base_args=(-p --output-format json --model "$model" --allowedTools "$tools")
  [ -n "$denyTools" ] && [ "$denyTools" != "null" ] && base_args+=(--disallowedTools "$denyTools")

  local -a args=("${base_args[@]}")
  used_resume=0
  if [ -n "$resume" ] && [ "$resume" != "null" ]; then
    args+=(--resume "$resume")
    used_resume=1
  fi

  # Der Prompt kommt aus dem TS-Kern über stdout und wird hier gepipet, nicht
  # als Argument übergeben. rc kommt aus PIPESTATUS, NICHT aus $?: mit
  # `pipefail` wäre es sonst der Code der linken Seite -- liest `claude` stdin
  # nicht aus, gälte ein sauberer Lauf wegen EPIPE als gescheitert.
  start_fleet_publisher

  ts_run round-prompt "$ROUND_FILE" | run_limited "$MAX_RUNTIME" "$run_cwd" claude "${args[@]}"
  rc=${PIPESTATUS[1]}

  stop_fleet_publisher

  timed=0
  if [ -f "$TIMED_OUT" ]; then timed=1; rm -f "$TIMED_OUT"; fi

  # --- Selbstheilung bei nicht-fortsetzbarer Session (#356, B) --------------
  # Ein per --resume uebergebenes Session-ID, die die CLI im aktuellen
  # Arbeitsverzeichnis nicht kennt ("No conversation found", #353), ist kein
  # Fachfehler am Ticket. round-recover erkennt genau diesen Fall UND raeumt
  # die Gift-Session weg; hier folgt GENAU EIN Frischversuch ohne --resume,
  # keine Schleife -- der Ausgang DIESES Versuchs, nicht der erste Crash,
  # fliesst in round-eval ein, damit ein vergifteter Erstversuch nie als
  # Eskalations-Fehlversuch zaehlt (buildEscalationEval laeuft erst dort).
  # Vor der Worktree-Entfernung: der Frischversuch braucht denselben run_cwd.
  # Nicht bei einem Notbremse-Timeout -- der ist eindeutig, kein Session-Fehler.
  if [ "$used_resume" -eq 1 ] && [ "$timed" -ne 1 ]; then
    if ts_run round-recover "$ROUND_FILE" "$rc" "$LOG" | jq -e '.retry == true' >/dev/null 2>&1; then
      start_fleet_publisher
      ts_run round-prompt "$ROUND_FILE" | run_limited "$MAX_RUNTIME" "$run_cwd" claude "${base_args[@]}"
      rc=${PIPESTATUS[1]}
      stop_fleet_publisher
      if [ -f "$TIMED_OUT" ]; then timed=1; rm -f "$TIMED_OUT"; fi
    fi
  fi

  # Wegwerf-Worktree (#325) sofort nach dem Lauf entfernen -- ersetzt das
  # alte pauschale Aufraeumen im Read-only-Netz. round-eval prueft danach den
  # HAUPT-Checkout ($REPO_DIR), nicht diesen Worktree -- Reihenfolge zur
  # Notbremse unten unkritisch. Kein '--force' (T20): sauberer 'remove'
  # reicht, rm -rf faengt den Rest.
  if [ "$role" != "build" ] && [ "$run_cwd" != "$REPO_DIR" ]; then
    git -C "$REPO_DIR" worktree remove "$run_cwd" >/dev/null 2>&1 \
      || { rm -rf "$run_cwd"; git -C "$REPO_DIR" worktree prune >/dev/null 2>&1; }
  fi

  eval_out=$(ts_run round-eval "$ROUND_FILE" "$rc" "$timed" "$MAX_RUNTIME" "$LOG")
  [ $? -eq 127 ] && return 1
  apply_status "$eval_out"

  CHAIN_STATUS=$(printf '%s' "$eval_out" | jq -r '.chain')
  [ "$(printf '%s' "$eval_out" | jq -r '.didWork')" = "true" ] && DID_WORK=1
  LAST_ISSUE=$(printf '%s' "$eval_out" | jq -r '.lastIssue')
  return "$(printf '%s' "$eval_out" | jq -r '.rc')"
}

# --- Der imperative Hauptteil ------------------------------------------------
# In main() gekapselt, damit Tests die Funktionen oben sourcen können, ohne
# einen echten Lauf zu starten (Source-Guard ganz unten).
main() {

# --- Nie zwei Läufe gleichzeitig ---------------------------------------------
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

# .runner/ raeumt sich auf (#64) -- Regeln in scripts/runner/cleanup.ts.
ts_run cleanup-state >/dev/null

# --- Ticket-Worktrees aufräumen (#242) ----------------------------------------
# Verwaiste Admin-Einträge prunen, dann je WORKTREE_BASE/issue-* prüfen: ist
# das Ticket zu (Auto-Merge schließt via "Closes #n"), fliegt der Worktree.
# Offene/geparkte Tickets behalten ihren. Nur wenn worktrees_enabled -- sonst
# ein No-Op ohne gh/git-Aufrufe.
if worktrees_enabled; then
  git -C "$REPO_DIR" worktree prune >/dev/null 2>&1
  if [ -d "$WORKTREE_BASE" ]; then
    for wt in "$WORKTREE_BASE"/issue-*; do
      [ -d "$wt" ] || continue
      nr="${wt##*/issue-}"
      case "$nr" in ''|*[!0-9]*) continue ;; esac
      wt_state=$(gh issue view "$nr" --json state -q .state 2>/dev/null || echo "")
      if [ "$wt_state" = "CLOSED" ]; then
        # Kein '--force': das Ticket ist zu, ein sauberer 'remove' reicht. Sperrt
        # git wegen lokaler Reste (T20 verbietet die Bypass-Flags im Skript), räumt
        # der manuelle Fallback + 'prune' den Admin-Eintrag trotzdem weg.
        if ! git -C "$REPO_DIR" worktree remove "$wt" >/dev/null 2>&1; then
          rm -rf "$wt"
          git -C "$REPO_DIR" worktree prune >/dev/null 2>&1
        fi
      fi
    done
  fi

  # #325: ein noch liegender Wegwerf-Worktree (readonly-*) ist IMMER ein
  # Absturz-Rest, nie ein aktiver Lauf -- run_round() entfernt ihn direkt nach
  # jedem Lese-Lauf, ein noch existierender kann also nur von einem
  # abgebrochenen Tick stammen. Deshalb bedingungslos weg, anders als bei
  # issue-* oben (kein Zustand zu pruefen).
  if [ -d "$WORKTREE_BASE" ]; then
    for wt in "$WORKTREE_BASE"/readonly-*; do
      [ -d "$wt" ] || continue
      # Kein '--force' (T20): sauberer 'remove' reicht, rm -rf faengt den Rest.
      if ! git -C "$REPO_DIR" worktree remove "$wt" >/dev/null 2>&1; then
        rm -rf "$wt"
        git -C "$REPO_DIR" worktree prune >/dev/null 2>&1
      fi
    done
  fi
fi

# --- Kontingent erschöpft? Dann gar nicht erst starten ------------------------
# Solange das Limit nachweislich steht, lohnt kein Agentenstart. Fehlt die Datei
# oder ist sie abgelaufen, läuft alles wie immer -- ein Fehlparsen darf den
# Runner nie stilllegen. Garantierter No-Op: kein tsx-Start, kein gh.
if [ -s "$LIMIT_UNTIL" ]; then
  UNTIL=$(cat "$LIMIT_UNTIL" 2>/dev/null)
  NOW=$(date +%s)
  if [ -n "$UNTIL" ] && [ "$UNTIL" -gt "$NOW" ] 2>/dev/null; then
    echo "Kontingent erschöpft bis $(fmt_hm "$UNTIL") — Lauf übersprungen."
    exit 0
  fi
  rm -f "$LIMIT_UNTIL"
fi

# --- Weicht die laufende Shim-Datei von der reviewten Fassung ab? -------------
# Geprüft wird hier und NICHT im Shim: der Shim ist die eine Datei, die läuft,
# ohne im Repo zu liegen -- trüge er die Prüfung selbst, könnte eine zu alte
# Fassung nicht melden, dass sie zu alt ist. Diese Datei hier wird bei jedem Tick
# frisch aus origin/main materialisiert, also greift die Meldung auch gegen einen
# uralten installierten Shim. Entschieden wird in scripts/runner/shim.ts, hier
# steht nur die Meldung -- status() bleibt bash-only (#252).
#
# Bewusst NACH dem Limit-Gate: das muss ein garantierter No-Op ohne gh und ohne
# tsx bleiben.
#
# Ein Drift hält den Lauf NICHT an. 🟡 heisst 'wartet auf dich', nicht 'kaputt'
# -- nach elf Stunden Totalausfall (#249) ist ein stehender Runner teurer als
# ein abweichender.
SHIM_PATH="${SHIM_PATH:-$HOME/.local/bin/starship-runner}"
SHIM_DRIFT=$(ts_run shim-drift-reason "$SHIM_PATH" "${RUNNER_REF:-origin/main}")
if [ -n "$SHIM_DRIFT" ]; then
  status "Shim weicht ab" "🟡" "🟡 $SHIM_DRIFT

Ausgeführt wird die installierte Kopie, nicht die reviewte Fassung aus dem Repo.
Angleichen mit:

    install -m 0755 scripts/starship-runner ~/.local/bin/starship-runner

Der Lauf geht normal weiter."
fi

# --- Chain-Schleife: mehrere Runden pro Tick (#61) ----------------------------
# Weiter nur nach einem SAUBER grünen run_round(): CHAIN_STATUS steht dort ganz
# oben auf 'stop', nur der grüne Zweig in round-eval schaltet auf 'continue'.
# Jeder andere Ausgang bricht die Kette sofort ab. Die erste Runde läuft immer;
# TICK_BUDGET wird erst VOR jeder weiteren geprüft, die laufende bleibt durch
# MAX_RUNTIME gedeckelt.
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

# Nur ausfuehren, wenn direkt gestartet -- nicht beim Sourcen durch Tests.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
