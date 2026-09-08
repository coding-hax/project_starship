#!/usr/bin/env bash
# Tests für scripts/check-codemap.sh (issue #445, Diät #1112).
# Reine Bash-Assertions gegen Wegwerf-Fixtures, kein echter Repo-Zustand
# nötig — CODEMAP_FILE/CODEMAP_DIR sind env-überschreibbar genau dafür.
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$TEST_DIR/../check-codemap.sh"

FAIL=0
red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

assert_exit() {   # $1 = beschreibung, $2 = erwarteter exit-code, $3.. = kommando
  local desc="$1" expected="$2"; shift 2
  local actual=0
  "$@" >/dev/null 2>&1 || actual=$?
  if [ "$actual" -eq "$expected" ]; then
    ok "$desc"
  else
    red "$desc (erwartet exit $expected, bekommen $actual)"
  fi
}

EMPTY_DIR="$TMP/empty-cards"
mkdir -p "$EMPTY_DIR"

# --- 1. Sauberes Fixture -> exit 0 ----------------------------------------
CASE1="$TMP/clean.md"
printf '# Code-Karte\n\n### src/app\n\n- `layout.tsx` — kurze Zeile\n' > "$CASE1"
assert_exit "AC1: sauberes Fixture bleibt grün" 0 \
  env CODEMAP_FILE="$CASE1" CODEMAP_DIR="$EMPTY_DIR" bash "$GUARD"

# --- 2. Zeile über 200 Zeichen im Index -> exit 1 -------------------------
CASE2="$TMP/long-line.md"
LONG_SUFFIX=$(printf 'a%.0s' $(seq 1 250))
{
  echo "# Code-Karte"
  echo
  echo "- \`x.ts\` — $LONG_SUFFIX"
} > "$CASE2"
assert_exit "AC2a: Zeile über 200 Zeichen im Index schlägt an" 1 \
  env CODEMAP_FILE="$CASE2" CODEMAP_DIR="$EMPTY_DIR" bash "$GUARD"

# --- 2b. Zeile über 200 Zeichen in einer Bereichskarte -> exit 1 ----------
# (AK6: die 200-Zeichen-Grenze gilt jetzt auch für docs/codemap/*.md.)
LONG_CARD_DIR="$TMP/long-card"
mkdir -p "$LONG_CARD_DIR"
{
  echo "# Code-Karte: Testbereich"
  echo
  echo "- \`x.ts\` — $LONG_SUFFIX"
} > "$LONG_CARD_DIR/bereich.md"
assert_exit "AC2b: Zeile über 200 Zeichen in einer Bereichskarte schlägt an" 1 \
  env CODEMAP_FILE="$CASE1" CODEMAP_DIR="$LONG_CARD_DIR" bash "$GUARD"

# --- 3. Index über 7.168 Bytes -> exit 1 (AK1) ----------------------------
CASE3="$TMP/too-big-index.md"
: > "$CASE3"
for i in $(seq 1 200); do
  echo "- \`file-$i.ts\` — eine kurze, für sich genommen unauffällige Zeile" >> "$CASE3"
done
assert_exit "AC3: Index über 7.168 Bytes schlägt an" 1 \
  env CODEMAP_FILE="$CASE3" CODEMAP_DIR="$EMPTY_DIR" bash "$GUARD"

# --- 4. Fehlende Datei -> exit 1 ------------------------------------------
assert_exit "AC4: fehlende Datei schlägt an, statt still durchzulaufen" 1 \
  env CODEMAP_FILE="$TMP/does-not-exist.md" CODEMAP_DIR="$EMPTY_DIR" bash "$GUARD"

# --- 5. Eine Bereichskarte über 10.240 Bytes -> exit 1 (AK2) --------------
BIG_CARD_DIR="$TMP/big-card"
mkdir -p "$BIG_CARD_DIR"
: > "$BIG_CARD_DIR/bereich.md"
for i in $(seq 1 150); do
  echo "- \`file-$i.ts\` — eine kurze, für sich genommen unauffällige Zeile" >> "$BIG_CARD_DIR/bereich.md"
done
assert_exit "AC5: Bereichskarte über 10.240 Bytes schlägt an" 1 \
  env CODEMAP_FILE="$CASE1" CODEMAP_DIR="$BIG_CARD_DIR" bash "$GUARD"

# --- 5b. Bereichskarte unter 10.240 Bytes -> exit 0 (Positivfall zu AC5) --
SMALL_CARD_DIR="$TMP/small-card"
mkdir -p "$SMALL_CARD_DIR"
printf '# Code-Karte: Testbereich\n\n- `datei.ts` — kurze Zeile\n' > "$SMALL_CARD_DIR/bereich.md"
assert_exit "AC5b: kleine Bereichskarte bleibt grün" 0 \
  env CODEMAP_FILE="$CASE1" CODEMAP_DIR="$SMALL_CARD_DIR" bash "$GUARD"

# --- 6. Index + Bereichskarten zusammen über 20.480 Bytes -> exit 1 (AK3) -
# Jede Datei einzeln unter ihrem eigenen Deckel, nur die Summe reißt.
TOTAL_DIR="$TMP/total-cards"
mkdir -p "$TOTAL_DIR"
for c in a b c; do
  : > "$TOTAL_DIR/$c.md"
  for i in $(seq 1 130); do
    echo "- \`file-$c-$i.ts\` — eine kurze, für sich genommen unauffällige Zeile" >> "$TOTAL_DIR/$c.md"
  done
done
INDEX_NEAR_CAP="$TMP/index-near-cap.md"
: > "$INDEX_NEAR_CAP"
for i in $(seq 1 90); do
  echo "- \`idx-file-$i.ts\` — eine kurze, für sich genommen unauffällige Zeile" >> "$INDEX_NEAR_CAP"
done
assert_exit "AC6: Summe über 20.480 Bytes schlägt an, obwohl jede Datei einzeln unter ihrem Deckel bleibt" 1 \
  env CODEMAP_FILE="$INDEX_NEAR_CAP" CODEMAP_DIR="$TOTAL_DIR" bash "$GUARD"

# --- 7. Eintragszeile mit mehr als 4 Backtick-Tokens -> exit 1 (AK4) ------
CASE7="$TMP/too-many-tokens.md"
printf '# Code-Karte\n\n- `a.ts` / `b.ts` / `c.ts` / `d.ts` / `e.ts` — zu viele Tokens\n' > "$CASE7"
assert_exit "AC7: Eintragszeile mit mehr als 4 Backtick-Tokens schlägt an" 1 \
  env CODEMAP_FILE="$CASE7" CODEMAP_DIR="$EMPTY_DIR" bash "$GUARD"

# --- 7b. Eintragszeile mit genau 4 Backtick-Tokens -> exit 0 (Positivfall) -
CASE7B="$TMP/four-tokens-ok.md"
printf '# Code-Karte\n\n- `a.ts` / `b.ts` / `c.ts` / `d.ts` — genau am Limit\n' > "$CASE7B"
assert_exit "AC7b: Eintragszeile mit genau 4 Backtick-Tokens bleibt grün" 0 \
  env CODEMAP_FILE="$CASE7B" CODEMAP_DIR="$EMPTY_DIR" bash "$GUARD"

# --- 8. Eintragszeile mit 2 Tokens ohne Datei-Endung -> exit 1 (AK4) ------
# Verbietet mechanisch Funktions-/Signaturlisten wie `agendaForDay`/`nextInAgenda`.
CASE8="$TMP/two-no-ext.md"
printf '# Code-Karte\n\n- `event-time.ts` — `agendaForDay`/`nextInAgenda` reine Layout-Logik\n' > "$CASE8"
assert_exit "AC8: Eintragszeile mit 2 endungslosen Tokens schlägt an" 1 \
  env CODEMAP_FILE="$CASE8" CODEMAP_DIR="$EMPTY_DIR" bash "$GUARD"

# --- 8b. Eintragszeile mit 1 Token ohne Datei-Endung -> exit 0 (Positivfall) -
CASE8B="$TMP/one-no-ext.md"
printf '# Code-Karte\n\n- `anmelden/` — Passkey-Routen\n' > "$CASE8B"
assert_exit "AC8b: Eintragszeile mit 1 endungslosem Token (Verzeichnis) bleibt grün" 0 \
  env CODEMAP_FILE="$CASE8B" CODEMAP_DIR="$EMPTY_DIR" bash "$GUARD"

# --- 9. Eintragszeile mit Issue-/ADR-/S-/T-Marker -> exit 1 (AK5) ---------
CASE9="$TMP/history-marker.md"
printf '# Code-Karte\n\n- `route.ts` — SSRF-Proxy (ADR-0022), siehe #445 (S6)\n' > "$CASE9"
assert_exit "AC9: Eintragszeile mit Historie-Marker schlägt an" 1 \
  env CODEMAP_FILE="$CASE9" CODEMAP_DIR="$EMPTY_DIR" bash "$GUARD"

# --- 9b. Eintragszeile ohne Historie-Marker -> exit 0 (Positivfall) -------
CASE9B="$TMP/no-history-marker.md"
printf '# Code-Karte\n\n- `route.ts` — SSRF-Proxy, DNS-Auflösung je Hop\n' > "$CASE9B"
assert_exit "AC9b: Eintragszeile ohne Historie-Marker bleibt grün" 0 \
  env CODEMAP_FILE="$CASE9B" CODEMAP_DIR="$EMPTY_DIR" bash "$GUARD"

# --- 10. Historie-Marker außerhalb einer Eintragszeile stört nicht --------
# ("Wichtige Invarianten" & Co. sind Fließtext-Aufzählungen, keine
# Eintragszeilen -- die Regel gilt nur für "- `pfad` -- ...".
CASE10="$TMP/prose-bullet-ok.md"
printf '# Code-Karte\n\n- Kein Feature-Code spricht direkt mit `/api` (ADR-0022, #445).\n' > "$CASE10"
assert_exit "AC10: Historie-Marker in einer Fließtext-Aufzählung bleibt grün" 0 \
  env CODEMAP_FILE="$CASE10" CODEMAP_DIR="$EMPTY_DIR" bash "$GUARD"

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Codemap-Guard-Tests grün."
else
  red "Mindestens ein Codemap-Guard-Test ist rot (siehe oben)."
fi
exit $FAIL
