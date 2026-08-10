#!/usr/bin/env bash
# Wächter: rohe font-size/font-weight/line-height außerhalb von
# src/ui/tokens.css (issue #591, hart seit #593). Fund -> Exit-Code 1.
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
  echo "Bitte auf die Typo-Tokens in $TOKENS_FILE umstellen."
  exit 1
else
  echo "✓ Keine rohen Typo-Werte außerhalb von $TOKENS_FILE gefunden."
fi

exit 0
