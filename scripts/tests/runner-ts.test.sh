#!/usr/bin/env bash
# Tests für ts_run(), die Bruecke zu scripts/runner/cli.ts (issue #198, S1).
#
# Reine Bash-Assertions, kein bats. Sourct claude-runner.sh (Source-Guard haelt
# main() an) -- analog limit-until.test.sh. REPO_DIR zeigt auf ein
# Wegwerf-Verzeichnis mit einer STUB-`tsx` unter node_modules/.bin, nicht auf
# das echte cli.ts: hier wird nur die Bash-seitige Verdrahtung geprueft (AC1-3),
# das Verhalten von cli.ts selbst deckt die Vitest-Suite unter scripts/runner/
# ab (AC4-6).
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

# gh-Stub: nur fuer status() gebraucht (AC3) -- protokolliert 'issue edit'.
cat > "$FAKEBIN/gh" <<'STUB'
#!/usr/bin/env bash
G="$GHSTATE_DIR"
mkdir -p "$G"
echo "CALL: $*" >> "$G/calls.log"
case "${1:-} ${2:-}" in
  "issue edit")
    issue="$3"; shift 3
    while [ $# -gt 0 ]; do
      case "$1" in
        --title) echo "$2" > "$G/status-title-$issue"; shift 2 ;;
        --body) echo "$2" > "$G/status-body-$issue"; shift 2 ;;
        *) shift ;;
      esac
    done
    ;;
  *) : ;;
esac
exit 0
STUB
chmod +x "$FAKEBIN/gh"
export PATH="$FAKEBIN:$PATH"

export STATUS_ISSUE=999
export QUEUE_ISSUE=0
export MAX_ROUNDS=1

# --- Wegwerf-REPO_DIR mit funktionierender tsx-Attrappe -----------------------
REPO_WITH_TSX="$TMP/repo-with-tsx"
mkdir -p "$REPO_WITH_TSX/node_modules/.bin" "$REPO_WITH_TSX/scripts/runner"
cat > "$REPO_WITH_TSX/node_modules/.bin/tsx" <<'STUB'
#!/usr/bin/env bash
touch "$TSX_CALLED_MARKER"
echo "aus-cli-ts"
exit 0
STUB
chmod +x "$REPO_WITH_TSX/node_modules/.bin/tsx"
touch "$REPO_WITH_TSX/scripts/runner/cli.ts"   # nur ein Pfad, der als Argument existieren muss

# --- Wegwerf-REPO_DIR OHNE tsx (kaputtes/fehlendes node_modules) -------------
REPO_WITHOUT_TSX="$TMP/repo-without-tsx"
mkdir -p "$REPO_WITHOUT_TSX/scripts/runner"

# ==============================================================================
# AC1: RUNNER_TS unbenannt (Vorgabe an) -> ts_run ruft tsx auf, stdout kommt
# durch, Exit 0.
# ==============================================================================
(
  export REPO_DIR="$REPO_WITH_TSX"
  export TSX_CALLED_MARKER="$TMP/marker-ac1"
  unset RUNNER_TS
  # shellcheck source=/dev/null
  source "$RUNNER"
  OUT=$(ts_run version)
  RC=$?
  if [ "$RC" -eq 0 ] && [ "$OUT" = "aus-cli-ts" ] && [ -e "$TSX_CALLED_MARKER" ]; then
    ok "AC1: RUNNER_TS Vorgabe an -> Ausgabe kommt aus cli.ts, Exit 0"
  else
    red "AC1: erwartet Exit 0 + 'aus-cli-ts', bekommen Exit=$RC, out='$OUT', tsx aufgerufen=$([ -e "$TSX_CALLED_MARKER" ] && echo ja || echo nein)"
  fi
)

# ==============================================================================
# AC2: RUNNER_TS=0 -> Bash-Pfad erzwungen, tsx wird gar nicht gestartet.
# ==============================================================================
(
  export REPO_DIR="$REPO_WITH_TSX"
  export TSX_CALLED_MARKER="$TMP/marker-ac2"
  export RUNNER_TS=0
  # shellcheck source=/dev/null
  source "$RUNNER"
  ts_run version >/dev/null 2>&1
  RC=$?
  if [ "$RC" -eq 127 ] && [ ! -e "$TSX_CALLED_MARKER" ]; then
    ok "AC2: RUNNER_TS=0 -> Exit 127, tsx wurde nicht gestartet"
  else
    red "AC2: erwartet Exit 127 ohne tsx-Aufruf, bekommen Exit=$RC, tsx aufgerufen=$([ -e "$TSX_CALLED_MARKER" ] && echo ja || echo nein)"
  fi
)

# ==============================================================================
# AC3: tsx fehlt (kaputtes node_modules) -> Exit 127, UND der Ausfall wird
# hoerbar ueber status() gemeldet (Issue-Kommentar/-Titel), nicht still verworfen.
# ==============================================================================
(
  export REPO_DIR="$REPO_WITHOUT_TSX"
  rm -rf "$GHSTATE_DIR"; mkdir -p "$GHSTATE_DIR"
  # shellcheck source=/dev/null
  source "$RUNNER"
  ts_run version >/dev/null 2>&1
  RC=$?
  TITLE=$(cat "$GHSTATE_DIR/status-title-999" 2>/dev/null || echo "")
  if [ "$RC" -eq 127 ] && [ -n "$TITLE" ]; then
    ok "AC3: fehlendes tsx -> Exit 127 und status() meldet den Ausfall sichtbar"
  else
    red "AC3: erwartet Exit 127 + status()-Meldung, bekommen Exit=$RC, status-Titel='$TITLE'"
  fi
)

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Runner-TS-Naht-Tests grün."
else
  red "Mindestens ein Runner-TS-Naht-Test ist rot (siehe oben)."
fi
exit $FAIL
