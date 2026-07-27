#!/usr/bin/env bash
# Tests für die Drift-Erkennung des Shims (issue #252).
#
# Der Shim ist die einzige Komponente, die AUSGEFÜHRT wird, ohne im Repo zu
# liegen -- ausgeführt wird ~/.local/bin/starship-runner, reviewt wird
# scripts/starship-runner. Genau diese Doppelung hat #249 ermöglicht.
#
# Erkannt wird im Shim (shim_drift_reason), gemeldet in claude-runner.sh über
# status(). Beide Hälften werden hier geprüft, inklusive der Zusage, dass ein
# Drift den Lauf NICHT anhält.
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHIM="$TEST_DIR/../starship-runner"
RUNNER="$TEST_DIR/../claude-runner.sh"

FAIL=0
# Jeder Testblock läuft in einer SUBSHELL -- ein dort gesetztes FAIL=1 erreicht
# diese Shell nie. Deshalb zusätzlich die Flag-Datei (Fehler aus #203).
red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; : > "$FAIL_FLAG"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
FAIL_FLAG="$TMP/failed"

# --- Fixture-Repo mit kanonischem Shim ---------------------------------------
FIX="$TMP/repo"
mkdir -p "$FIX/scripts"
(
  cd "$FIX" || exit 1
  git init -q .
  git config user.email test@example.com
  git config user.name Test
  cp "$SHIM" scripts/starship-runner
  git add scripts/starship-runner
  git commit -qm "shim"
) >/dev/null 2>&1

# --- Werkzeug-Attrappen ------------------------------------------------------
FAKEBIN="$TMP/bin"
mkdir -p "$FAKEBIN"
export GHSTATE_DIR="$TMP/ghstate"
mkdir -p "$GHSTATE_DIR"

# gh-Stub: protokolliert 'issue edit', damit A4 den Status-Titel prüfen kann.
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
# A1: Installierte Datei identisch zur kanonischen -> kein Drift.
# ==============================================================================
(
  cd "$FIX" || exit 1
  export REPO_DIR="$FIX"
  export RUNNER_REF="HEAD"
  export SHIM_SELF="$FIX/scripts/starship-runner"
  # shellcheck source=/dev/null
  source "$SHIM"
  set +e   # der Shim setzt `set -e`, das gilt gesourct hier weiter

  REASON=$(shim_drift_reason); RC=$?
  if [ -n "$REASON" ]; then
    red "A1: identische Dateien wurden als Drift gemeldet: '$REASON'"
  elif [ "$RC" -ne 0 ]; then
    red "A1: Exit $RC statt 0"
  else
    ok "A1: identische Dateien -> kein Drift"
  fi
)

# ==============================================================================
# A2: Installierte Datei verändert -> Drift mit Grund.
# ==============================================================================
(
  cd "$FIX" || exit 1
  export REPO_DIR="$FIX"
  export RUNNER_REF="HEAD"
  cp "$SHIM" "$TMP/installed-changed"
  echo "# von Hand geaendert" >> "$TMP/installed-changed"
  export SHIM_SELF="$TMP/installed-changed"
  # shellcheck source=/dev/null
  source "$SHIM"
  set +e

  REASON=$(shim_drift_reason)
  if [ -z "$REASON" ]; then
    red "A2: veränderte Datei wurde NICHT als Drift gemeldet"
  else
    ok "A2: veränderte Datei -> Drift gemeldet"
  fi
)

# ==============================================================================
# A3: Datei fehlt im Ref (älterer main) -> kein Drift, keine Meldung.
#     Sonst schlüge jeder Lauf gegen einen alten Stand Alarm.
# ==============================================================================
(
  EMPTY="$TMP/empty-repo"
  mkdir -p "$EMPTY"
  ( cd "$EMPTY" && git init -q . && git config user.email t@e.de && git config user.name T \
      && echo x > f && git add f && git commit -qm init ) >/dev/null 2>&1

  cd "$EMPTY" || exit 1
  export REPO_DIR="$EMPTY"
  export RUNNER_REF="HEAD"
  export SHIM_SELF="$SHIM"
  # shellcheck source=/dev/null
  source "$SHIM"
  set +e

  REASON=$(shim_drift_reason); RC=$?
  if [ -n "$REASON" ]; then
    red "A3: fehlende Datei im Ref wurde als Drift gemeldet: '$REASON'"
  elif [ "$RC" -ne 0 ]; then
    red "A3: Exit $RC statt 0"
  else
    ok "A3: Datei fehlt im Ref -> kein Fehlalarm"
  fi
)

# ==============================================================================
# A4: Gesetztes SHIM_DRIFT -> status() meldet 🟡 UND der Lauf geht weiter.
#     Der zweite Teil ist der eigentliche Punkt: ein stehender Runner ist
#     teurer als ein abweichender (#249).
# ==============================================================================
(
  export REPO_DIR="$TMP/rundir"
  mkdir -p "$REPO_DIR"
  export STATE_DIR="$TMP/state-a4"
  export STATUS_ISSUE=999
  export QUEUE_ISSUE=0
  export MAX_ROUNDS=0        # Chain-Schleife läuft nicht an, main() endet sauber
  export SHIM_DRIFT="Die laufende Datei weicht ab."
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
    red "A4: Status-Titel trägt kein 🟡: '$TITLE'"
  elif ! printf '%s' "$BODY" | grep -q "install -m 0755"; then
    red "A4: Meldung nennt den Installationsbefehl nicht"
  elif [ "$RC" -ne 0 ]; then
    red "A4: Drift hat den Lauf angehalten (Exit $RC) -- er muss weiterlaufen"
  else
    ok "A4: Drift meldet 🟡 mit Installationsbefehl und hält den Lauf nicht an"
  fi
)

# ==============================================================================
echo
[ -e "$FAIL_FLAG" ] && FAIL=1
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Shim-Drift-Tests grün."
else
  red "Mindestens ein Shim-Drift-Test ist rot (siehe oben)."
fi
exit $FAIL
