#!/usr/bin/env bash
# Test für die Shim-Drift-MELDUNG (issue #252).
#
# Die Entscheidung selbst liegt im TS-Kern (scripts/runner/shim.ts, dort die
# Vitest-Suite). Hier wird nur die Bash-Seite geprüft, die es nicht in TypeScript
# gibt: dass claude-runner.sh den Kern fragt, aus einer Antwort eine 🟡-Meldung
# macht -- und den Lauf trotzdem NICHT anhält.
#
# Das läuft bewusst gegen den echten Kern, nicht gegen eine ts_run-Attrappe:
# genau die Verdrahtung war bei #249 kaputt, und eine Attrappe hätte das nicht
# gezeigt.
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$TEST_DIR/../claude-runner.sh"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd -P)"

FAIL=0
# Jeder Testblock läuft in einer SUBSHELL -- ein dort gesetztes FAIL=1 erreicht
# diese Shell nie. Deshalb zusätzlich die Flag-Datei (Fehler aus #203).
red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; : > "$FAIL_FLAG"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
FAIL_FLAG="$TMP/failed"

# --- Werkzeug-Attrappen ------------------------------------------------------
FAKEBIN="$TMP/bin"
mkdir -p "$FAKEBIN"
export GHSTATE_DIR="$TMP/ghstate"
mkdir -p "$GHSTATE_DIR"

# gh-Stub: protokolliert 'issue edit', damit der Status-Titel prüfbar ist.
cat > "$FAKEBIN/gh" <<'STUB'
#!/usr/bin/env bash
G="$GHSTATE_DIR"
mkdir -p "$G"
case "${1:-} ${2:-}" in
  "issue edit")
    issue="$3"; shift 3
    while [ $# -gt 0 ]; do
      case "$1" in
        --title) echo "$2" > "$G/status-title-$issue"; shift 2 ;;
        --body)  echo "$2" > "$G/status-body-$issue";  shift 2 ;;
        *) shift ;;
      esac
    done
    ;;
  *) : ;;
esac
exit 0
STUB
chmod +x "$FAKEBIN/gh"
for tool in jq claude; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKEBIN/$tool"
  chmod +x "$FAKEBIN/$tool"
done
export PATH="$FAKEBIN:$PATH"

# ==============================================================================
# T1: Abweichende installierte Datei -> 🟡 mit Installationsbefehl,
#     UND der Lauf endet trotzdem sauber (Exit 0).
#
#     Der zweite Teil ist der eigentliche Punkt: nach #249 ist ein stehender
#     Runner teurer als ein abweichender.
# ==============================================================================
(
  cd "$REPO_ROOT" || exit 1
  export REPO_DIR="$REPO_ROOT"
  export RUNNER_HOME="$REPO_ROOT"
  export RUNNER_REF="HEAD"
  export STATE_DIR="$TMP/state-t1"
  export STATUS_ISSUE=999
  export QUEUE_ISSUE=0
  export MAX_ROUNDS=0        # Chain-Schleife läuft nicht an, main() endet sauber

  # Installierte Fassung: die kanonische aus dem REF plus eine Zeile.
  # Bewusst aus `git show` und nicht aus dem Arbeitsbaum -- sonst haengt der Test
  # daran, ob die Datei gerade uncommittete Aenderungen hat.
  git show "HEAD:scripts/starship-runner" > "$TMP/installed-changed"
  echo "# von Hand geaendert" >> "$TMP/installed-changed"
  export SHIM_PATH="$TMP/installed-changed"

  # shellcheck source=/dev/null
  source "$RUNNER"
  set +e

  # main() endet mit `exit` -- direkt aufgerufen nähme es diese Subshell mit und
  # keine Assertion unten liefe je. Deshalb eine Ebene tiefer; der gh-Stub
  # schreibt seinen Zustand ohnehin auf Platte.
  ( main ) >/dev/null 2>&1; RC=$?
  TITLE=$(cat "$GHSTATE_DIR/status-title-999" 2>/dev/null || echo "")
  BODY=$(cat "$GHSTATE_DIR/status-body-999" 2>/dev/null || echo "")

  if ! printf '%s' "$TITLE" | grep -q "🟡"; then
    red "T1: Status-Titel trägt kein 🟡: '$TITLE'"
  elif ! printf '%s' "$BODY" | grep -q "install -m 0755"; then
    red "T1: Meldung nennt den Installationsbefehl nicht"
  elif [ "$RC" -ne 0 ]; then
    red "T1: Drift hat den Lauf angehalten (Exit $RC) -- er muss weiterlaufen"
  else
    ok "T1: Drift meldet 🟡 mit Installationsbefehl und hält den Lauf nicht an"
  fi
)

# ==============================================================================
# T2: Identische installierte Datei -> keine Meldung.
#     Ein Daueralarm wäre schlimmer als keiner -- er wird weggeschaut.
# ==============================================================================
(
  cd "$REPO_ROOT" || exit 1
  export REPO_DIR="$REPO_ROOT"
  export RUNNER_HOME="$REPO_ROOT"
  export RUNNER_REF="HEAD"
  export STATE_DIR="$TMP/state-t2"
  export STATUS_ISSUE=888
  export QUEUE_ISSUE=0
  export MAX_ROUNDS=0
  # Exakt der Ref-Stand -- unabhaengig vom Arbeitsbaum. Nebenbei deckt das die
  # Newline-Normalisierung ab: `git show` haengt ein \n an, der git-Adapter
  # schneidet es ab.
  git show "HEAD:scripts/starship-runner" > "$TMP/installed-clean"
  export SHIM_PATH="$TMP/installed-clean"

  # shellcheck source=/dev/null
  source "$RUNNER"
  set +e

  ( main ) >/dev/null 2>&1
  TITLE=$(cat "$GHSTATE_DIR/status-title-888" 2>/dev/null || echo "")

  if printf '%s' "$TITLE" | grep -q "weicht ab"; then
    red "T2: identische Datei wurde als Drift gemeldet: '$TITLE'"
  else
    ok "T2: identische Datei -> keine Drift-Meldung"
  fi
)

# ==============================================================================
echo
[ -e "$FAIL_FLAG" ] && FAIL=1
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Shim-Drift-Meldungstests grün."
else
  red "Mindestens ein Shim-Drift-Meldungstest ist rot (siehe oben)."
fi
exit $FAIL
