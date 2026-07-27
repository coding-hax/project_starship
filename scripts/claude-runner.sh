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
# Ein vorab exportiertes STATE_DIR (Testfixture) gewinnt -- und wird selbst
# exportiert, damit der tsx-Kindprozess dasselbe Verzeichnis sieht.
STATE_DIR="${STATE_DIR:-$REPO_DIR/.runner}"
export STATE_DIR
LIMIT_UNTIL="$STATE_DIR/limit-until"    # Unix-Zeit, bis zu der das Kontingent leer ist
LOG="$STATE_DIR/last-run.log"           # stdout+stderr des letzten claude-Laufs
TIMED_OUT="$STATE_DIR/timed-out"        # Marker der Notbremse, siehe run_limited()
ROUND_FILE="$STATE_DIR/round.json"      # Plan der laufenden Runde, Übergabe an round-eval

cd "$REPO_DIR" || { echo "REPO_DIR nicht gefunden: $REPO_DIR" >&2; exit 1; }
mkdir -p "$STATE_DIR"

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

# Schreibt den von round.ts gebauten Status, falls die Runde einen liefert.
apply_status() {   # $1 = JSON mit optionalem .status
  local s
  s=$(printf '%s' "$1" | jq -c '.status // empty' 2>/dev/null)
  [ -z "$s" ] || [ "$s" = "null" ] && return 0
  status "$(printf '%s' "$s" | jq -r '.title')" \
         "$(printf '%s' "$s" | jq -r '.emoji')" \
         "$(printf '%s' "$s" | jq -r '.text')"
}

# --- Ersatz für `timeout` (fehlt auf macOS) ----------------------------------
# Bleibt in Bash: hängt an Signalen und Prozessgruppen, in Node wäre das ein
# Rückschritt. Beendet die ganze Prozessgruppe, nicht nur das Kind.
run_limited() {   # $1 = Sekunden, Rest = Befehl. Ausgabe geht nach $LOG.
  local secs="$1"; shift
  rm -f "$TIMED_OUT"

  # `<&0` ist kein No-Op: ein Hintergrundjob OHNE ausdrueckliche Umlenkung
  # bekommt stdin von /dev/null -- der Prompt aus der Pipe (run_round) kaeme nie
  # bei `claude` an, die linke Seite stuerbe an EPIPE.
  set -m
  "$@" <&0 > "$LOG" 2>&1 &
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

  local plan plan_rc kind rc timed eval_out
  plan=$(ts_run round-plan "$QUEUE_ISSUE" "$MAX_RUNTIME" "$DID_WORK" "$LAST_ISSUE")
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

  local model tools resume
  model=$(printf '%s' "$plan" | jq -r '.model')
  tools=$(printf '%s' "$plan" | jq -r '.tools')
  resume=$(printf '%s' "$plan" | jq -r '.resume')

  # Welches Modell erlaubt ist, hat round-plan entschieden (ADR-0005/0007);
  # hier wird es nur durchgereicht.
  local -a args=(-p --output-format json --model "$model" --allowedTools "$tools")
  [ -n "$resume" ] && [ "$resume" != "null" ] && args+=(--resume "$resume")

  # Der Prompt kommt aus dem TS-Kern über stdout und wird hier gepipet, nicht
  # als Argument übergeben. rc kommt aus PIPESTATUS, NICHT aus $?: mit
  # `pipefail` wäre es sonst der Code der linken Seite -- liest `claude` stdin
  # nicht aus, gälte ein sauberer Lauf wegen EPIPE als gescheitert.
  ts_run round-prompt "$ROUND_FILE" | run_limited "$MAX_RUNTIME" claude "${args[@]}"
  rc=${PIPESTATUS[1]}

  timed=0
  if [ -f "$TIMED_OUT" ]; then timed=1; rm -f "$TIMED_OUT"; fi

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
