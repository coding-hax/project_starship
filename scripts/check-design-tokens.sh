#!/usr/bin/env bash
# Warn-Wächter: rohe font-size/font-weight/line-height außerhalb von
# src/ui/tokens.css (issue #591). Warnmodus: Ausgabe ja, Exit-Code immer 0 —
# der harte Modus kommt erst, wenn die Migration der 145 Fundstellen (Folgeticket)
# durch ist, sonst wäre der Check ab Minute eins rot.
set -uo pipefail

SRC_DIR="${SRC_DIR:-src}"
TOKENS_FILE="${TOKENS_FILE:-src/ui/tokens.css}"

FOUND=0

while IFS= read -r match; do
  [ -z "$match" ] && continue
  file="${match%%:*}"
  rest="${match#*:}"
  lineno="${rest%%:*}"
  content="${rest#*:}"

  [ "$file" = "$TOKENS_FILE" ] && continue

  # Wert nach dem ersten Doppelpunkt der Deklaration, bis zum Semikolon.
  value="${content#*:}"
  value="${value%%;*}"

  # var(--…)-Referenzen (auch mit Fallback wie var(--x, 16px)) zählen als
  # tokenisiert und werden vor der Rohwert-Prüfung entfernt.
  stripped=$(printf '%s' "$value" | sed -E 's/var\([^()]*(\([^()]*\)[^()]*)*\)//g')

  if printf '%s' "$stripped" | grep -Eq '[0-9]'; then
    printf '%s:%s: %s\n' "$file" "$lineno" "$(printf '%s' "$content" | sed -E 's/^[[:space:]]+//')"
    FOUND=1
  fi
done < <(grep -rEn '^[[:space:]]*(font-size|font-weight|line-height)[[:space:]]*:' "$SRC_DIR" --include='*.css')

echo
if [ "$FOUND" -eq 1 ]; then
  echo "Rohe font-size/font-weight/line-height außerhalb von $TOKENS_FILE gefunden (siehe oben)."
  echo "Warnmodus: kein Fehlschlag. Migration auf die Typo-Tokens ist ein Folgeticket (issue #591)."
else
  echo "✓ Keine rohen Typo-Werte außerhalb von $TOKENS_FILE gefunden."
fi

exit 0
