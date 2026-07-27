#!/usr/bin/env bash
# Tests für ts_run(), die Bruecke zu scripts/runner/cli.ts (issue #198, S1).
#
# Reine Bash-Assertions, kein bats. Sourct claude-runner.sh (Source-Guard haelt
# main() an) -- analog limit-until.test.sh. RUNNER_HOME zeigt auf ein
# Wegwerf-Verzeichnis mit einer STUB-`tsx` unter node_modules/.bin, nicht auf
# das echte cli.ts: hier wird nur die Bash-seitige Verdrahtung geprueft, das
# Verhalten von cli.ts selbst decken die Vitest-Suiten unter scripts/runner/ ab.
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$TEST_DIR/../claude-runner.sh"

FAIL=0
# Jeder Testblock unten laeuft in einer SUBSHELL -- ein dort gesetztes FAIL=1
# erreicht diese Shell nie. Deshalb zusaetzlich eine Flag-Datei, die am Ende
# ausgewertet wird: ohne sie meldete die Suite gruen, obwohl Pruefungen rot
# waren (gefunden in #203, S6).
red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; : > "$FAIL_FLAG"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
FAIL_FLAG="$TMP/failed"

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

# --- Wegwerf-RUNNER_HOME mit funktionierender tsx-Attrappe --------------------
# Seit S6 (#203) loest ts_run den Kern ueber $RUNNER_HOME auf, nicht ueber
# $REPO_DIR -- cli.ts gehoert zum Skript, nicht zum Arbeitsbaum. Die Fixture
# setzt deshalb RUNNER_HOME.
HOME_WITH_TSX="$TMP/home-with-tsx"
mkdir -p "$HOME_WITH_TSX/node_modules/.bin" "$HOME_WITH_TSX/scripts/runner"
cat > "$HOME_WITH_TSX/node_modules/.bin/tsx" <<'STUB'
#!/usr/bin/env bash
touch "$TSX_CALLED_MARKER"
echo "aus-cli-ts"
exit 0
STUB
chmod +x "$HOME_WITH_TSX/node_modules/.bin/tsx"
touch "$HOME_WITH_TSX/scripts/runner/cli.ts"   # nur ein Pfad, der als Argument existieren muss

# --- Wegwerf-RUNNER_HOME OHNE tsx (kaputtes/fehlendes node_modules) ----------
HOME_WITHOUT_TSX="$TMP/home-without-tsx"
mkdir -p "$HOME_WITHOUT_TSX/scripts/runner"

# ==============================================================================
# AC1: ts_run ruft tsx auf, stdout kommt durch, Exit 0.
#
# Der frueher hier gepruefte Kill-Switch aus S1 ist mit S6 (#203) entfallen
# -- es gibt keinen Bash-Rueckfallpfad mehr, auf den er umschalten koennte.
# ==============================================================================
(
  export RUNNER_HOME="$HOME_WITH_TSX"
  export REPO_DIR="$HOME_WITH_TSX"   # haelt cd/STATE_DIR aus dem echten Repo heraus
  export TSX_CALLED_MARKER="$TMP/marker-ac1"
  # shellcheck source=/dev/null
  source "$RUNNER"
  OUT=$(ts_run version)
  RC=$?
  if [ "$RC" -eq 0 ] && [ "$OUT" = "aus-cli-ts" ] && [ -e "$TSX_CALLED_MARKER" ]; then
    ok "AC1: ts_run -> Ausgabe kommt aus cli.ts, Exit 0"
  else
    red "AC1: erwartet Exit 0 + 'aus-cli-ts', bekommen Exit=$RC, out='$OUT', tsx aufgerufen=$([ -e "$TSX_CALLED_MARKER" ] && echo ja || echo nein)"
  fi
)

# ==============================================================================
# AC3: tsx fehlt (kaputtes node_modules) -> Exit 127, UND der Ausfall wird
# hoerbar ueber status() gemeldet (Issue-Kommentar/-Titel), nicht still verworfen.
# ==============================================================================
(
  export RUNNER_HOME="$HOME_WITHOUT_TSX"
  export REPO_DIR="$HOME_WITHOUT_TSX"   # haelt cd/STATE_DIR aus dem echten Repo heraus
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
[ -e "$FAIL_FLAG" ] && FAIL=1
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Runner-TS-Naht-Tests grün."
else
  red "Mindestens ein Runner-TS-Naht-Test ist rot (siehe oben)."
fi
exit $FAIL
