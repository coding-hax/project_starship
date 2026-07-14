#!/usr/bin/env bash
# Wächter gegen aufgeweichte Tests.
# Läuft in der CI als Required Check. Kein Modell beteiligt — reine Textprüfung.
set -uo pipefail

BASE="${1:-origin/main}"
FAIL=0

red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

# --- 1. Verbotene Muster in Tests -------------------------------------------
# .only  -> lässt alle anderen Tests still verstummen
# .skip / xit / fixme -> deaktiviert Tests
# waitForTimeout -> "Fix" durch Warten statt durch Ursachenbehebung
PATTERNS='\.only\(|\.skip\(|\bxit\(|\bxdescribe\(|test\.fixme|waitForTimeout'

if grep -rEn "$PATTERNS" tests/ src/ --include='*.spec.ts' --include='*.test.ts' 2>/dev/null; then
  red "Verbotenes Muster in Tests gefunden (siehe oben)."
  echo "  Tests werden nicht abgeschaltet, um grün zu werden. Ursache beheben."
else
  ok "Keine deaktivierten oder aufgeweichten Tests."
fi

# --- 2. Testanzahl darf nicht sinken ----------------------------------------
count_tests() {   # $1 = git-ref
  git grep -hE "^\s*(test|it)\(" "$1" -- '*.spec.ts' '*.test.ts' 2>/dev/null | wc -l
}

BEFORE=$(count_tests "$BASE")
AFTER=$(count_tests HEAD)

echo "Tests: $BEFORE (main) → $AFTER (dieser Branch)"

if [ "$AFTER" -lt "$BEFORE" ]; then
  red "Die Testanzahl ist gesunken ($BEFORE → $AFTER)."
  echo "  Wenn ein Test wirklich obsolet ist, gehört das ins Ticket und braucht"
  echo "  eine menschliche Freigabe (Label 'human-approved')."
else
  ok "Testanzahl gehalten oder gestiegen."
fi

# --- 3. Ein Feature-PR ohne neuen Test ist verdächtig ------------------------
CHANGED_SRC=$(git diff --name-only "$BASE"...HEAD -- 'src/**/*.ts' 'src/**/*.tsx' | grep -v '\.spec\.' | wc -l)
CHANGED_TESTS=$(git diff --name-only "$BASE"...HEAD -- '*.spec.ts' '*.test.ts' | wc -l)

if [ "$CHANGED_SRC" -gt 0 ] && [ "$CHANGED_TESTS" -eq 0 ]; then
  red "Code geändert ($CHANGED_SRC Dateien), aber kein Test angefasst."
  echo "  Jedes Akzeptanzkriterium braucht einen Test."
else
  ok "Code- und Teständerungen passen zusammen."
fi

exit $FAIL
