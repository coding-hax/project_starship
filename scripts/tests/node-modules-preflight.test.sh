#!/usr/bin/env bash
# Tests für require_resolvable_tsx() (issue #606): ein kaputter Top-Level-
# Symlink in $REPO_DIR/node_modules/tsx soll den Preflight laut abbrechen
# lassen, statt dass ts_run() spaeter mit Exit 1 (statt 127) still stirbt --
# siehe der Vorfall vom 10.08.26 in scripts/claude-runner.sh.
#
# Reine Bash-Assertions, kein bats. Sourct claude-runner.sh (Source-Guard
# haelt main() an) -- Muster wie runner-ts.test.sh: die Funktion wird direkt
# aufgerufen, nicht ueber einen echten Lauf.
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$TEST_DIR/../claude-runner.sh"

FAIL=0
red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; : > "$FAIL_FLAG"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

TMP=$(mktemp -d)
TMP=$(cd "$TMP" && pwd -P)
trap 'rm -rf "$TMP"' EXIT
FAIL_FLAG="$TMP/failed"

FAKEBIN="$TMP/bin"
mkdir -p "$FAKEBIN"
export GHSTATE_DIR="$TMP/ghstate"
mkdir -p "$GHSTATE_DIR"

# gh-Stub: protokolliert 'issue edit --title/--body', wie in runner-ts.test.sh.
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
export MAX_ROUNDS=1

# --- Wegwerf-Baeume ------------------------------------------------------
# 1. Kaputt: node_modules existiert, tsx ist ein toter Symlink.
TREE_BROKEN="$TMP/broken"
mkdir -p "$TREE_BROKEN/node_modules"
ln -s "$TMP/does-not-exist" "$TREE_BROKEN/node_modules/tsx"

# 2. Gesund: node_modules/tsx/package.json ist eine echte Datei.
TREE_HEALTHY="$TMP/healthy"
mkdir -p "$TREE_HEALTHY/node_modules/tsx"
echo '{}' > "$TREE_HEALTHY/node_modules/tsx/package.json"

# 3. Ganz fehlend: kein node_modules ueberhaupt.
TREE_MISSING="$TMP/missing"
mkdir -p "$TREE_MISSING"

# ==============================================================================
# AK3 (Negativ): toter tsx-Symlink -> Exit != 0 UND status()-Meldung mit dem
# woertlichen Reparaturbefehl.
# ==============================================================================
(
  export REPO_DIR="$TREE_BROKEN"
  export STATE_DIR="$TMP/state-broken"
  export SHARED_DIR="$TMP/shared-broken"
  rm -rf "$GHSTATE_DIR"; mkdir -p "$GHSTATE_DIR"
  # shellcheck source=/dev/null
  source "$RUNNER"
  require_resolvable_tsx
  RC=$?
  BODY=$(cat "$GHSTATE_DIR/status-body-999" 2>/dev/null || echo "")
  if [ "$RC" -ne 0 ] && printf '%s' "$BODY" | grep -qF 'CI=true pnpm install --prefer-offline'; then
    ok "AK3 Negativ: toter tsx-Symlink -> Abbruch + Statusmeldung mit Reparaturbefehl"
  else
    red "AK3 Negativ: erwartet Exit != 0 + Meldung mit 'CI=true pnpm install --prefer-offline', bekommen Exit=$RC, body='$BODY'"
  fi
)

# ==============================================================================
# AK3 (Positiv): gesunder Baum -> Exit 0, keine Statusmeldung. Belegt, dass der
# Preflight einen normalen Lauf nicht blockiert (sensibler Pfad, #606-Hinweis).
# ==============================================================================
(
  export REPO_DIR="$TREE_HEALTHY"
  export STATE_DIR="$TMP/state-healthy"
  export SHARED_DIR="$TMP/shared-healthy"
  rm -rf "$GHSTATE_DIR"; mkdir -p "$GHSTATE_DIR"
  # shellcheck source=/dev/null
  source "$RUNNER"
  require_resolvable_tsx
  RC=$?
  TITLE=$(cat "$GHSTATE_DIR/status-title-999" 2>/dev/null || echo "")
  if [ "$RC" -eq 0 ] && [ -z "$TITLE" ]; then
    ok "AK3 Positiv: gesunder Baum -> Preflight laesst durch, keine Meldung"
  else
    red "AK3 Positiv: erwartet Exit 0 + keine Meldung, bekommen Exit=$RC, status-Titel='$TITLE'"
  fi
)

# ==============================================================================
# AK3 (Fehlend): kein node_modules ueberhaupt -> Exit 0, keine Statusmeldung
# (Deferral an den bestehenden Exit-127-Pfad in ts_run(), z.B. frisch geklonte
# Baeume in anderen Testsuiten).
# ==============================================================================
(
  export REPO_DIR="$TREE_MISSING"
  export STATE_DIR="$TMP/state-missing"
  export SHARED_DIR="$TMP/shared-missing"
  rm -rf "$GHSTATE_DIR"; mkdir -p "$GHSTATE_DIR"
  # shellcheck source=/dev/null
  source "$RUNNER"
  require_resolvable_tsx
  RC=$?
  TITLE=$(cat "$GHSTATE_DIR/status-title-999" 2>/dev/null || echo "")
  if [ "$RC" -eq 0 ] && [ -z "$TITLE" ]; then
    ok "AK3 Fehlend: kein node_modules -> Preflight laesst durch (Deferral), keine Meldung"
  else
    red "AK3 Fehlend: erwartet Exit 0 + keine Meldung, bekommen Exit=$RC, status-Titel='$TITLE'"
  fi
)

# ==============================================================================
echo
[ -e "$FAIL_FLAG" ] && FAIL=1
if [ "$FAIL" -eq 0 ]; then
  ok "Alle node-modules-Preflight-Tests grün."
else
  red "Mindestens ein node-modules-Preflight-Test ist rot (siehe oben)."
fi
exit $FAIL
