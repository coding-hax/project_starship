#!/usr/bin/env bash
# Wächter gegen das Nachwachsen der Code-Karte (issue #445, Diät #1112).
# Läuft in der CI als Teil des quality-Jobs. Reine Textprüfung, kein Modell.
set -uo pipefail

CODEMAP_FILE="${CODEMAP_FILE:-docs/CODEMAP.md}"
CODEMAP_DIR="${CODEMAP_DIR:-docs/codemap}"
MAX_LINE_LEN=200
MAX_INDEX_BYTES=$((7 * 1024))
MAX_CARD_BYTES=$((10 * 1024))
MAX_TOTAL_BYTES=$((20 * 1024))
MAX_ENTRY_TOKENS=4
FAIL=0

red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

if [ ! -f "$CODEMAP_FILE" ]; then
  red "$CODEMAP_FILE nicht gefunden."
  exit 1
fi

shopt -s nullglob
CARDS=("$CODEMAP_DIR"/*.md)
ALL_FILES=("$CODEMAP_FILE")
if [ "${#CARDS[@]}" -gt 0 ]; then
  ALL_FILES+=("${CARDS[@]}")
fi

# 1. Primär (hart): keine Zeile länger als MAX_LINE_LEN Zeichen -- Index UND
# Bereichskarten. Verbietet direkt den Fehlermodus aus #445 (eine
# 3.695-Zeichen-Zeile) statt nur die Größe zu begrenzen.
LONG_LINES=""
for f in "${ALL_FILES[@]}"; do
  L=$(awk -v max="$MAX_LINE_LEN" -v fname="$f" 'length($0) > max { print fname":"NR": "length($0)" Zeichen" }' "$f")
  [ -n "$L" ] && LONG_LINES="${LONG_LINES}${LONG_LINES:+$'\n'}${L}"
done
if [ -n "$LONG_LINES" ]; then
  echo "$LONG_LINES"
  red "Zeilen über $MAX_LINE_LEN Zeichen (siehe oben)."
else
  ok "Keine Zeile über $MAX_LINE_LEN Zeichen."
fi

# 2. Index-Deckel: der Index ist Pflichtlektüre jedes Laufs, sein Budget ist
# das knappste (AK1).
INDEX_BYTES=$(wc -c < "$CODEMAP_FILE" | tr -d ' ')
if [ "$INDEX_BYTES" -gt "$MAX_INDEX_BYTES" ]; then
  red "$CODEMAP_FILE ist $INDEX_BYTES Bytes, Obergrenze ist $MAX_INDEX_BYTES Bytes."
else
  ok "$CODEMAP_FILE ist $INDEX_BYTES Bytes (Obergrenze $MAX_INDEX_BYTES)."
fi

# 3. Bereichskarten-Deckel je Datei (AK2) + 4. Gesamtgröße (AK3).
CARDS_OVER=0
TOTAL_BYTES=$INDEX_BYTES
if [ "${#CARDS[@]}" -gt 0 ]; then
  for f in "${CARDS[@]}"; do
    B=$(wc -c < "$f" | tr -d ' ')
    TOTAL_BYTES=$((TOTAL_BYTES + B))
    if [ "$B" -gt "$MAX_CARD_BYTES" ]; then
      red "$f ist $B Bytes, Obergrenze ist $MAX_CARD_BYTES Bytes."
      CARDS_OVER=1
    fi
  done
fi
if [ "$CARDS_OVER" -eq 0 ]; then
  ok "Alle Bereichskarten unter $MAX_CARD_BYTES Bytes."
fi

if [ "$TOTAL_BYTES" -gt "$MAX_TOTAL_BYTES" ]; then
  red "Index + Bereichskarten zusammen $TOTAL_BYTES Bytes, Obergrenze ist $MAX_TOTAL_BYTES Bytes."
else
  ok "Index + Bereichskarten zusammen $TOTAL_BYTES Bytes (Obergrenze $MAX_TOTAL_BYTES)."
fi

# 5. Eintragsregel (AK4+AK5): eine Aufzählungszeile, die mit einem
# Backtick-Pfad beginnt ("- `pfad` -- ..."), nennt höchstens
# MAX_ENTRY_TOKENS Backtick-Tokens, davon höchstens eines ohne Datei-Endung,
# und trägt keine Historie-Marker (#<nr>, ADR-####, (S<n>), (T<n>)).
# Andere Aufzählungen (z. B. "Wichtige Invarianten", reiner Fließtext) sind
# keine Eintragszeilen in diesem Sinn und bleiben unangetastet.
TOKEN_VIOLATIONS=""
HISTORY_VIOLATIONS=""
for f in "${ALL_FILES[@]}"; do
  lineno=0
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    if [[ "$line" =~ ^[[:space:]]*-[[:space:]]\` ]]; then
      count=0
      no_ext=0
      while IFS= read -r token; do
        [ -z "$token" ] && continue
        count=$((count + 1))
        base="${token%/}"
        base="${base##*/}"
        case "$base" in
          *.*) ;;
          *) no_ext=$((no_ext + 1)) ;;
        esac
      done < <(grep -oE '`[^`]*`' <<<"$line" | sed -e 's/^`//' -e 's/`$//')

      if [ "$count" -gt "$MAX_ENTRY_TOKENS" ]; then
        TOKEN_VIOLATIONS="${TOKEN_VIOLATIONS}${TOKEN_VIOLATIONS:+$'\n'}$f:$lineno: $count Backtick-Tokens (max $MAX_ENTRY_TOKENS)"
      fi
      if [ "$no_ext" -gt 1 ]; then
        TOKEN_VIOLATIONS="${TOKEN_VIOLATIONS}${TOKEN_VIOLATIONS:+$'\n'}$f:$lineno: $no_ext Tokens ohne Datei-Endung (max 1)"
      fi
      if [[ "$line" =~ \#[0-9]+ ]] || [[ "$line" =~ ADR-[0-9][0-9][0-9][0-9] ]] || \
         [[ "$line" =~ \([ST][0-9]+\) ]]; then
        HISTORY_VIOLATIONS="${HISTORY_VIOLATIONS}${HISTORY_VIOLATIONS:+$'\n'}$f:$lineno: Historie-Marker (#<nr>/ADR-####/(S<n>)/(T<n>)) in Eintragszeile"
      fi
    fi
  done < "$f"
done

if [ -n "$TOKEN_VIOLATIONS" ]; then
  echo "$TOKEN_VIOLATIONS"
  red "Eintragszeilen mit zu vielen bzw. zu vielen endungslosen Backtick-Tokens (siehe oben)."
else
  ok "Alle Eintragszeilen bei höchstens $MAX_ENTRY_TOKENS Backtick-Tokens, höchstens einem ohne Datei-Endung."
fi

if [ -n "$HISTORY_VIOLATIONS" ]; then
  echo "$HISTORY_VIOLATIONS"
  red "Eintragszeilen mit Historie-Marker statt reiner Struktur (siehe oben)."
else
  ok "Keine Eintragszeile trägt einen Historie-Marker."
fi

exit $FAIL
