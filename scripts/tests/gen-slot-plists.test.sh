#!/usr/bin/env bash
# Tests für scripts/gen-slot-plists.sh (#204, E7): der Plist-Generator schreibt
# nur Dateien, laedt/installiert nichts von selbst.
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GEN="$TEST_DIR/../gen-slot-plists.sh"

FAIL=0
red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# --- AC: drei Plists, Slot 1 behaelt REPO_DIR, Slot 2/3 bekommen eigene Clones ---
OUT="$TMP/three"
if SLOT_COUNT=3 STATUS_ISSUE=42 LEAD_SLOT=1 REPO_DIR="$TMP/existing-repo" \
    SLOT_BASE="$TMP/dev" SHARED_DIR="$TMP/shared" bash "$GEN" "$OUT" >/dev/null 2>&1; then
  [ -f "$OUT/de.starship.runner.slot-1.plist" ] && ok "AC1: Slot-1-Plist wird erzeugt" \
    || red "AC1: Slot-1-Plist fehlt"
  [ -f "$OUT/de.starship.runner.slot-3.plist" ] && ok "AC1: Slot-3-Plist wird erzeugt" \
    || red "AC1: Slot-3-Plist fehlt"

  grep -q "<string>$TMP/existing-repo</string>" "$OUT/de.starship.runner.slot-1.plist" \
    && ok "AC2: Slot 1 nutzt den vorhandenen REPO_DIR, kein neuer Clone" \
    || red "AC2: Slot 1 zeigt nicht auf den vorhandenen Checkout"

  grep -q "<string>$TMP/dev/starship-slot-2</string>" "$OUT/de.starship.runner.slot-2.plist" \
    && ok "AC3: Slot 2 bekommt einen eigenen Clone-Pfad" \
    || red "AC3: Slot 2 zeigt nicht auf starship-slot-2"

  for n in 1 2 3; do
    grep -q "<key>SLOT_ID</key>" "$OUT/de.starship.runner.slot-$n.plist" \
      && grep -A1 "<key>SLOT_ID</key>" "$OUT/de.starship.runner.slot-$n.plist" | grep -q "<string>$n</string>" \
      && ok "AC4: Slot $n traegt SLOT_ID=$n" \
      || red "AC4: Slot $n traegt nicht SLOT_ID=$n"
  done

  # STATUS_ISSUE ist das EINE aggregierte Issue -- identisch in allen drei Plists.
  for n in 1 2 3; do
    grep -A1 "<key>STATUS_ISSUE</key>" "$OUT/de.starship.runner.slot-$n.plist" | grep -q "<string>42</string>" \
      && ok "AC5: Slot $n zeigt auf dasselbe aggregierte Status-Issue (42)" \
      || red "AC5: Slot $n zeigt nicht auf Status-Issue 42"
  done

  # Ab mehr als einem Slot rueckt das gh-API-Limit in Reichweite -- 300s statt 60s.
  grep -A1 "StartInterval" "$OUT/de.starship.runner.slot-1.plist" | grep -q "<integer>300</integer>" \
    && ok "AC6: StartInterval steht bei SLOT_COUNT=3 auf 300s" \
    || red "AC6: StartInterval ist nicht auf 300s hochgesetzt"
else
  red "Generator ist mit SLOT_COUNT=3 fehlgeschlagen"
fi

# --- AC: SLOT_COUNT=1 -- Takt bleibt 60s (Standardfall unveraendert) ---
OUT1="$TMP/one"
SLOT_COUNT=1 STATUS_ISSUE=1 REPO_DIR="$TMP/existing-repo" SHARED_DIR="$TMP/shared" \
  bash "$GEN" "$OUT1" >/dev/null 2>&1
grep -A1 "StartInterval" "$OUT1/de.starship.runner.slot-1.plist" | grep -q "<integer>60</integer>" \
  && ok "AC7: SLOT_COUNT=1 behaelt den 60s-Takt" \
  || red "AC7: SLOT_COUNT=1 aendert faelschlich den Takt"

# --- AK8 (wie im Runner selbst): Deckel gegen Vertipper ---
if SLOT_COUNT=11 STATUS_ISSUE=1 bash "$GEN" "$TMP/eleven" >/dev/null 2>&1; then
  red "AK8: SLOT_COUNT=11 haette abbrechen muessen"
else
  ok "AK8: SLOT_COUNT=11 bricht mit Fehler ab (Deckel 10)"
fi

if SLOT_COUNT=abc STATUS_ISSUE=1 bash "$GEN" "$TMP/nan" >/dev/null 2>&1; then
  red "AK8: SLOT_COUNT=abc haette abbrechen muessen"
else
  ok "AK8: SLOT_COUNT=abc (keine Zahl) bricht mit Fehler ab"
fi

# --- Der Generator laedt/installiert nichts von selbst -----------------------
# Ein 'launchctl'-Stub im PATH: schreibt jeden Aufruf mit, statt echt zu laden.
# Die NOTE am Ende des Skripts NENNT 'launchctl load' als naechsten Handgriff
# (Text auf stdout) -- ein Textmatch im Skript selbst wuerde das faelschlich
# als Verstoss werten. Nur ein tatsaechlicher Aufruf zaehlt.
FAKEBIN="$TMP/fakebin"
mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/launchctl" <<'STUB'
#!/usr/bin/env bash
echo "$@" >> "$LAUNCHCTL_CALLS"
STUB
chmod +x "$FAKEBIN/launchctl"
export LAUNCHCTL_CALLS="$TMP/launchctl-calls.log"
: > "$LAUNCHCTL_CALLS"

PATH="$FAKEBIN:$PATH" SLOT_COUNT=2 STATUS_ISSUE=1 REPO_DIR="$TMP/existing-repo" \
  SHARED_DIR="$TMP/shared" bash "$GEN" "$TMP/no-launch" >/dev/null 2>&1

if [ -s "$LAUNCHCTL_CALLS" ]; then
  red "Der Generator hat launchctl selbst aufgerufen -- soll er nicht"
else
  ok "Der Generator ruft launchctl NICHT selbst auf (nur Dateien schreiben)"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle gen-slot-plists-Tests grün."
else
  red "Mindestens ein gen-slot-plists-Test ist rot (siehe oben)."
fi
exit "$FAIL"
