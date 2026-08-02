#!/usr/bin/env bash
# Wächter gegen das Nachwachsen von docs/CODEMAP.md (issue #445).
# Läuft in der CI als Teil des quality-Jobs. Reine Textprüfung, kein Modell.
set -uo pipefail

CODEMAP_FILE="${CODEMAP_FILE:-docs/CODEMAP.md}"
MAX_LINE_LEN=200
MAX_FILE_BYTES=$((25 * 1024))
FAIL=0

red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

if [ ! -f "$CODEMAP_FILE" ]; then
  red "$CODEMAP_FILE nicht gefunden."
  exit 1
fi

# Primär (hart): keine Zeile länger als MAX_LINE_LEN Zeichen. Verbietet direkt
# den Fehlermodus aus #445 (eine 3.695-Zeichen-Zeile) statt nur die Größe zu
# begrenzen.
LONG_LINES=$(awk -v max="$MAX_LINE_LEN" 'length($0) > max { print NR": "length($0)" Zeichen" }' "$CODEMAP_FILE")
if [ -n "$LONG_LINES" ]; then
  echo "$LONG_LINES"
  red "$CODEMAP_FILE enthält Zeilen über $MAX_LINE_LEN Zeichen (siehe oben)."
else
  ok "Keine Zeile über $MAX_LINE_LEN Zeichen."
fi

# Sekundär (hart, mit Kopffreiheit): Gesamtgröße. Fängt eine erneute
# 34x-Regression lange vor dem alten 77-KB-Zustand ab, ohne bei legitimem
# Dateiwachstum sofort rot zu werden.
FILE_BYTES=$(wc -c < "$CODEMAP_FILE" | tr -d ' ')
if [ "$FILE_BYTES" -gt "$MAX_FILE_BYTES" ]; then
  red "$CODEMAP_FILE ist $FILE_BYTES Bytes, Obergrenze ist $MAX_FILE_BYTES Bytes."
else
  ok "$CODEMAP_FILE ist $FILE_BYTES Bytes (Obergrenze $MAX_FILE_BYTES)."
fi

exit $FAIL
