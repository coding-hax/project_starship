#!/usr/bin/env bash
# AK3 (#488, F14) auf Bash-Ebene: apply_status() muss die Fuehrung FRISCH
# zum Zeitpunkt des Veroeffentlichens pruefen (`fleet-verify-lead`), statt
# das bei Rundenbeginn festgehaltene IS_LEAD bis zu FLEET_PUBLISH_INTERVAL
# lang mitzuschleppen -- genau das ist der Weg, ueber den der Hintergrund-
# Publisher (start_fleet_publisher) mitten in einem langen `claude`-Aufruf
# eine laengst verlorene Fuehrung noch veroeffentlicht haette.
#
# Stubt ts_run() als Bash-Funktion (wie round-plan-guard.test.sh) -- kein
# echter TS-Kern noetig, `fleet-verify-lead`s Exit-Code ist hier frei
# steuerbar. Der Herzschlag (fleet-write-state) muss IMMER geschrieben
# werden, unabhaengig von der Fuehrung; nur die Veroeffentlichung
# (fleet-status + status()) haengt an einer frischen, positiven
# fleet-verify-lead-Pruefung.
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
# Nur damit der command-v-Check beim Sourcen durchlaeuft -- apply_status()
# ruft gh/claude selbst nicht auf.
for tool in gh claude; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKEBIN/$tool"
  chmod +x "$FAKEBIN/$tool"
done
export PATH="$FAKEBIN:$PATH"

export REPO_DIR="$TMP/repo"
export SHARED_DIR="$TMP/shared"
mkdir -p "$REPO_DIR"
export STATUS_ISSUE=0
# shellcheck source=/dev/null
source "$RUNNER"

STATUS_LOG="$TMP/status.log"
CALL_LOG="$TMP/calls.log"
# Ueberschreibt die echte status() (die gh braeuchte) -- faengt jede
# Veroeffentlichung ab.
status() {   # $1 = Titel, $2 = Emoji, $3 = Text
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$STATUS_LOG"
}

# VERIFY_LEAD_RC steuert, ob dieser Slot die Lease GERADE (frisch, zum
# Zeitpunkt DIESES Aufrufs) haelt -- unabhaengig von IS_LEAD, das apply_status()
# seit #488 fuer sein Publish-Tor gar nicht mehr liest.
VERIFY_LEAD_RC=0
ts_run() {
  case "$1" in
    fleet-write-state)
      printf 'fleet-write-state\n' >> "$CALL_LOG"
      return 0
      ;;
    fleet-verify-lead)
      return "$VERIFY_LEAD_RC"
      ;;
    fleet-status)
      printf 'fleet-status\n' >> "$CALL_LOG"
      printf '{"title":"Runner-Flotte","emoji":"🟢","text":"alles gruen"}'
      return 0
      ;;
    *)
      printf '{}'
      return 0
      ;;
  esac
}

reset_state() {
  : > "$STATUS_LOG"
  : > "$CALL_LOG"
}

assert_eq() {   # $1 = Beschreibung, $2 = erwartet, $3 = tatsaechlich
  if [ "$2" = "$3" ]; then
    ok "$1"
  else
    red "$1 (erwartet '$2', bekommen '$3')"
  fi
}

call_count() { grep -c "^$1\$" "$CALL_LOG" 2>/dev/null || true; }   # $1 = Kommandoname
status_lines() { wc -l < "$STATUS_LOG" | tr -d ' '; }

# ==============================================================================
# T1 -- dieser Slot haelt die Lease frisch (fleet-verify-lead Exit 0):
# Herzschlag UND Veroeffentlichung.
# ==============================================================================
reset_state
VERIFY_LEAD_RC=0
apply_status '{}'
assert_eq "T1: Herzschlag geschrieben" "1" "$(call_count fleet-write-state)"
assert_eq "T1: fleet-status aufgerufen (Fuehrung frisch bestaetigt)" "1" "$(call_count fleet-status)"
assert_eq "T1: eine Veroeffentlichung ueber status()" "1" "$(status_lines)"

# ==============================================================================
# T2 -- dieser Slot hat die Fuehrung zwischenzeitlich verloren
# (fleet-verify-lead Exit 1, z. B. mitten in einem langen `claude`-Aufruf des
# Hintergrund-Publishers): Herzschlag bleibt, aber KEINE Veroeffentlichung.
# Das ist der Kern von AK3 -- ohne die frische Pruefung wuerde hier ein
# laengst nicht mehr fuehrender Slot trotzdem publizieren.
# ==============================================================================
reset_state
VERIFY_LEAD_RC=1
apply_status '{}'
assert_eq "T2: Herzschlag trotzdem geschrieben" "1" "$(call_count fleet-write-state)"
assert_eq "T2: fleet-status NICHT aufgerufen (Fuehrung verloren)" "0" "$(call_count fleet-status)"
assert_eq "T2: keine Veroeffentlichung ueber status()" "0" "$(status_lines)"

# ==============================================================================
# T3 -- Gegenprobe mit echtem Status-Inhalt (wie round-plan ihn liefert):
# derselbe Effekt, das .status-Feld aendert am Publish-Tor nichts.
# ==============================================================================
reset_state
VERIFY_LEAD_RC=1
apply_status '{"status":{"emoji":"🟡","title":"Bau laeuft","text":"..."}}'
assert_eq "T3: Herzschlag mit Inhalt geschrieben" "1" "$(call_count fleet-write-state)"
assert_eq "T3: fleet-status NICHT aufgerufen (Fuehrung verloren)" "0" "$(call_count fleet-status)"

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle fleet-lead-Tests grün."
else
  red "Mindestens ein fleet-lead-Test ist rot (siehe oben)."
fi
exit $FAIL
