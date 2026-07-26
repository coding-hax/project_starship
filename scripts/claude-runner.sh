#!/usr/bin/env bash
# Claude-Runner: pollt GitHub Issues, arbeitet EIN Ticket, überlebt Limits.
# Läuft per launchd (macOS) oder systemd (Linux) alle 5 Minuten.
#
# Braucht: gh, jq und die EIGENSTÄNDIGE claude-CLI im PATH.
# (Die VS-Code-Erweiterung zählt nicht — sie legt `claude` nicht in den PATH.)
#
# Seit S6 (#203, letzte Stufe von #184) ist dieses Skript nur noch der
# Einstiegspunkt. Die gesamte Entscheidungslogik liegt in scripts/runner/*.ts
# und wird über ts_run() gerufen. In Bash bleibt bewusst nur, was in Node ein
# Rückschritt wäre:
#
#   * der Lauf-Lock über `mkdir` (atomar auf POSIX, ersetzt das auf macOS
#     fehlende flock)
#   * das 'limit-until'-Gate — ein garantierter No-Op, der ohne tsx-Start und
#     ohne gh-Aufruf auskommt
#   * die Chain-Schleife (#61)
#   * `run_limited`, der Ersatz für das auf macOS fehlende `timeout`: er hängt
#     an Signalen und Prozessgruppen, das gehört nicht nach Node
#   * der `claude`-Aufruf selbst — TS baut den Prompt und schreibt ihn nach
#     stdout, hier wird er in `claude` gepipet
set -uo pipefail

# Wo dieses Skript samt TS-Kern liegt -- die Wurzel des Checkouts, aus dem der
# Runner GESTARTET wurde. Bewusst getrennt von $REPO_DIR (dem Arbeitsbaum, an
# dem gebaut wird): der Shim holt claude-runner.sh aus origin/main, und cli.ts
# muss aus demselben Stand kommen wie das Skript, das es aufruft.
RUNNER_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

REPO_DIR="${REPO_DIR:-$HOME/dev/project_starship}"
STATUS_ISSUE="${STATUS_ISSUE:-0}"       # Nr. des angepinnten Runner-Status-Issues
QUEUE_ISSUE="${QUEUE_ISSUE:-0}"         # Nr. des Prioritäts-Queue-Issues (0 = aus)
MAX_RUNTIME="${MAX_RUNTIME:-2700}"      # Sekunden. Notbremse gegen hängende Läufe -- PRO LAUF.
MAX_ROUNDS="${MAX_ROUNDS:-3}"           # Ticket-Chaining (#61): max. Runden PRO TICK.
TICK_BUDGET="${TICK_BUDGET:-$MAX_RUNTIME}"  # Sek.-Budget/Tick, vor jeder neuen Runde geprüft.
# Default wie bisher $REPO_DIR/.runner; ein vorab exportiertes STATE_DIR
# (Testfixture) gewinnt -- UND wird seinerseits exportiert, damit der per
# ts_run() gestartete tsx-Kindprozess (scripts/runner/state.ts liest
# process.env.STATE_DIR) exakt dasselbe Verzeichnis sieht wie dieser Pfad.
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

ts() { date "+%d.%m. %H:%M"; }

# Unix-Zeit -> "Mo 14:51". BSD (macOS) und GNU (Linux) sprechen hier
# verschiedene Dialekte, deshalb jeweils beide Varianten. Bleibt in Bash, weil
# der einzige Aufrufer das Limit-Gate unten ist -- das muss ohne tsx-Start
# auskommen.
fmt_hm() { date -r "$1" "+%a %H:%M" 2>/dev/null || date -d "@$1" "+%a %H:%M" 2>/dev/null; }

sha1_of() {
  printf '%s' "$1" | shasum -a 1 2>/dev/null | cut -d' ' -f1 \
    || printf '%s' "$1" | sha1sum 2>/dev/null | cut -d' ' -f1
}

# Status-Issue per EDIT aktualisieren, nicht per Kommentar (sonst bekommst du
# bei jedem Lauf eine Push-Nachricht aufs Handy).
#
# Die Farbe steht im TITEL, nicht nur im Text: auf dem Handy sieht man in der
# Issue-Liste sonst nur die statische Ampel und muss reinklicken.
#
#   🟠 arbeitet an #N   – Lauf ist unterwegs, vor dem `claude`-Aufruf gesetzt
#   🟢 wartet/nichts offen – Ruhe: nächster Takt startet ggf. automatisch
#   🟡 wartet auf dich  – EINGREIFEN (Frage offen oder Freigabe nötig)
#   🔴 Fehler           – EINGREIFEN
#   🔵 Limit erreicht   – pausiert, läuft von selbst weiter
#   ⚪️ nichts zu tun    – kein Ticket auf `ready`
#
# Nur bei inhaltlicher Änderung schreiben (#64): sha1 über Titel+Emoji+Text,
# ausdrücklich OHNE den "_Stand:_"-Zeitstempel, den die Funktion selbst unten
# anhängt -- sonst wäre der Hash immer verschieden und die Optimierung
# wirkungslos. Die Datei bleibt leer, wenn gh fehlschlägt: der nächste Aufruf
# versucht es dann erneut, egal ob inhaltlich gleich oder nicht.
#
# Die Texte selbst entstehen seit S6 im TS-Kern (scripts/runner/round.ts) und
# kommen über apply_status() hier an -- geschrieben wird weiterhin nur an
# dieser einen Stelle.
STATUS_HASH_FILE="$STATE_DIR/status-hash"
status() {   # $1 = Titelzeile (ohne Emoji), $2 = Emoji, $3 = Text
  [ "$STATUS_ISSUE" -gt 0 ] 2>/dev/null || return 0
  local sig
  sig=$(sha1_of "$2 Runner · $1"$'\x1e'"$3")
  [ "$(cat "$STATUS_HASH_FILE" 2>/dev/null)" = "$sig" ] && return 0
  gh issue edit "$STATUS_ISSUE" \
    --title "$2 Runner · $1" \
    --body "$3

_Stand: $(ts)_" >/dev/null 2>&1 && printf '%s' "$sig" > "$STATUS_HASH_FILE"
}

# --- Naht zu TypeScript ------------------------------------------------------
# Die einzige Brücke zum TS-Kern. Vertrag: stdout und Exit-Code kommen exakt
# von cli.ts durch, nichts wird hier ausgewertet oder umgedeutet.
#
# Der Kern wird über $RUNNER_HOME aufgelöst, NICHT über $REPO_DIR: cli.ts
# gehört zu diesem Skript, nicht zum Arbeitsbaum, an dem gerade gebaut wird.
#
# Ein fehlendes/kaputtes `tsx` (Exit 127) ist seit S6 ein harter Fehler statt
# eines Rückfalls -- es gibt keinen Bash-Pfad mehr, auf den zurückzufallen
# wäre. Die Meldung geht über status() aufs Handy, damit ein unbeaufsichtigter
# Lauf das nicht still schluckt.
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

# --- .runner/ räumt sich auf (#64) -------------------------------------------
# tier-/failcount-/opus-build-/opus-cap-msg-/session--Dateien geschlossener
# Tickets blieben sonst für immer liegen. Einmal PRO TICK alles älter als 7
# Tage weg. Ausdrücklich verschont: 'limit-until' (kein Ticket-Bezug) und die
# Session-Datei des GERADE laufenden Tickets, egal wie alt.
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

# --- Ersatz für `timeout` (fehlt auf macOS) ----------------------------------
# Bleibt bewusst in Bash: hängt an Signalen und Prozessgruppen, in Node wäre
# das ein Rückschritt. Beendet die ganze Prozessgruppe, nicht nur das Kind.
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

# --- Eine Runde --------------------------------------------------------------
# Drei Aufrufe in den TS-Kern, dazwischen genau ein `claude`-Lauf:
#   round-plan   -> Wächter, Ticketwahl, CI-Wache, Modell, Deckel, Prompt
#   round-prompt -> der fertige Prompt nach stdout, hier in `claude` gepipet
#   round-eval   -> Session-ID, Read-only-Netz, Limit/Notbremse/Fehlschlag
run_round() {
  CHAIN_STATUS=stop
  # Die Chain-Zustände gehören main(); die Bash-Suiten rufen run_round aber
  # auch einzeln auf, und `set -u` würde sie dort sonst abbrechen.
  : "${DID_WORK:=0}" "${LAST_ISSUE:=}"

  local plan kind rc timed eval_out
  plan=$(ts_run round-plan "$QUEUE_ISSUE" "$MAX_RUNTIME" "$DID_WORK" "$LAST_ISSUE")
  [ $? -eq 127 ] && return 1
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

  # Opus ist für den Runner tabu (docs/TOKEN-BUDGET.md) -- außer in den nur
  # lesenden Denk-Rollen (ADR-0005) und der Eskalations-Rolle (ADR-0007), die
  # als letzte Modellstufe tatsächlich baut. Welche Stufe gilt, hat round-plan
  # entschieden; hier wird sie nur noch durchgereicht.
  local -a args=(-p --output-format json --model "$model" --allowedTools "$tools")
  [ -n "$resume" ] && [ "$resume" != "null" ] && args+=(--resume "$resume")

  # AK6: der Prompt kommt aus dem TS-Kern über stdout und wird hier gepipet --
  # nicht als Argument übergeben.
  #
  # rc kommt aus PIPESTATUS, NICHT aus $? -- mit `set -o pipefail` wäre der
  # Exit-Code des ganzen Laufs sonst der der linken Seite. Beendet sich
  # `claude`, ohne stdin auszulesen, bekommt round-prompt ein EPIPE und der
  # Lauf gälte als gescheitert, obwohl der Agent sauber durchgelaufen ist.
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
# Gekapselt in main(), damit Tests die obigen Funktionen sourcen können, ohne
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

cleanup_state_dir

# --- Kontingent erschöpft? Dann gar nicht erst starten ------------------------
# Der Timer tickt weiter alle 5 Minuten. Solange das Limit nachweislich noch
# steht, hat es keinen Sinn, einen Agenten hochzufahren. Fehlt die Datei oder
# ist sie abgelaufen, läuft alles wie immer — ein Fehlparsen darf den Runner
# nie dauerhaft stilllegen. Dieser Zweig ist ein garantierter No-Op nach außen:
# kein tsx-Start, kein gh-Aufruf.
if [ -s "$LIMIT_UNTIL" ]; then
  UNTIL=$(cat "$LIMIT_UNTIL" 2>/dev/null)
  NOW=$(date +%s)
  if [ -n "$UNTIL" ] && [ "$UNTIL" -gt "$NOW" ] 2>/dev/null; then
    echo "Kontingent erschöpft bis $(fmt_hm "$UNTIL") — Lauf übersprungen."
    exit 0
  fi
  rm -f "$LIMIT_UNTIL"
fi

# --- Chain-Schleife: mehrere Runden pro Tick (#61) ----------------------------
# Weiter nur nach einem SAUBER grünen run_round(): CHAIN_STATUS wird dort ganz
# oben auf 'stop' gesetzt, und nur der grüne Zweig in round-eval schaltet auf
# 'continue'. Jeder andere Ausgang (needs-input, Limit, Notbremse, Transient,
# roter Exit, Opus-Deckel, Read-only-Netz, 'nichts zu tun') lässt 'stop'
# stehen und bricht die Kette sofort ab. Die erste Runde läuft immer;
# TICK_BUDGET wird erst VOR jeder weiteren Runde geprüft -- die laufende Runde
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

# Nur ausfuehren, wenn direkt gestartet -- nicht beim Sourcen durch Tests.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
