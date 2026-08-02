#!/usr/bin/env bash
# Tests für scripts/git-hooks/pre-push (#449, ADR-0020): das Push-Netz gegen
# Doppelbau. Simuliert den Hook direkt in einem Wegwerf-Repo mit temporärem
# SHARED_DIR -- kein echter `git push` nötig, der Hook prüft nur Branch +
# Claim-Datei, nie Refs von stdin.
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$TEST_DIR/../git-hooks/pre-push"

FAIL=0
red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

REPO=$(mktemp -d)
SHARED=$(mktemp -d)
trap 'rm -rf "$REPO" "$SHARED"' EXIT

cd "$REPO" || exit 1
git init --quiet -b main
git config user.email "test@example.com"
git config user.name "test"
git commit --quiet --allow-empty -m "base"
git checkout --quiet -b feat/430-x

run_hook() {
  env -u STATE_DIR -u REPO_DIR "$@" sh "$HOOK" </dev/null
}

# --- (a) Claim gehört einem ANDEREN Slot -> Push bricht ab -------------------
mkdir -p "$SHARED/claims/430"
echo -n "2" > "$SHARED/claims/430/slot"
OUT=$(run_hook env SHARED_DIR="$SHARED" SLOT_ID=1 2>&1)
CODE=$?
if [ "$CODE" -eq 1 ] && echo "$OUT" | grep -q '#430'; then
  ok "(a) fremder Claim (slot=2, SLOT_ID=1) -> Push bricht ab (exit 1)"
else
  red "(a) erwartet exit 1 mit Hinweis auf #430, bekommen exit=$CODE, out=$OUT"
fi

# --- (b) Claim gehört diesem Slot -> Push geht durch -------------------------
run_hook env SHARED_DIR="$SHARED" SLOT_ID=2
CODE=$?
if [ "$CODE" -eq 0 ]; then
  ok "(b) eigener Claim (slot=2, SLOT_ID=2) -> Push geht durch (exit 0)"
else
  red "(b) erwartet exit 0, bekommen exit=$CODE"
fi

# --- (c) Claim-Datei fehlt -> Push geht durch (fail-open) --------------------
rm -rf "$SHARED/claims/430"
run_hook env SHARED_DIR="$SHARED" SLOT_ID=1
CODE=$?
if [ "$CODE" -eq 0 ]; then
  ok "(c) keine Claim-Datei -> Push geht durch (exit 0)"
else
  red "(c) erwartet exit 0, bekommen exit=$CODE"
fi

# --- (d) kein Runner-Kontext (SHARED_DIR/SLOT_ID leer) -> Push geht durch ----
mkdir -p "$SHARED/claims/430"
echo -n "2" > "$SHARED/claims/430/slot"
OUT=$(env -u STATE_DIR -u REPO_DIR -u SHARED_DIR -u SLOT_ID sh "$HOOK" </dev/null)
CODE=$?
if [ "$CODE" -eq 0 ]; then
  ok "(d) kein SHARED_DIR/SLOT_ID (Mensch/lokal) -> Push geht durch (exit 0)"
else
  red "(d) erwartet exit 0, bekommen exit=$CODE, out=$OUT"
fi

# --- (e) Branch ohne Ticketnummer -> Push geht durch -------------------------
git checkout --quiet -b chore/ohne-nummer
run_hook env SHARED_DIR="$SHARED" SLOT_ID=1
CODE=$?
if [ "$CODE" -eq 0 ]; then
  ok "(e) Branch ohne Ticketnummer -> Push geht durch (exit 0)"
else
  red "(e) erwartet exit 0, bekommen exit=$CODE"
fi

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Push-Guard-Tests grün."
else
  red "Mindestens ein Push-Guard-Test ist rot (siehe oben)."
fi
exit $FAIL
