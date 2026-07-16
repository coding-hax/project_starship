#!/usr/bin/env bash
# Tests für die Ticket-Auswahl der Recherche-Rolle (needs-research, ADR-0005,
# Issue #43). Reine Bash-Assertions, kein bats (keine neue Dependency).
# Sourct claude-runner.sh (Source-Guard verhindert, dass main() dabei
# losläuft) und stubbt gh/git/claude per PATH-Shim in einem
# Wegwerf-Zustandsverzeichnis — analog zu scripts/tests/escalation.test.sh,
# aber mit einem allgemeineren 'gh issue list -q ...'-Stub, weil hier die
# echte Auswahlkaskade (needs-plan > needs-research > ready) durchlaufen wird,
# nicht nur einzelne Funktionen.
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
# Deckt genau die Aufrufe ab, die die Ticket-Auswahl in main() macht:
# 'issue list --label <L> [--json J] [-q Q]' liest die Antwort aus
# $G/list-<L>.json und wendet -- falls -q gesetzt ist -- echtes jq darauf an,
# genau wie das echte 'gh'. 'issue view --json labels -q ...' und
# 'issue edit'/'issue comment' analog zu escalation.test.sh.
cat > "$FAKEBIN/gh" <<'STUB'
#!/usr/bin/env bash
G="$GHSTATE_DIR"
mkdir -p "$G"

case "${1:-} ${2:-}" in
  "issue list")
    shift 2
    label=""; json=""; q=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --label) label="$2"; shift 2 ;;
        --json) json="$2"; shift 2 ;;
        -q) q="$2"; shift 2 ;;
        --state|--limit) shift 2 ;;
        *) shift ;;
      esac
    done
    data=$(cat "$G/list-$label.json" 2>/dev/null || echo '[]')
    if [ -n "$q" ]; then
      printf '%s' "$data" | jq -r "$q"
    else
      printf '%s' "$data"
    fi
    ;;
  "issue view")
    issue="$3"; shift 3
    json=""; q=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --json) json="$2"; shift 2 ;;
        -q) q="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    data=$(cat "$G/view-$issue.json" 2>/dev/null || echo '{"labels":[]}')
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
    printf '%s' "$body" > "$G/lastcomment-$issue"
    ;;
  *) ;;
esac
exit 0
STUB

# --- Stub 'git' ----------------------------------------------------------------
# Nur so viel wie main() im Denk-Pfad braucht: 'status --porcelain' (sauberer
# Baum per Default) fürs Read-only-Netz, 'checkout'/'clean' als No-Ops.
cat > "$FAKEBIN/git" <<'STUB'
#!/usr/bin/env bash
G="$GHSTATE_DIR"
case "${1:-}" in
  status) [ -f "$G/dirty-flag" ] && echo " M dirty-file.txt"; exit 0 ;;
  *) exit 0 ;;
esac
STUB

# --- Stub 'claude' ---------------------------------------------------------
# Schreibt die vollständige Argumentliste weg, damit die Tests prüfen können,
# mit welchem Prompt/Modell/Werkzeugsatz der Lauf tatsächlich gestartet wurde
# -- das ist die einzige Stelle, an der RUN_ROLE (lokal in main()) von außen
# sichtbar wird.
cat > "$FAKEBIN/claude" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$GHSTATE_DIR/claude-lastargs"
printf '%s' '{"session_id":"stub-session","result":"ok"}'
exit 0
STUB

chmod +x "$FAKEBIN/gh" "$FAKEBIN/git" "$FAKEBIN/claude"
export PATH="$FAKEBIN:$PATH"

export REPO_DIR="$TMP/repo"
mkdir -p "$REPO_DIR"
export STATUS_ISSUE=0
# shellcheck source=/dev/null
source "$RUNNER"

reset_state() {
  rm -rf "$STATE_DIR" "$GHSTATE_DIR"
  mkdir -p "$STATE_DIR" "$GHSTATE_DIR"
}

list_json() {   # $1 = Label, $2 = JSON-Array-Inhalt (roh)
  printf '%s' "$2" > "$GHSTATE_DIR/list-$1.json"
}

run_main() { ( main ) >/dev/null 2>&1; }

assert_session() {   # $1 = Beschreibung, $2 = erwartete Issue-Nr (welche verarbeitet wurde)
  if [ -s "$STATE_DIR/session-$2" ]; then
    ok "$1"
  else
    red "$1 (kein session-$2 angelegt — falsches Ticket gewählt?)"
  fi
}

assert_absent() {
  if [ ! -e "$2" ]; then
    ok "$1"
  else
    red "$1 (Datei existiert unerwartet: $2)"
  fi
}

assert_contains() {   # $1 = Beschreibung, $2 = Datei, $3 = erwarteter Substring
  if [ -f "$2" ] && grep -qF -- "$3" "$2"; then
    ok "$1"
  else
    red "$1 (Substring '$3' fehlt in $2)"
  fi
}

assert_not_contains() {
  if [ ! -f "$2" ] || ! grep -qF -- "$3" "$2"; then
    ok "$1"
  else
    red "$1 (Substring '$3' unerwartet in $2)"
  fi
}

# ==============================================================================
# 1. needs-plan hat Vorrang vor needs-research (auch bei niedrigerer Nummer)
# ==============================================================================
reset_state
list_json in-progress '[]'
list_json needs-plan     '[{"number":60,"labels":[{"name":"needs-plan"}]}]'
list_json needs-research '[{"number":10,"labels":[{"name":"needs-research"}]}]'
list_json ready '[]'
list_json needs-input '[]'
run_main
assert_session "AC1: needs-plan (#60) wird vor needs-research (#10) gewählt" 60
assert_absent  "AC1: needs-research-Ticket #10 bleibt unangetastet" "$STATE_DIR/session-10"
assert_contains "AC1: Planer-Prompt läuft mit Opus" "$GHSTATE_DIR/claude-lastargs" "--model"

# ==============================================================================
# 2. needs-research wird gewählt, wenn kein needs-plan ansteht -- Opus,
#    WebSearch erlaubt, Recherche-Prompt (nicht der Planer-Prompt)
# ==============================================================================
reset_state
list_json in-progress '[]'
list_json needs-plan '[]'
list_json needs-research '[{"number":47,"labels":[{"name":"needs-research"}]}]'
list_json ready '[]'
list_json needs-input '[]'
run_main
assert_session "AC2: needs-research-Ticket #47 wird verarbeitet" 47
assert_contains "AC2: Modell ist Opus" "$GHSTATE_DIR/claude-lastargs" "opus"
assert_contains "AC2: WebSearch ist erlaubt (bounded Web-Recherche)" "$GHSTATE_DIR/claude-lastargs" "WebSearch"
assert_contains "AC2: Recherche-Prompt (Feature-Rechercheur) wird benutzt" "$GHSTATE_DIR/claude-lastargs" "Feature-Rechercheur"
assert_not_contains "AC2: Kein Edit/Write-Zugriff (nur lesend)" "$GHSTATE_DIR/claude-lastargs" "Edit,Write"

# ==============================================================================
# 3. Kill-Switch no-opus überspringt das needs-research-Ticket komplett --
#    fällt durch auf ein wartendes "ready"-Ticket (Bau-Rolle)
# ==============================================================================
reset_state
list_json in-progress '[]'
list_json needs-plan '[]'
list_json needs-research '[{"number":47,"labels":[{"name":"needs-research"},{"name":"no-opus"}]}]'
list_json ready '[{"number":48,"labels":[{"name":"ready"}]}]'
list_json needs-input '[]'
run_main
assert_session "AC3: no-opus überspringt #47, #48 (ready) wird gebaut" 48
assert_absent  "AC3: #47 bleibt unangetastet" "$STATE_DIR/session-47"
assert_contains "AC3: #48 bekommt in-progress" "$GHSTATE_DIR/applied-48" "ADD:in-progress"

# ==============================================================================
# 4. Inkonsistentes Ticket (needs-research UND ready gleichzeitig) wird über
#    den Recherche-Zweig gefangen, nicht als Bau-Ticket behandelt
# ==============================================================================
reset_state
list_json in-progress '[]'
list_json needs-plan '[]'
list_json needs-research '[{"number":50,"labels":[{"name":"needs-research"},{"name":"ready"}]}]'
list_json ready '[{"number":50,"labels":[{"name":"needs-research"},{"name":"ready"}]}]'
list_json needs-input '[]'
run_main
assert_session "AC4: #50 wird über needs-research verarbeitet" 50
assert_not_contains "AC4: #50 bekommt KEIN in-progress (kein Bau-Zweig)" "$GHSTATE_DIR/applied-50" "ADD:in-progress"

# ==============================================================================
# 5. Resumability: vorhandene Session-Datei -> --resume statt Neustart
# ==============================================================================
reset_state
list_json in-progress '[]'
list_json needs-plan '[]'
list_json needs-research '[{"number":47,"labels":[{"name":"needs-research"}]}]'
list_json ready '[]'
list_json needs-input '[]'
echo "sess-abc123" > "$STATE_DIR/session-47"
run_main
assert_contains "AC5: Lauf mit vorhandener Session nutzt --resume" "$GHSTATE_DIR/claude-lastargs" "sess-abc123"

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Recherche-Modus-Tests grün."
else
  red "Mindestens ein Recherche-Modus-Test ist rot (siehe oben)."
fi
exit $FAIL
