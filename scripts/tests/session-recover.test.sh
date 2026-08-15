#!/usr/bin/env bash
# Ende-zu-Ende-Test der Selbstheilung bei nicht-fortsetzbarer Session
# (#356, B). #353: der Runner reichte eine Session-ID per `--resume` durch,
# die die Claude-CLI im aktuellen Arbeitsverzeichnis nicht kannte
# ("No conversation found with session ID: ..."). Das ist kein Fachfehler am
# Ticket -- run_round() erkennt genau diese Meldung (round-recover in
# scripts/runner/round.ts), verwirft die Gift-Session-ID und startet GENAU
# EINMAL ohne --resume neu, bevor der Ausgang in round-eval einfliesst.
#
# #742: Bau-Läufe übergeben seit diesem Ticket nie mehr --resume, also kann
# eine Bau-Rolle das Szenario oben gar nicht mehr auslösen -- es gibt dort
# keine Gift-Session mehr zu vergiften. Die Selbstheilung bleibt trotzdem
# nötig, weil die Denk-Rollen (plan/research) weiter resumen (Nicht-Ziel des
# Tickets). Deshalb zwei Szenarien: 1) ein Planer-Lauf beweist, dass die
# Selbstheilung für Denk-Rollen unverändert greift; 2) ein Bau-Lauf beweist,
# dass eine gespeicherte (ggf. vergiftete) Session dort seit #742 schlicht
# ignoriert wird -- ein einziger Aufruf ohne --resume, keine Recovery nötig.
#
# Reine Bash-Assertions, kein bats (keine neue Dependency). Sourct
# claude-runner.sh (Source-Guard verhindert, dass main() dabei losläuft) und
# stubbt gh/git/claude per PATH-Shim -- analog zu round-snap.test.sh.
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$TEST_DIR/../claude-runner.sh"

FAIL=0
red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

FAKEBIN="$TMP/bin"
mkdir -p "$FAKEBIN"
export GHSTATE_DIR="$TMP/ghstate"
mkdir -p "$GHSTATE_DIR"

# --- Stub 'gh' ---------------------------------------------------------------
# Muster wie round-snap.test.sh: 'issue list --label <L>' liest
# $G/list-<L>.json, ein ungelabelter Aufruf (ROUND_SNAP) baut sich aus den
# vier Ticketwahl-Fixtures zusammen. 'issue comment' schreibt NICHT nur den
# letzten Kommentartext weg, sondern haengt an -- AC4 unten prueft, dass der
# Sichtbarkeits-Kommentar tatsaechlich gepostet wurde, unabhaengig davon, ob
# roundEval hinterher noch einen weiteren Kommentar schreibt.
cat > "$FAKEBIN/gh" <<'STUB'
#!/usr/bin/env bash
G="$GHSTATE_DIR"
mkdir -p "$G"

case "${1:-} ${2:-}" in
  "issue list")
    shift 2
    label=""; q=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --label) label="$2"; shift 2 ;;
        -q) q="$2"; shift 2 ;;
        --json|--state|--limit) shift 2 ;;
        *) shift ;;
      esac
    done
    if [ -n "$label" ]; then
      data=$(cat "$G/list-$label.json" 2>/dev/null || echo '[]')
    else
      data=$({ cat "$G/list-in-progress.json" 2>/dev/null || echo '[]'
               cat "$G/list-plan.json" 2>/dev/null || echo '[]'
               cat "$G/list-research.json" 2>/dev/null || echo '[]'
               cat "$G/list-ready.json" 2>/dev/null || echo '[]'; } | jq -s 'add // []')
    fi
    if [ -n "$q" ]; then
      printf '%s' "$data" | jq -r "$q"
    else
      printf '%s' "$data"
    fi
    ;;
  "issue view")
    issue="$3"; shift 3
    q=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -q) q="$2"; shift 2 ;;
        --json) shift 2 ;;
        *) shift ;;
      esac
    done
    data=$(cat "$G/view-$issue.json" 2>/dev/null || echo '{"labels":[],"comments":[]}')
    if [ -n "$q" ]; then
      printf '%s' "$data" | jq -r "$q"
    else
      printf '%s' "$data"
    fi
    ;;
  "issue edit")
    issue="$3"; shift 3
    while [ $# -gt 0 ]; do
      case "$1" in
        --add-label) echo "ADD:$2" >> "$G/applied-$issue"; shift 2 ;;
        --remove-label) echo "REMOVE:$2" >> "$G/applied-$issue"; shift 2 ;;
        --title|--body) shift 2 ;;
        *) shift ;;
      esac
    done
    ;;
  "issue comment")
    issue="$3"; shift 3
    body=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --body) body="$2"; shift 2 ;;
        --edit-last) shift ;;
        *) shift ;;
      esac
    done
    printf '%s\n---\n' "$body" >> "$G/comments-$issue"
    ;;
  *) ;;
esac
exit 0
STUB

# --- Stub 'git' ----------------------------------------------------------------
# Nur so viel wie main() im Bau-Pfad braucht -- ein pauschales 'exit 0' ohne
# Ausgabe reicht (worktrees_enabled() sieht dadurch REPO_DIR als kein echtes
# Arbeitsverzeichnis an, run_cwd bleibt $REPO_DIR, wie research-mode.test.sh).
cat > "$FAKEBIN/git" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

# --- Stub 'claude' -----------------------------------------------------------
# Modus 'no-session' (der einzige hier gebrauchte): ein Aufruf MIT --resume
# gibt "No conversation found with session ID" + Exit 1 zurueck (genau der
# Wortlaut aus #353), ein Aufruf OHNE --resume liefert eine gueltige neue
# Session-ID. Jeder Aufruf zaehlt mit (claude-calls) und schreibt seine
# vollstaendige Argumentliste in eine eigene Datei -- so lassen sich beide
# Aufrufe einzeln pruefen, nicht nur der letzte.
cat > "$FAKEBIN/claude" <<'STUB'
#!/usr/bin/env bash
G="$GHSTATE_DIR"
n=$(( $(cat "$G/claude-calls" 2>/dev/null || echo 0) + 1 ))
printf '%s' "$n" > "$G/claude-calls"
printf '%s\n' "$@" > "$G/claude-args-$n"

resumed=0
for a in "$@"; do [ "$a" = "--resume" ] && resumed=1; done

if [ "$resumed" -eq 1 ]; then
  printf 'Fehler beim Fortsetzen der Session.\nNo conversation found with session ID: poisoned-session-id\n'
  exit 1
fi
printf '%s' '{"session_id":"frische-session-nach-recovery","result":"ok"}'
exit 0
STUB

chmod +x "$FAKEBIN/gh" "$FAKEBIN/git" "$FAKEBIN/claude"
export PATH="$FAKEBIN:$PATH"

export REPO_DIR="$TMP/repo"
export SHARED_DIR="$TMP/shared"
mkdir -p "$REPO_DIR"
export STATUS_ISSUE=0
export MAX_ROUNDS=1
# shellcheck source=/dev/null
source "$RUNNER"

reset_state() {   # frisches Zustands-/gh-Verzeichnis je Szenario (wie round-snap.test.sh)
  rm -rf "$STATE_DIR/lock.d" "$STATE_DIR" "$GHSTATE_DIR"
  mkdir -p "$STATE_DIR" "$GHSTATE_DIR"
}

assert_eq() {   # $1 = Beschreibung, $2 = erwartet, $3 = tatsaechlich
  if [ "$2" = "$3" ]; then ok "$1"; else red "$1 (erwartet '$2', bekommen '$3')"; fi
}

# ==============================================================================
# 1. Denk-Rolle (#70, in-progress + plan) mit einer bereits vorhandenen, aber
#    nicht mehr fortsetzbaren Session -- das #353-Szenario. Seit #742 der
#    EINZIGE Weg dahin, weil nur Denk-Rollen noch resumen.
# ==============================================================================
reset_state
printf '[{"number":70,"labels":[{"name":"in-progress"},{"name":"plan"}],"createdAt":"2024-01-01T00:00:00Z"}]' \
  > "$GHSTATE_DIR/list-in-progress.json"
printf '[]' > "$GHSTATE_DIR/list-plan.json"
printf '[]' > "$GHSTATE_DIR/list-research.json"
printf '[]' > "$GHSTATE_DIR/list-ready.json"
printf '[]' > "$GHSTATE_DIR/list-needs-answer.json"
printf '{"labels":[{"name":"in-progress"},{"name":"plan"}]}' > "$GHSTATE_DIR/view-70.json"
echo "poisoned-session-id" > "$STATE_DIR/session-think-70"

( main ) >/dev/null 2>&1
RC=$?

assert_eq "AC1: claude wird genau zweimal aufgerufen (Erstversuch + genau ein Frischversuch)" \
  "2" "$(cat "$GHSTATE_DIR/claude-calls" 2>/dev/null || echo 0)"

if grep -q -- '--resume' "$GHSTATE_DIR/claude-args-1" 2>/dev/null; then
  ok "AC1: der Erstversuch nutzt --resume mit der (Gift-)Session"
else
  red "AC1: der Erstversuch haette --resume nutzen muessen"
fi

if [ -f "$GHSTATE_DIR/claude-args-2" ] && ! grep -q -- '--resume' "$GHSTATE_DIR/claude-args-2"; then
  ok "AC2: der Frischversuch laeuft OHNE --resume"
else
  red "AC2: der Frischversuch haette ohne --resume laufen muessen"
fi

assert_eq "AC3: session-think-70 traegt danach die NEUE Session-ID, nicht die Gift-ID" \
  "frische-session-nach-recovery" "$(cat "$STATE_DIR/session-think-70" 2>/dev/null)"

if grep -q 'No conversation found' "$GHSTATE_DIR/comments-70" 2>/dev/null; then
  ok "AC4: Sichtbarkeits-Kommentar am Ticket gepostet"
else
  red "AC4: kein Sichtbarkeits-Kommentar am Ticket gefunden"
fi

assert_eq "AC5: die Runde endet sauber (Exit 0)" "0" "$RC"

if grep -q 'ADD:needs-answer' "$GHSTATE_DIR/applied-70" 2>/dev/null; then
  red "AC5: needs-answer haette NICHT gesetzt werden duerfen"
else
  ok "AC5: kein needs-answer gesetzt"
fi

# buildEscalationEval() ist seit #742 ausdruecklich ein No-op ausserhalb der
# Bau-Rolle (escalation.ts:137, `if (runRole !== 'build') return;`) -- ein
# Planer-Lauf darf also weder failcount- noch tier-Dateien anlegen, egal wie
# die Recovery ausging.
if [ -f "$SHARED_DIR/failcount-70" ]; then
  red "AC5: buildEscalationEval haette fuer die Denk-Rolle NICHT laufen duerfen (failcount-70 existiert)"
else
  ok "AC5: buildEscalationEval bleibt fuer die Denk-Rolle ein No-op (keine failcount-Datei)"
fi

if [ -f "$SHARED_DIR/tier-70" ]; then
  red "AC5: die Modellstufe haette fuer die Denk-Rolle NICHT eskalieren duerfen"
else
  ok "AC5: keine Modell-Eskalation ausgeloest"
fi

# ==============================================================================
# 2. Bau-Rolle (#71, nur in-progress) mit einer gespeicherten Session --
#    seit #742 wird sie nie gelesen: kein --resume, also auch kein
#    "No conversation found", also keine Recovery noetig. Genau EIN Aufruf.
# ==============================================================================
reset_state
printf '[{"number":71,"labels":[{"name":"in-progress"}],"createdAt":"2024-01-01T00:00:00Z"}]' \
  > "$GHSTATE_DIR/list-in-progress.json"
printf '[]' > "$GHSTATE_DIR/list-plan.json"
printf '[]' > "$GHSTATE_DIR/list-research.json"
printf '[]' > "$GHSTATE_DIR/list-ready.json"
printf '[]' > "$GHSTATE_DIR/list-needs-answer.json"
printf '{"labels":[{"name":"in-progress"}]}' > "$GHSTATE_DIR/view-71.json"
echo "poisoned-session-id" > "$STATE_DIR/session-71"

( main ) >/dev/null 2>&1
RC2=$?

assert_eq "AC1 (#742): claude wird fuer die Bau-Rolle nur EINMAL aufgerufen, kein Frischversuch noetig" \
  "1" "$(cat "$GHSTATE_DIR/claude-calls" 2>/dev/null || echo 0)"

if [ -f "$GHSTATE_DIR/claude-args-1" ] && ! grep -q -- '--resume' "$GHSTATE_DIR/claude-args-1"; then
  ok "AC1 (#742): der einzige Aufruf laeuft OHNE --resume, die gespeicherte Session wird ignoriert"
else
  red "AC1 (#742): die Bau-Rolle haette nie --resume nutzen duerfen"
fi

assert_eq "AC3 (#742): session-71 traegt danach die neue Session-ID" \
  "frische-session-nach-recovery" "$(cat "$STATE_DIR/session-71" 2>/dev/null)"

if [ -f "$GHSTATE_DIR/comments-71" ] && grep -q 'No conversation found' "$GHSTATE_DIR/comments-71"; then
  red "AC1 (#742): ohne --resume kann es keine Recovery-Meldung geben"
else
  ok "AC1 (#742): kein Recovery-Kommentar, weil keine Recovery noetig war"
fi

assert_eq "AC5: die Runde endet sauber (Exit 0)" "0" "$RC2"

if grep -q 'ADD:needs-answer' "$GHSTATE_DIR/applied-71" 2>/dev/null; then
  red "AC5: needs-answer haette NICHT gesetzt werden duerfen"
else
  ok "AC5: kein needs-answer gesetzt"
fi

# Die Bau-Rolle bleibt escalation-pflichtig -- #742 aendert nur das Resume,
# nicht buildEscalationEval. Ohne sichtbaren Branch-Fortschritt zaehlt der
# eine (und einzige) Lauf ganz normal als ein Fehlversuch.
assert_eq "AC5: buildEscalationEval zaehlt den einzigen Lauf normal (failcount=1)" \
  "1" "$(cat "$SHARED_DIR/failcount-71" 2>/dev/null | tr -d '[:space:]')"

if [ -f "$SHARED_DIR/tier-71" ]; then
  red "AC5: die Modellstufe haette bei nur einem Fehlversuch NICHT eskalieren duerfen"
else
  ok "AC5: keine Modell-Eskalation ausgeloest"
fi

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Session-Recovery-Tests grün."
else
  red "Mindestens ein Session-Recovery-Test ist rot (siehe oben)."
fi
exit $FAIL
