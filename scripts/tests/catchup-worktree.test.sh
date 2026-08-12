#!/usr/bin/env bash
# Tests für #665: prCatchUpBehind() muss im Worktree laufen, der den PR-Branch
# haelt -- nicht im Slot-Haupt-Checkout. Sonst bewegt `checkout -B` den Ref
# unter dem Worktree weg, ohne dass dessen Index/Arbeitsbaum folgen
# (invertierter Index, s. Issue). Anders als die uebrigen Suiten unter
# scripts/tests/ bleibt 'git' hier UNGESTUBBT (wie worktree.test.sh) -- genau
# das echte Zusammenspiel von 'git worktree'/'checkout -B'/'merge' ist der
# Pruefgegenstand. Nur 'gh' wird gestubbt (ein einzelner PR, feste Antwort).
#
# Aufruf: 'tsx cli.ts pr-catch-up-behind <pr>'/'tsx cli.ts worktree-index-ok
# <pfad>' direkt, mit cwd = REPO_DIR (dem Haupt-Checkout) -- genau der Ort, an
# dem der Bug auftrat: die Runde selbst laeuft nie im Worktree, nur der
# Bau-Lauf danach.
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$TEST_DIR/../.."
TSX="$ROOT/node_modules/.bin/tsx"
CLI="$ROOT/scripts/runner/cli.ts"

FAIL=0
red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; : > "$FAIL_FLAG"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

TMP=$(mktemp -d)
# Aufgeloest, nicht der rohe mktemp-Pfad -- macOS /tmp haengt hinter einem
# Symlink auf /private/tmp (gleiche Falle wie worktree.test.sh).
TMP=$(cd "$TMP" && pwd -P)
trap 'rm -rf "$TMP"' EXIT
FAIL_FLAG="$TMP/failed"

FAKEBIN="$TMP/bin"
mkdir -p "$FAKEBIN"

# --- Stub 'gh': genau ein PR (#1), fest auf BEHIND -------------------------
cat > "$FAKEBIN/gh" <<'STUB'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
  "pr view")
    printf '{"headRefName":"feat/1-x","mergeStateStatus":"BEHIND"}'
    ;;
  *) : ;;
esac
exit 0
STUB
chmod +x "$FAKEBIN/gh"
export PATH="$FAKEBIN:$PATH"
# 'git' bleibt absichtlich UNGESTUBBT -- echtes PATH-git.

export STATE_DIR="$TMP/state"
export SHARED_DIR="$TMP/shared"
export SLOT_ID=1

assert_eq() {   # $1 = Beschreibung, $2 = erwartet, $3 = tatsaechlich
  if [ "$2" = "$3" ]; then ok "$1"; else red "$1 (erwartet '$2', bekommen '$3')"; fi
}

# --- Echtes Repo: bare 'origin' + Klon als REPO_DIR (Slot-Haupt-Checkout) ---
ORIGIN="$TMP/origin.git"
git init --bare -q "$ORIGIN"
git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main

REPO_DIR="$TMP/repo"
git clone -q "$ORIGIN" "$REPO_DIR"
git -C "$REPO_DIR" symbolic-ref HEAD refs/heads/main
git -C "$REPO_DIR" config user.email "test@example.com"
git -C "$REPO_DIR" config user.name "Test"
echo init > "$REPO_DIR/README.md"
git -C "$REPO_DIR" add README.md
git -C "$REPO_DIR" commit -q -m init
git -C "$REPO_DIR" push -q -u origin main

git -C "$REPO_DIR" checkout -qb feat/1-x
echo feature > "$REPO_DIR/feature.txt"
git -C "$REPO_DIR" add feature.txt
git -C "$REPO_DIR" commit -q -m feature
git -C "$REPO_DIR" push -q -u origin feat/1-x
git -C "$REPO_DIR" checkout -q main

# --- Worktree, der feat/1-x haelt (wie ein Bau-Slot ihn per ensure_worktree
# anlegen wuerde) -----------------------------------------------------------
WT="$TMP/worktrees/issue-1"
mkdir -p "$TMP/worktrees"
git -C "$REPO_DIR" worktree add -q "$WT" feat/1-x

# --- main laeuft unabhaengig weiter (zweiter Klon, wie ein gemergter PR) ---
OTHER="$TMP/other-clone"
git clone -q "$ORIGIN" "$OTHER"
git -C "$OTHER" config user.email "test@example.com"
git -C "$OTHER" config user.name "Test"
echo "main moved on" > "$OTHER/from-main.txt"
git -C "$OTHER" add from-main.txt
git -C "$OTHER" commit -q -m "main moved on"
git -C "$OTHER" push -q origin main

run_catchup() {   # $1 = PR-Nummer -> Exitcode, stdout in $CATCHUP_OUT
  CATCHUP_OUT=$(cd "$REPO_DIR" && "$TSX" "$CLI" pr-catch-up-behind "$1" 2>"$TMP/catchup-stderr")
  return $?
}

run_index_ok() {   # $1 = Pfad -> Exitcode, stdout in $INDEXOK_OUT
  INDEXOK_OUT=$(cd "$REPO_DIR" && "$TSX" "$CLI" worktree-index-ok "$1" 2>"$TMP/indexok-stderr")
  return $?
}

# ==============================================================================
# AK1: Catch-up laeuft im Worktree -- danach Index==HEAD-Baum, Arbeitsbaum
# sauber, HEAD enthaelt den main-Merge. Der Haupt-Checkout selbst bleibt
# unberuehrt (bleibt auf main, kein zusaetzlicher lokaler feat/1-x-Checkout).
# ==============================================================================
run_catchup 1
rc=$?
assert_eq "AK1: pr-catch-up-behind Exit 0" "0" "$rc"
assert_eq "AK1: Worktree-Index == HEAD-Baum nach dem Catch-up" \
  "$(git -C "$WT" write-tree)" "$(git -C "$WT" rev-parse HEAD^{tree})"
assert_eq "AK1: Worktree-Arbeitsbaum sauber" "" "$(git -C "$WT" status --porcelain)"
assert_eq "AK1: from-main.txt kam per Merge im Worktree an" "main moved on" "$(cat "$WT/from-main.txt" 2>/dev/null)"
assert_eq "AK1: Haupt-Checkout bleibt auf main" "main" "$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)"
assert_eq "AK1: Haupt-Checkout ist sauber (kein Statuseintrag)" "" "$(git -C "$REPO_DIR" status --porcelain)"

# ==============================================================================
# AK4: ein zweiter Nachzieh-Lauf (nichts Neues zu mergen) bleibt fehlerfrei --
# insbesondere kein "local changes would be overwritten" durch einen quer
# stehenden Index aus dem ERSTEN Lauf.
# ==============================================================================
run_catchup 1
rc=$?
assert_eq "AK4: zweiter Nachzieh-Lauf Exit 0" "0" "$rc"
if grep -qi "would be overwritten" "$TMP/catchup-stderr" 2>/dev/null; then
  red "AK4: zweiter Lauf meldet 'local changes would be overwritten'"
else
  ok "AK4: zweiter Lauf ohne Ueberschreibungs-Fehler"
fi
assert_eq "AK4: Worktree-Index bleibt konsistent" \
  "$(git -C "$WT" write-tree)" "$(git -C "$WT" rev-parse HEAD^{tree})"

# ==============================================================================
# AK3: worktree-index-ok erkennt einen sauberen Worktree als ok...
# ==============================================================================
run_index_ok "$WT"
assert_eq "AK3: worktree-index-ok auf sauberem Worktree -> Exit 0" "0" "$?"

# ...und einen quer stehenden Index (der Branch-Ref wird VON AUSSEN bewegt,
# ohne dass der Worktree je angefasst wird) als NICHT ok, mit Grund im
# stdout. Der Bug entstand urspruenglich durch `checkout -B` im
# Haupt-Checkout, waehrend derselbe Branch in einem Worktree ausgecheckt ist
# -- neuere Git-Versionen verweigern genau das ("already checked out",
# gilt inzwischen auch fuer -B), was diesen Nachweis git-versionsabhaengig
# machte (CI: git 2.54 verweigert, lokal getestet: git 2.39 erlaubt es
# noch). Deshalb hier ueber Plumbing `update-ref`: bewegt den Branch-Ref,
# ohne Worktree-Sicherheitschecks zu durchlaufen -- git-versionsunabhaengig
# derselbe Effekt (invertierter Index), den jede reale Ursache erzeugen kann.
echo "zweite main-Aenderung" > "$OTHER/from-main-2.txt"
git -C "$OTHER" add from-main-2.txt
git -C "$OTHER" -c user.email=test@example.com -c user.name=Test commit -q -m "main moved on again"
git -C "$OTHER" push -q origin main
git -C "$REPO_DIR" fetch -q origin main
git -C "$REPO_DIR" update-ref refs/heads/feat/1-x origin/main

run_index_ok "$WT"
rc=$?
assert_eq "AK3: worktree-index-ok auf invertiertem Index -> Exit 1" "1" "$rc"
if [ -n "${INDEXOK_OUT:-}" ]; then ok "AK3: Grund im stdout ($INDEXOK_OUT)"
else red "AK3: kein Grund im stdout"; fi

# Reparatur (wie im Ticket empfohlen) stellt den ok-Zustand wieder her.
git -C "$WT" reset -q --hard HEAD
run_index_ok "$WT"
assert_eq "AK3: nach 'reset --hard HEAD' wieder Exit 0" "0" "$?"

# ==============================================================================
echo
[ -e "$FAIL_FLAG" ] && FAIL=1
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Catchup-Worktree-Tests grün."
else
  red "Mindestens ein Catchup-Worktree-Test ist rot (siehe oben)."
fi
exit $FAIL
