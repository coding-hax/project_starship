#!/usr/bin/env bash
# Wächter gegen direkten fetch() Richtung /api außerhalb der Outbox.
# Läuft in der CI als Teil des quality-Jobs. Reine Textprüfung, kein Modell.
set -uo pipefail

SCAN_ROOT="${SCAN_ROOT:-src}"
FAIL=0

red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

# Ausnahmen: die legitimen API-Sprecher.
# src/local/**    -> der Sync selbst (das ist die eine Stelle, die spricht)
# src/app/api/**  -> Server-Routen (kein Client-fetch)
# src/app/anmelden/** und src/auth/** -> Auth ist bewusst nicht Outbox-geführt
#
# Der Pfad-Trenner nach "api" ist Pflicht ("/api/"), nicht nur "/api": eine Fremd-
# quelle wie "https://api.open-meteo.com" (issue #139, ADR-0009) enthält sonst
# zufällig die Zeichenfolge "/api" (aus "https://api...") und würde als eigener
# /api-Zugriff durchgehen, obwohl sie mit unserer API nichts zu tun hat.
HITS=$(grep -rEn "fetch\s*\(" "$SCAN_ROOT" --include='*.ts' --include='*.tsx' 2>/dev/null \
  | grep '/api/' \
  | grep -v -E '/(local|app/api|app/anmelden|auth)/')

if [ -n "$HITS" ]; then
  echo "$HITS"
  red "Feature-Code spricht direkt gegen /api (siehe oben)."
  echo "  UI schreibt über src/local/outbox.ts, nie direkt gegen /api (CODEMAP-Invariante, Regel 8)."
else
  ok "Kein direkter /api-fetch außerhalb der Outbox."
fi

exit $FAIL
