#!/usr/bin/env bash
# Tests für #172: ein Squash-Merge darf nur das Ticket schließen, das im
# Titel des gemergten PR selbst steht -- nicht die, deren "Closes #N" nur
# über mitgezogene Merge-Commits fremder PRs in die Historie gerutscht ist
# (beobachtet an #163/#168). Zwei Mechanismen, zwei Testblöcke:
#   Plan A: pr_squash_merge() übergibt --subject/--body selbst, statt GitHub
#           die Commit-Historie sammeln zu lassen.
#   Plan B: reopen_falsely_closed_issues() ist das Netz -- ein Ticket, das
#           trotzdem geschlossen wurde, während sein eigener PR noch offen
#           ist, wird automatisch wieder geöffnet.
# Reine Bash-Assertions, kein bats -- Harness 1:1 wie ci-watch.test.sh.
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
cat > "$FAKEBIN/gh" <<'STUB'
#!/usr/bin/env bash
G="$GHSTATE_DIR"
mkdir -p "$G"

case "${1:-} ${2:-}" in
  "pr view")
    pr="$3"; shift 3
    json=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --json) json="$2"; shift 2 ;;
        -q) shift 2 ;;
        *) shift ;;
      esac
    done
    [ "$json" = "title" ] && cat "$G/title-$pr" 2>/dev/null
    ;;
  "pr list")
    cat "$G/prlist.json" 2>/dev/null || echo "[]"
    ;;
  "pr merge")
    shift 2
    pr=""; subject="__nosubject__"; body="__nobody__"
    while [ $# -gt 0 ]; do
      case "$1" in
        --subject) subject="$2"; shift 2 ;;
        --body) body="$2"; shift 2 ;;
        --squash|--auto|--delete-branch) shift ;;
        *) pr="$1"; shift ;;
      esac
    done
    printf '%s' "$subject" > "$G/mergesubject-$pr"
    printf '%s' "$body" > "$G/mergebody-$pr"
    touch "$G/merged-$pr"
    ;;
  "issue view")
    issue="$3"; shift 3
    json=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --json) json="$2"; shift 2 ;;
        -q) shift 2 ;;
        *) shift ;;
      esac
    done
    if [ "$json" = "state" ]; then
      cat "$G/state-$issue" 2>/dev/null || echo "OPEN"
    fi
    ;;
  "issue reopen")
    issue="$3"
    echo OPEN > "$G/state-$issue"
    touch "$G/reopened-$issue"
    ;;
  "issue comment")
    issue="$3"; shift 3
    body=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --body) body="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    printf '%s' "$body" > "$G/lastcomment-$issue"
    ;;
  *) ;;
esac
exit 0
STUB
chmod +x "$FAKEBIN/gh"

export PATH="$FAKEBIN:$PATH"
export REPO_DIR="$TMP/repo"
mkdir -p "$REPO_DIR"
export STATUS_ISSUE=0
export MAX_ROUNDS=1
# shellcheck source=/dev/null
source "$RUNNER"

reset_state() { rm -rf "$STATE_DIR" "$GHSTATE_DIR"; mkdir -p "$STATE_DIR" "$GHSTATE_DIR"; }

assert_eq() {
  if [ "$2" = "$3" ]; then ok "$1"; else red "$1 (erwartet '$2', bekommen '$3')"; fi
}
assert_file_present() {
  if [ -e "$2" ]; then ok "$1"; else red "$1 (Datei fehlt: $2)"; fi
}
assert_file_absent() {
  if [ ! -e "$2" ]; then ok "$1"; else red "$1 (Datei existiert noch: $2)"; fi
}

# ==============================================================================
# T1 -- pr_squash_merge() traegt NUR den eigenen PR-Titel als Subject ein,
# Body bleibt leer statt der von GitHub aufgesammelten Commit-Historie.
# ==============================================================================
reset_state
echo "fix(runner): needs-input bei geschützten Pfaden — Closes #163" > "$GHSTATE_DIR/title-55"
pr_squash_merge 55
assert_eq "T1: Subject ist exakt der PR-Titel" \
  "fix(runner): needs-input bei geschützten Pfaden — Closes #163" \
  "$(cat "$GHSTATE_DIR/mergesubject-55" 2>/dev/null)"
assert_eq "T1: Body bleibt leer (keine Commit-Historie)" \
  "" "$(cat "$GHSTATE_DIR/mergebody-55" 2>/dev/null)"
assert_file_present "T1: Merge wurde ausgeführt" "$GHSTATE_DIR/merged-55"

# ==============================================================================
# T2 -- Ohne ermittelbaren Titel (gh pr view liefert nichts) faellt
# pr_squash_merge() sauber auf den PLAIN Merge-Aufruf zurueck, statt eine
# leere --subject zu erzwingen.
# ==============================================================================
reset_state
pr_squash_merge 56
assert_eq "T2: kein --subject-Flag ohne ermittelbaren Titel" \
  "__nosubject__" "$(cat "$GHSTATE_DIR/mergesubject-56" 2>/dev/null)"
assert_file_present "T2: Merge wurde trotzdem ausgeführt" "$GHSTATE_DIR/merged-56"

# ==============================================================================
# T3 -- Nachgestellter Fall #163/#168: Ein PR (168), dessen Branch fremde
# Merge-Commits mit 'Closes #163'/'Closes #164' mitgezogen hat, traegt in
# SEINEM EIGENEN Titel nur 'Closes #157'. pr_squash_merge() liest nie den
# git log -- die fremden Schluesselwoerter tauchen in Subject/Body gar nicht
# erst auf, egal was im Branch an Fremd-Commits steckt.
# ==============================================================================
reset_state
echo "fix(ui): Einstellungen bekommen Regler — Closes #157" > "$GHSTATE_DIR/title-168"
pr_squash_merge 168
SUBJ_168=$(cat "$GHSTATE_DIR/mergesubject-168" 2>/dev/null)
case "$SUBJ_168" in
  *"Closes #157"*) ok "T3: Subject nennt das eigene Ticket #157" ;;
  *) red "T3: Subject nennt das eigene Ticket #157 (bekommen: $SUBJ_168)" ;;
esac
case "$SUBJ_168" in
  *"Closes #163"*|*"Closes #164"*)
    red "T3: fremde 'Closes #N' aus mitgezogenen Commits duerfen nicht im Subject stehen" ;;
  *) ok "T3: fremde 'Closes #N' aus mitgezogenen Commits stehen nicht im Subject" ;;
esac
assert_eq "T3: Body bleibt leer, keine Commit-Liste" \
  "" "$(cat "$GHSTATE_DIR/mergebody-168" 2>/dev/null)"

# ==============================================================================
# T4 -- reopen_falsely_closed_issues(): #163 ist CLOSED, obwohl sein eigener
# PR (#166, 'Closes #163' im Titel) noch offen ist -- wird wieder geoeffnet,
# Kommentar nennt Grund und PR.
# ==============================================================================
reset_state
printf '%s' '[
  {"number":166,"title":"fix(runner): needs-input bei geschützten Pfaden — Closes #163"},
  {"number":170,"title":"feat(weather): Feinschliff — Closes #155"}
]' > "$GHSTATE_DIR/prlist.json"
echo CLOSED > "$GHSTATE_DIR/state-163"
reopen_falsely_closed_issues
assert_file_present "T4: #163 wird wieder geöffnet" "$GHSTATE_DIR/reopened-163"
assert_eq "T4: Issue-Status steht wieder auf OPEN" "OPEN" "$(cat "$GHSTATE_DIR/state-163")"
COMMENT_163=$(cat "$GHSTATE_DIR/lastcomment-163" 2>/dev/null)
case "$COMMENT_163" in
  *"#166"*) ok "T4: Kommentar nennt den eigentlichen (noch offenen) PR #166" ;;
  *) red "T4: Kommentar nennt den eigentlichen (noch offenen) PR #166 (bekommen: $COMMENT_163)" ;;
esac
assert_file_absent "T4: #155 (regulär offen) bleibt unangetastet" "$GHSTATE_DIR/reopened-155"

# ==============================================================================
# T5 -- Ein zweiter Lauf über denselben (jetzt schon wieder offenen) Zustand
# loest kein zweites Reopen aus.
# ==============================================================================
rm -f "$GHSTATE_DIR/reopened-163"
reopen_falsely_closed_issues
assert_file_absent "T5: kein erneutes Reopen, wenn Issue schon OPEN ist" \
  "$GHSTATE_DIR/reopened-163"

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle squash-close-guard-Tests grün."
else
  red "Mindestens ein squash-close-guard-Test ist rot (siehe oben)."
fi
exit $FAIL
