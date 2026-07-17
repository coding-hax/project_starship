#!/usr/bin/env bash
# Tests für den Resume-Deckel beim Bauen (#62). Reine Bash-Assertions, kein bats
# (keine neue Dependency). Sourct claude-runner.sh (der Source-Guard verhindert,
# dass main() dabei losläuft) und ruft resume_allowed() direkt auf -- reine
# Funktionstests, kein echter Lauf nötig.
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

# Der Tool-Check am Kopf von claude-runner.sh braucht gh/git/claude beim
# Sourcen -- Inhalt ist hier egal, es wird nie main() aufgerufen.
for bin in gh git claude; do
  cat > "$FAKEBIN/$bin" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x "$FAKEBIN/$bin"
done
export PATH="$FAKEBIN:$PATH"

export REPO_DIR="$TMP/repo"
mkdir -p "$REPO_DIR"
export STATUS_ISSUE=0
# shellcheck source=/dev/null
source "$RUNNER"

reset_state() {   # frisches Zustandsverzeichnis für jeden Testfall
  rm -rf "$STATE_DIR"
  mkdir -p "$STATE_DIR"
}

assert_eq() {   # $1 = beschreibung, $2 = erwartet, $3 = tatsaechlich
  if [ "$2" = "$3" ]; then
    ok "$1"
  else
    red "$1 (erwartet '$2', bekommen '$3')"
  fi
}

# ==============================================================================
# 1. Kappt nach 2 Fortsetzungen, dann Reset (Zyklus)
# ==============================================================================
reset_state
ISSUE=201
r1=1; resume_allowed "$ISSUE" && r1=0
r2=1; resume_allowed "$ISSUE" && r2=0
r3=1; resume_allowed "$ISSUE" && r3=0
assert_eq "AC5: 1. Fortsetzung erlaubt" "0" "$r1"
assert_eq "AC5: 2. Fortsetzung erlaubt" "0" "$r2"
assert_eq "AC5: 3. Fortsetzung wird gekappt" "1" "$r3"
assert_eq "AC5: Zähler steht nach dem Kappen wieder auf 0" "0" "$(cat "$STATE_DIR/resume-count-$ISSUE" 2>/dev/null)"

r4=1; resume_allowed "$ISSUE" && r4=0
assert_eq "AC5: nach dem Kappen beginnt ein neuer Zyklus (4. Aufruf erlaubt)" "0" "$r4"

# ==============================================================================
# 2. Reset bei Ticketwechsel -- der Zähler ist je Ticket-Nummer, nicht global
# ==============================================================================
reset_state
resume_allowed 202 >/dev/null
resume_allowed 202 >/dev/null
resume_allowed 999 >/dev/null
assert_eq "AC6: neues Ticket startet unabhängig bei 1" "1" "$(cat "$STATE_DIR/resume-count-999" 2>/dev/null)"
assert_eq "AC6: bestehendes Ticket bleibt von einem anderen Ticket unberührt" "2" "$(cat "$STATE_DIR/resume-count-202" 2>/dev/null)"

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Resume-Deckel-Tests grün."
else
  red "Mindestens ein Resume-Deckel-Test ist rot (siehe oben)."
fi
exit $FAIL
