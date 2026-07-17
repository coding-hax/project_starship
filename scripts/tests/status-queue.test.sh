#!/usr/bin/env bash
# Tests für den Queue-Peek des Status-Tickets (Issue #48): queue_pending()
# und queue_next() bekommen das Issue-Snapshot-JSON als Argument, brauchen
# also keinen gh-Stub -- reine Bash-Assertions gegen Fixtures, kein bats.
# Sourct claude-runner.sh (Source-Guard verhindert main()-Autostart).
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$TEST_DIR/../claude-runner.sh"

FAIL=0
red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# --- Stub 'gh'/'claude' --------------------------------------------------
# Nur da, damit der Tool-Check am Kopf von claude-runner.sh beim Sourcen
# nicht abbricht -- queue_pending()/queue_next() rufen 'gh' selbst nicht auf.
FAKEBIN="$TMP/bin"
mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/gh" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cat > "$FAKEBIN/claude" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$FAKEBIN/gh" "$FAKEBIN/claude"
export PATH="$FAKEBIN:$PATH"

export REPO_DIR="$TMP/repo"
mkdir -p "$REPO_DIR"
export STATUS_ISSUE=0
# shellcheck source=/dev/null
source "$RUNNER"

assert_eq() {   # $1 = beschreibung, $2 = erwartet, $3 = tatsaechlich
  if [ "$2" = "$3" ]; then
    ok "$1"
  else
    red "$1 (erwartet '$2', bekommen '$3')"
  fi
}

label() { printf '{"name":"%s"}' "$1"; }   # $1 = Labelname

# ==============================================================================
# 1. Präzedenz: in-progress vor needs-plan vor ready
# ==============================================================================
SNAP='[
  {"number":10,"labels":['"$(label ready)"']},
  {"number":20,"labels":['"$(label needs-plan)"']},
  {"number":30,"labels":['"$(label in-progress)"']}
]'
assert_eq "AC: in-progress schlägt needs-plan und ready" "30" "$(queue_next "$SNAP")"

# ==============================================================================
# 2. needs-input schließt aus (weder queue_next noch queue_pending)
# ==============================================================================
SNAP='[
  {"number":40,"labels":['"$(label ready)"','"$(label needs-input)"']},
  {"number":41,"labels":['"$(label ready)"']}
]'
assert_eq "AC: needs-input-Ticket ist nicht 'als Nächstes'" "41" "$(queue_next "$SNAP")"
assert_eq "AC: needs-input-Ticket zählt nicht zur Pending-Liste" "#41" "$(queue_pending "$SNAP")"

# ==============================================================================
# 3. no-opus-needs-plan zählt in queue_pending, aber NICHT in queue_next
# ==============================================================================
SNAP='[
  {"number":50,"labels":['"$(label needs-plan)"','"$(label no-opus)"']},
  {"number":51,"labels":['"$(label ready)"']}
]'
assert_eq "AC: no-opus-needs-plan wird bei queue_next übersprungen" "51" "$(queue_next "$SNAP")"
assert_eq "AC: no-opus-needs-plan zählt trotzdem als Pending-Arbeit" "#50, #51" "$(queue_pending "$SNAP")"

# ==============================================================================
# 4. Nur needs-research offen -> queue_next leer, queue_pending = "#N"
# ==============================================================================
SNAP='[{"number":60,"labels":['"$(label needs-research)"']}]'
assert_eq "AC: nur needs-research -> queue_next leer" "" "$(queue_next "$SNAP")"
assert_eq "AC: nur needs-research -> queue_pending zeigt Ticket" "#60" "$(queue_pending "$SNAP")"

# ==============================================================================
# 5. Leere Queue -> beide leer
# ==============================================================================
SNAP='[{"number":70,"labels":[]}]'
assert_eq "AC: leere Queue -> queue_next leer" "" "$(queue_next "$SNAP")"
assert_eq "AC: leere Queue -> queue_pending leer" "" "$(queue_pending "$SNAP")"

# ==============================================================================
# 6. Ältestes gewinnt innerhalb einer Stufe
# ==============================================================================
SNAP='[
  {"number":82,"labels":['"$(label ready)"']},
  {"number":81,"labels":['"$(label ready)"']}
]'
assert_eq "AC: innerhalb 'ready' gewinnt das älteste Ticket" "81" "$(queue_next "$SNAP")"

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Status-Queue-Tests grün."
else
  red "Mindestens ein Status-Queue-Test ist rot (siehe oben)."
fi
exit $FAIL
