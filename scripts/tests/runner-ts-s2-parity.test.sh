#!/usr/bin/env bash
# Tests für #199 (S2 von #184): stdout + Exit-Code der sechs portierten
# Funktionen müssen über ts_run (RUNNER_TS=1, echtes tsx/cli.ts) und über den
# Bash-Pfad (RUNNER_TS=0) IDENTISCH sein -- das ist AC1 wörtlich.
#
# Anders als runner-ts.test.sh/die drei geerbten Suiten zeigt REPO_DIR hier
# NICHT auf einen Wegwerf-Ordner, sondern auf das echte Repo: nur so bekommt
# ts_run ein echtes tsx + scripts/runner/cli.ts zu fassen statt sofort auf 127
# (kein TS-Pfad) zurückzufallen. Die sechs Funktionen fassen weder gh/git noch
# $STATE_DIR an -- ein reales REPO_DIR ist hier deshalb gefahrlos.
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$TEST_DIR/../claude-runner.sh"
REAL_REPO_DIR="$(cd "$TEST_DIR/../.." && pwd)"

FAIL=0
red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

if [ ! -x "$REAL_REPO_DIR/node_modules/.bin/tsx" ]; then
  red "Vorbedingung: node_modules/.bin/tsx fehlt -- 'pnpm install' zuerst ausführen."
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

FAKEBIN="$TMP/bin"
mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/gh" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cat > "$FAKEBIN/git" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cat > "$FAKEBIN/claude" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$FAKEBIN/gh" "$FAKEBIN/git" "$FAKEBIN/claude"
export PATH="$FAKEBIN:$PATH"

export REPO_DIR="$REAL_REPO_DIR"
export STATUS_ISSUE=0
export QUEUE_ISSUE=0
export MAX_ROUNDS=1
# shellcheck source=/dev/null
source "$RUNNER"

# $1 = Beschreibung, $2 = Funktionsname, Rest = Argumente. Ruft die Funktion
# einmal über den TS-Pfad und einmal über den Bash-Pfad auf, vergleicht
# stdout UND Exit-Code.
compare_parity() {
  local desc="$1" fn="$2" ts_out ts_rc bash_out bash_rc
  shift 2

  RUNNER_TS=1
  ts_out=$("$fn" "$@" 2>/dev/null); ts_rc=$?
  RUNNER_TS=0
  bash_out=$("$fn" "$@" 2>/dev/null); bash_rc=$?

  if [ "$ts_out" = "$bash_out" ] && [ "$ts_rc" = "$bash_rc" ]; then
    ok "$desc"
  else
    red "$desc (ts: out='$ts_out' rc=$ts_rc | bash: out='$bash_out' rc=$bash_rc)"
  fi
}

# ==============================================================================
# fmt_hm -- rein argumentbasiert, kein Zeitbezug zur "jetzt"-Uhr.
# ==============================================================================
compare_parity "fmt_hm: fester Unix-Zeitstempel" fmt_hm 1753531860
compare_parity "fmt_hm: nicht-numerische Eingabe (Exit 1, kein stdout)" fmt_hm "nicht-numerisch"

# ==============================================================================
# d_plus -- haengt an der echten Systemuhr (beide Pfade lesen "jetzt" fast
# zeitgleich), daher nur ein grobes Format ohne Minutenaufloesung.
# ==============================================================================
compare_parity "d_plus: 3 Tage voraus, nur Jahr-Monat-Tag" d_plus 3 "%Y-%m-%d"

# ==============================================================================
# reset_epoch -- ebenfalls an die echte Systemuhr gebunden.
# ==============================================================================
compare_parity "reset_epoch: Session-Limit-Meldung" reset_epoch \
  "… session limit · resets 11:59pm (Europe/Berlin)"
compare_parity "reset_epoch: kein 'resets' im Text (Exit 1, kein stdout)" reset_epoch \
  "irgendeine andere Meldung"

# ==============================================================================
# queue_order_flat / queue_pending / queue_next -- reine Funktionen, komplett
# argumentbasiert.
# ==============================================================================
compare_parity "queue_order_flat: Nummern in Notizbloecken" queue_order_flat \
  '#99
#10
> Notiz siehe #12'

SNAP='[
  {"number":40,"labels":[{"name":"ready"},{"name":"needs-input"}]},
  {"number":41,"labels":[{"name":"ready"}]}
]'
compare_parity "queue_pending: needs-input schliesst aus" queue_pending "$SNAP"
compare_parity "queue_next: needs-input schliesst aus" queue_next "$SNAP"

SNAP2='[
  {"number":10,"labels":[],"createdAt":"2024-01-01T00:00:00Z"},
  {"number":99,"labels":[],"createdAt":"2024-06-01T00:00:00Z"}
]'
compare_parity "queue_next: Queue-Reihenfolge schlaegt createdAt" queue_next "$SNAP2" '#99
#10'

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle TS/Bash-Paritaets-Tests grün."
else
  red "Mindestens ein TS/Bash-Paritaets-Test ist rot (siehe oben)."
fi
exit $FAIL
