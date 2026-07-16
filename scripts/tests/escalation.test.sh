#!/usr/bin/env bash
# Tests für die Modell-Eskalation beim Bauen (ADR-0007, Issue #34).
# Reine Bash-Assertions, kein bats (keine neue Dependency). Sourct
# claude-runner.sh (der Source-Guard verhindert, dass main() dabei losläuft)
# und stubbt gh/git/claude per PATH-Shim in einem Wegwerf-Zustandsverzeichnis.
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
export GHSTATE_DIR="$TMP/ghstate"
mkdir -p "$GHSTATE_DIR"

# --- Stub 'gh' ---------------------------------------------------------------
# Nur die Teilmenge, die claude-runner.sh tatsaechlich benutzt. Zustand liegt
# dateibasiert unter $GHSTATE_DIR, damit die Tests ihn direkt praeparieren/lesen
# koennen, ohne echtes GitHub.
cat > "$FAKEBIN/gh" <<'STUB'
#!/usr/bin/env bash
G="$GHSTATE_DIR"
mkdir -p "$G"

case "${1:-} ${2:-}" in
  "issue view")
    issue="$3"; shift 3
    json=""; q=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --json) json="$2"; shift 2 ;;
        -q) q="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    if [ "$json" = "labels" ]; then
      cat "$G/labels-$issue" 2>/dev/null
    elif [ "$json" = "comments" ]; then
      cat "$G/lastcomment-$issue" 2>/dev/null
    fi
    ;;
  "issue edit")
    issue="$3"; shift 3
    while [ $# -gt 0 ]; do
      case "$1" in
        --add-label)
          echo "$2" >> "$G/labels-$issue"
          shift 2 ;;
        --remove-label)
          grep -vx "$2" "$G/labels-$issue" 2>/dev/null > "$G/labels-$issue.tmp" || true
          mv -f "$G/labels-$issue.tmp" "$G/labels-$issue" 2>/dev/null || true
          shift 2 ;;
        --title|--body)
          shift 2 ;;
        *) shift ;;
      esac
    done
    ;;
  "issue comment")
    issue="$3"; shift 3
    body=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --body) body="$2"; shift 2 ;;
        --edit-last) shift ;;
        *) shift ;;
      esac
    done
    printf '%s' "$body" > "$G/lastcomment-$issue"
    ;;
  "issue list")
    label=""
    args=("$@")
    i=0
    while [ $i -lt ${#args[@]} ]; do
      if [ "${args[$i]}" = "--label" ]; then label="${args[$((i+1))]}"; fi
      i=$((i+1))
    done
    case "$label" in
      in-progress) cat "$G/wip.json" 2>/dev/null || echo "[]" ;;
      *) echo "[]" ;;
    esac
    ;;
  *) ;;
esac
exit 0
STUB

# --- Stub 'git' ---------------------------------------------------------------
# Nur 'ls-remote --heads origin <muster...>' für branch_tip(). Die gewünschte
# SHA je Ticket liegt in $GHSTATE_DIR/tip-<nr> (fehlt/leer -> kein Branch).
cat > "$FAKEBIN/git" <<'STUB'
#!/usr/bin/env bash
G="$GHSTATE_DIR"
if [ "${1:-}" = "ls-remote" ] && [ "${2:-}" = "--heads" ]; then
  shift 3   # ls-remote --heads origin
  for pat in "$@"; do
    num=$(echo "$pat" | grep -oE '[0-9]+' | head -1)
    f="$G/tip-$num"
    if [ -s "$f" ]; then
      printf '%s\trefs/heads/%s\n' "$(cat "$f")" "$pat"
      break
    fi
  done
fi
exit 0
STUB

# --- Stub 'claude' -------------------------------------------------------------
# Modus per CLAUDE_STUB_MODE. Nur für den main()-Integrationstest (AC2) nötig --
# die Funktionstests rufen main() nie auf und brauchen 'claude' nur, weil der
# Tool-Check am Kopf von claude-runner.sh unbedingt läuft, auch beim Sourcen.
cat > "$FAKEBIN/claude" <<'STUB'
#!/usr/bin/env bash
case "${CLAUDE_STUB_MODE:-success}" in
  limit)
    printf '%s' '{"api_error_status":429,"result":"Session limit \xC2\xB7 resets 11:59pm (Europe/Berlin)"}'
    exit 1
    ;;
  *)
    printf '%s' '{"session_id":"stub","result":"ok"}'
    exit 0
    ;;
esac
STUB

chmod +x "$FAKEBIN/gh" "$FAKEBIN/git" "$FAKEBIN/claude"
export PATH="$FAKEBIN:$PATH"

# --- claude-runner.sh sourcen (main() läuft dank Source-Guard nicht an) -------
export REPO_DIR="$TMP/repo"
mkdir -p "$REPO_DIR"
export STATUS_ISSUE=0
# shellcheck source=/dev/null
source "$RUNNER"

reset_state() {   # frisches Zustandsverzeichnis + GH-Zustand für jeden Testfall
  rm -rf "$STATE_DIR" "$GHSTATE_DIR"
  mkdir -p "$STATE_DIR" "$GHSTATE_DIR"
}

setup_issue() {   # $1 = Issue-Nr, $2... = zusätzliche Labels
  local issue="$1"; shift
  local extra_json="" l
  : > "$GHSTATE_DIR/labels-$issue"
  echo "in-progress" >> "$GHSTATE_DIR/labels-$issue"
  for l in "$@"; do
    echo "$l" >> "$GHSTATE_DIR/labels-$issue"
    extra_json="${extra_json},{\"name\":\"$l\"}"
  done
  printf '[{"number":%s,"labels":[{"name":"in-progress"}%s]}]' "$issue" "$extra_json" \
    > "$GHSTATE_DIR/wip.json"
}

assert_eq() {   # $1 = beschreibung, $2 = erwartet, $3 = tatsaechlich
  if [ "$2" = "$3" ]; then
    ok "$1"
  else
    red "$1 (erwartet '$2', bekommen '$3')"
  fi
}

assert_file_absent() {   # $1 = beschreibung, $2 = pfad
  if [ ! -e "$2" ]; then
    ok "$1"
  else
    red "$1 (Datei existiert noch: $2)"
  fi
}

# ==============================================================================
# 1. Kein Fortschritt + gleiche Signatur -> failcount steigt
# ==============================================================================
reset_state
ISSUE=101 RUN_ROLE=build LABELS="" BEFORE_TIP="sha-alt"
setup_issue "$ISSUE"
printf '%s' "## 🤖 Fortschritt (automatisch aktualisiert)

- [ ] ← HIER WEITER: Outbox

_Lauf-Ende 16.07. 10:00: gate-rot, unfertig — nächster Lauf macht weiter._" \
  > "$GHSTATE_DIR/lastcomment-$ISSUE"
# kein tip-101 -> branch_tip liefert leer -> "kein Fortschritt"
build_escalation_eval
assert_eq "AC1: erster Fehlversuch setzt failcount=1" "1" "$(cat "$STATE_DIR/failcount-$ISSUE" 2>/dev/null)"

# ==============================================================================
# 2. Limit-Ausgang zählt nicht als Fehlversuch (main()-Integrationstest)
# ==============================================================================
reset_state
ISSUE=102
setup_issue "$ISSUE"
(
  CLAUDE_STUB_MODE=limit
  export CLAUDE_STUB_MODE
  main
) >/dev/null 2>&1
assert_file_absent "AC2: Limit-Lauf legt keinen failcount an" "$STATE_DIR/failcount-$ISSUE"
LIMIT_LABELS=$(cat "$GHSTATE_DIR/labels-$ISSUE" 2>/dev/null | tr '\n' ' ')
case "$LIMIT_LABELS" in
  *blocked-limit*) ok "AC2: Limit-Lauf setzt blocked-limit" ;;
  *) red "AC2: Limit-Lauf setzt blocked-limit (Labels: $LIMIT_LABELS)" ;;
esac

# ==============================================================================
# 3. 3x kein Fortschritt -> tier_bump (sonnet -> opus)
# ==============================================================================
reset_state
ISSUE=103 RUN_ROLE=build LABELS="" BEFORE_TIP="sha-alt"
setup_issue "$ISSUE"
printf '%s' "## 🤖 Fortschritt (automatisch aktualisiert)

_Lauf-Ende 16.07. 10:00: gate-rot, unfertig — nächster Lauf macht weiter._" \
  > "$GHSTATE_DIR/lastcomment-$ISSUE"
build_escalation_eval
build_escalation_eval
build_escalation_eval
assert_eq "AC3: drei Fehlversuche schalten auf opus hoch" "opus" "$(tier_current "$ISSUE")"
assert_eq "AC3: Fehlversuchs-Zähler wird beim Hochschalten zurückgesetzt" "0" "$(cat "$STATE_DIR/failcount-$ISSUE" 2>/dev/null)"

# ==============================================================================
# 4. Fortschritt (Branch-Tip bewegt) -> tier_reset auf Default
# ==============================================================================
reset_state
ISSUE=104 RUN_ROLE=build LABELS="" BEFORE_TIP="sha-alt"
setup_issue "$ISSUE"
echo opus > "$STATE_DIR/tier-$ISSUE"
echo 2 > "$STATE_DIR/failcount-$ISSUE"
echo "irgendeine-sig" > "$STATE_DIR/blocker-sig-$ISSUE"
echo "sha-neu" > "$GHSTATE_DIR/tip-$ISSUE"   # Branch hat sich bewegt
build_escalation_eval
assert_eq "AC4: Fortschritt setzt Stufe auf Default zurück" "sonnet" "$(tier_current "$ISSUE")"
assert_file_absent "AC4: Fortschritt löscht den Fehlversuchs-Zähler" "$STATE_DIR/failcount-$ISSUE"

# ==============================================================================
# 5. no-escalation -> nie tier_bump, auch nicht nach 3 Fehlversuchen
# ==============================================================================
reset_state
ISSUE=105 RUN_ROLE=build LABELS="no-escalation" BEFORE_TIP="sha-alt"
setup_issue "$ISSUE" "no-escalation"
printf '%s' "## 🤖 Fortschritt (automatisch aktualisiert)

_Lauf-Ende 16.07. 10:00: gate-rot, unfertig — nächster Lauf macht weiter._" \
  > "$GHSTATE_DIR/lastcomment-$ISSUE"
build_escalation_eval
build_escalation_eval
build_escalation_eval
assert_file_absent "AC5: no-escalation verhindert jeden tier_bump" "$STATE_DIR/tier-$ISSUE"

# ==============================================================================
# 6. Opus-Deckel: 3. Opus-Lauf ohne Fortschritt -> needs-input, kein 3. Bau
# ==============================================================================
reset_state
ISSUE=106
setup_issue "$ISSUE"
echo opus > "$STATE_DIR/tier-$ISSUE"          # Eskalation ist schon auf Opus
TODAY=$(date +%Y%m%d)
echo 2 > "$STATE_DIR/opus-build-$TODAY-$ISSUE"   # heute schon 2 Opus-Bau-Läufe verbraucht
(
  CLAUDE_STUB_MODE=success
  export CLAUDE_STUB_MODE
  main
) >/dev/null 2>&1
CAP_LABELS=$(cat "$GHSTATE_DIR/labels-$ISSUE" 2>/dev/null | tr '\n' ' ')
case "$CAP_LABELS" in
  *needs-input*) ok "AC6: erschöpfter Opus-Deckel setzt needs-input" ;;
  *) red "AC6: erschöpfter Opus-Deckel setzt needs-input (Labels: $CAP_LABELS)" ;;
esac
assert_eq "AC6: kein dritter Opus-Bau-Lauf reserviert" "2" "$(cat "$STATE_DIR/opus-build-$TODAY-$ISSUE" 2>/dev/null)"

# ==============================================================================
# 7. Abweichende Blocker-Signatur -> failcount zurück auf 0
# ==============================================================================
reset_state
ISSUE=107 RUN_ROLE=build LABELS="" BEFORE_TIP="sha-alt"
setup_issue "$ISSUE"
echo 2 > "$STATE_DIR/failcount-$ISSUE"
echo "alte-signatur-die-nirgendwo-vorkommt" > "$STATE_DIR/blocker-sig-$ISSUE"
printf '%s' "## 🤖 Fortschritt (automatisch aktualisiert)

_Lauf-Ende 16.07. 11:00: gate-rot — ein ANDERER Test schlägt jetzt fehl._" \
  > "$GHSTATE_DIR/lastcomment-$ISSUE"
build_escalation_eval
assert_eq "AC7: neue Blocker-Signatur setzt failcount zurück" "0" "$(cat "$STATE_DIR/failcount-$ISSUE" 2>/dev/null)"

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Eskalations-Tests grün."
else
  red "Mindestens ein Eskalations-Test ist rot (siehe oben)."
fi
exit $FAIL
