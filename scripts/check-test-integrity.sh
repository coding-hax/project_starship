#!/usr/bin/env bash
# Wächter gegen aufgeweichte Tests.
# Läuft in der CI als Required Check. Kein Modell beteiligt — reine Textprüfung.
set -uo pipefail

BASE="${1:-origin/main}"
TESTS_EXEMPT="${2:-${TESTS_EXEMPT:-}}"
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
  # POSIX-ERE (git grep -E) kennt \s nicht -- das matcht dort ein literales
  # "s", kein Whitespace. [[:space:]] ist die portable POSIX-Klasse.
  git grep -hE "^[[:space:]]*(test|it)\(" "$1" -- '*.spec.ts' '*.test.ts' 2>/dev/null | wc -l
}

BEFORE=$(count_tests "$BASE")
AFTER=$(count_tests HEAD)

echo "Tests: $BEFORE (main) → $AFTER (dieser Branch)"

if [ "$AFTER" -lt "$BEFORE" ]; then
  if [ -n "$TESTS_EXEMPT" ]; then
    ok "Testanzahl gesunken ($BEFORE → $AFTER), aber durch Label 'tests-exempt' freigegeben."
  else
    red "Die Testanzahl ist gesunken ($BEFORE → $AFTER)."
    echo "  Wenn ein Test wirklich obsolet ist, gehört das ins Ticket und braucht"
    echo "  eine Begründung am Ticket — der Check bleibt rot, bis die Zahl stimmt."
  fi
else
  ok "Testanzahl gehalten oder gestiegen."
fi

# --- 3. Ein Feature-PR ohne neuen Test ist verdächtig ------------------------
CHANGED_SRC=$(git diff --name-only "$BASE"...HEAD -- 'src/**/*.ts' 'src/**/*.tsx' | grep -v '\.spec\.' | grep -v '\.d\.ts$' | wc -l)
CHANGED_TESTS=$(git diff --name-only "$BASE"...HEAD -- '*.spec.ts' '*.test.ts' | wc -l)

if [ "$CHANGED_SRC" -gt 0 ] && [ "$CHANGED_TESTS" -eq 0 ]; then
  if [ -n "$TESTS_EXEMPT" ]; then
    ok "Testlose Änderung durch Label 'tests-exempt' freigegeben."
  else
    red "Code geändert ($CHANGED_SRC Dateien), aber kein Test angefasst."
    echo "  Jedes Akzeptanzkriterium braucht einen Test."
  fi
else
  ok "Code- und Teständerungen passen zusammen."
fi

# --- 4. Keine rohe Wanduhr in Specs (#495) -----------------------------------
# new Date() ohne Argument liest die echte Systemzeit -> Mitternachts-/DST-Flakes.
# new Date(irgendwas) ist erlaubt (siehe FIXED_NOW/installClockAt in helpers.ts).
# Scope bewusst nur *.spec.ts: helpers.ts (installClockAt selbst) und
# global-setup.ts (Lock-Zeitstempel, echte Wanduhr korrekt) bleiben aussen vor.
DATE_PATTERN='new[[:space:]]*Date\([[:space:]]*\)'

if grep -rEn "$DATE_PATTERN" tests/ --include='*.spec.ts' 2>/dev/null; then
  red "Rohe Wanduhr (new Date() ohne Argument) in einem Spec gefunden (siehe oben)."
  echo "  FIXED_NOW/installClockAt aus tests/helpers.ts benutzen statt der echten Uhr."
else
  ok "Keine rohe Wanduhr in Specs."
fi

exit $FAIL
