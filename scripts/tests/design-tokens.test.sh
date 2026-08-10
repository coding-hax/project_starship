#!/usr/bin/env bash
# Tests für scripts/check-design-tokens.sh (issue #591, harter Modus #593).
# Reine Bash-Assertions gegen ein Wegwerf-Fixture, kein echter Repo-Zustand
# nötig — SRC_DIR/TOKENS_FILE sind env-überschreibbar genau dafür.
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$TEST_DIR/../check-design-tokens.sh"

FAIL=0
red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/src/ui" "$TMP/src/features/tasks"

# tokens.css selbst trägt rohe Werte (die Token-Definitionen), muss aber
# ignoriert werden — sonst schlägt der Wächter auf sich selbst an.
cat > "$TMP/src/ui/tokens.css" <<'EOF'
:root {
  --text-body: 16px;
  --weight-emphasis: 600;
}
EOF

# Eine Komponente mit einem gepflanzten Rohwert.
cat > "$TMP/src/features/tasks/task-item.css" <<'EOF'
.task-item {
  font-size: 14px;
  font-weight: 600;
}
EOF

# Eine Komponente, die bereits vollständig tokenisiert ist, inklusive
# var(--…)-Fallback — darf nicht anschlagen.
cat > "$TMP/src/ui/tokenized.css" <<'EOF'
.tokenized {
  font-size: var(--text-body);
  line-height: var(--leading-body, 1.5);
}
EOF

OUTPUT=$(env SRC_DIR="$TMP/src" TOKENS_FILE="$TMP/src/ui/tokens.css" bash "$GUARD")
EXIT_CODE=$?

if [ "$EXIT_CODE" -eq 1 ]; then
  ok "AC1: gepflanzter Rohwert lässt den Wächter mit Exit-Code 1 enden."
else
  red "AC1: erwarteter Exit-Code 1, bekommen $EXIT_CODE."
fi

if printf '%s' "$OUTPUT" | grep -q 'task-item.css:2'; then
  ok "AC2: gepflanzter Rohwert (font-size) wird gefunden."
else
  red "AC2: gepflanzter Rohwert (font-size) wurde nicht gefunden."
fi

if printf '%s' "$OUTPUT" | grep -q 'task-item.css:3'; then
  ok "AC3: gepflanzter Rohwert (font-weight) wird gefunden."
else
  red "AC3: gepflanzter Rohwert (font-weight) wurde nicht gefunden."
fi

if printf '%s' "$OUTPUT" | grep -q 'tokens.css:'; then
  red "AC4: tokens.css hätte ignoriert werden müssen, taucht aber in der Ausgabe auf."
else
  ok "AC4: tokens.css wird ignoriert."
fi

if printf '%s' "$OUTPUT" | grep -q 'tokenized.css:'; then
  red "AC5: var(--…) hätte ignoriert werden müssen, taucht aber in der Ausgabe auf."
else
  ok "AC5: var(--…) wird ignoriert (auch mit Fallback-Wert)."
fi

# --- 6. Sauberes Fixture ohne Rohwerte -> keine Fund-Zeile ------------------
TMP2=$(mktemp -d)
mkdir -p "$TMP2/src/ui"
cat > "$TMP2/src/ui/tokens.css" <<'EOF'
:root {
  --text-body: 16px;
}
EOF
mkdir -p "$TMP2/src/clean"
cat > "$TMP2/src/clean/clean.css" <<'EOF'
.clean {
  font-size: var(--text-body);
}
EOF
CLEAN_OUTPUT=$(env SRC_DIR="$TMP2/src" TOKENS_FILE="$TMP2/src/ui/tokens.css" bash "$GUARD")
CLEAN_EXIT_CODE=$?
rm -rf "$TMP2"

if printf '%s' "$CLEAN_OUTPUT" | grep -q 'Keine rohen Typo-Werte'; then
  ok "AC6: sauberes Fixture meldet keine Funde."
else
  red "AC6: sauberes Fixture hätte 'Keine rohen Typo-Werte' melden müssen."
fi

if [ "$CLEAN_EXIT_CODE" -eq 0 ]; then
  ok "AC7: sauberes Fixture endet mit Exit-Code 0."
else
  red "AC7: erwarteter Exit-Code 0, bekommen $CLEAN_EXIT_CODE."
fi

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Design-Token-Guard-Tests grün."
else
  red "Mindestens ein Design-Token-Guard-Test ist rot (siehe oben)."
fi
exit $FAIL
