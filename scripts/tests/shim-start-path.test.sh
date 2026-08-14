#!/usr/bin/env bash
# Tests für den ECHTEN Startpfad des Runners (issue #252).
#
# Warum es diese Suite gibt: bis #249 hat NICHTS geprüft, wie der Runner
# tatsächlich startet. `scripts/tests/runner-ts.test.sh` prüft ts_run() bei
# korrekt gesetztem RUNNER_HOME -- nicht, ob der Shim ein RUNNER_HOME liefert,
# unter dem der TS-Kern überhaupt antwortet. Genau diese Lücke hat den Runner am
# 27.07.26 elf Stunden stillstehen lassen.
#
# Deshalb läuft hier der Kern ECHT: materialisieren aus einem Ref, node_modules
# verlinken, ts_run über die Naht rufen und eine nicht-leere Antwort erwarten.
#
# Voraussetzung: im Repo ist `pnpm install` gelaufen (node_modules vorhanden).
# Fehlt es, ist B1 rot -- das ist Absicht, kein Übersprung.
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHIM="$TEST_DIR/../starship-runner"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd -P)"

FAIL=0
# Jeder Testblock läuft in einer SUBSHELL -- ein dort gesetztes FAIL=1 erreicht
# diese Shell nie. Deshalb zusätzlich die Flag-Datei (Fehler aus #203).
red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; : > "$FAIL_FLAG"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
FAIL_FLAG="$TMP/failed"

# --- Werkzeug-Attrappen ------------------------------------------------------
# claude-runner.sh prüft beim Sourcen auf gh/jq/claude und beendet sich sonst.
# Alle drei werden gestubbt, damit die Suite nicht vom CI-Image abhängt.
FAKEBIN="$TMP/bin"
mkdir -p "$FAKEBIN"
for tool in gh jq claude; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKEBIN/$tool"
  chmod +x "$FAKEBIN/$tool"
done
export PATH="$FAKEBIN:$PATH"

export STATUS_ISSUE=0      # status() ist damit ein No-Op, kein gh nötig
export MAX_ROUNDS=1

# ==============================================================================
# B1: Der materialisierte Runner antwortet über die Naht.
#     `ts_run version` muss die version aus package.json liefern -- nicht leer.
#     Genau das war bei #249 kaputt: Exit 0, leere Ausgabe, niemandem aufgefallen.
# ==============================================================================
(
  cd "$REPO_ROOT" || exit 1
  export REPO_DIR="$REPO_ROOT"
  export SHARED_DIR="$TMP/shared"
  export RUNNER_REF="HEAD"
  export STATE_DIR="$TMP/state-b1"
  # shellcheck source=/dev/null
  source "$SHIM"
  # Der Shim setzt `set -e`; gesourct gilt das hier weiter und würde den
  # ersten erwarteten Fehlschlag (B3) stumm die Subshell beenden lassen.
  set +e

  DEST="$TMP/b1"; mkdir -p "$DEST"
  HOME_PATH=$(shim_materialise "$DEST") || { red "B1: shim_materialise ist fehlgeschlagen"; exit 1; }

  export RUNNER_HOME="$HOME_PATH"
  export REPO_DIR="$REPO_ROOT"
  export SHARED_DIR="$TMP/shared"
  # shellcheck source=/dev/null
  source "$HOME_PATH/scripts/claude-runner.sh"

  GOT=$(ts_run version)
  WANT=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$REPO_ROOT/package.json" | head -1)

  if [ -z "$GOT" ]; then
    red "B1: ts_run version lieferte NICHTS -- der TS-Kern antwortet über diesen Pfad nicht (#249)"
  elif [ "$GOT" != "$WANT" ]; then
    red "B1: ts_run version lieferte '$GOT', erwartet '$WANT'"
  else
    ok "B1: der materialisierte Kern antwortet über die Naht ($GOT)"
  fi
)

# ==============================================================================
# B2: shim_materialise liefert einen AUFGELÖSTEN Pfad.
#     mktemp gibt auf macOS /var/folders/… zurück, den Symlink auf
#     /private/var/folders/… . Über den Symlink-Pfad hält cli.ts sich für ein
#     importiertes Modul und schweigt (siehe #251). Der Shim muss auflösen.
# ==============================================================================
(
  cd "$REPO_ROOT" || exit 1
  export REPO_DIR="$REPO_ROOT"
  export SHARED_DIR="$TMP/shared"
  export RUNNER_REF="HEAD"
  # shellcheck source=/dev/null
  source "$SHIM"
  # Der Shim setzt `set -e`; gesourct gilt das hier weiter und würde den
  # ersten erwarteten Fehlschlag (B3) stumm die Subshell beenden lassen.
  set +e

  mkdir -p "$TMP/b2-real"
  ln -s "$TMP/b2-real" "$TMP/b2-link"

  HOME_PATH=$(shim_materialise "$TMP/b2-link") || { red "B2: shim_materialise ist fehlgeschlagen"; exit 1; }
  RESOLVED=$(cd "$TMP/b2-real" && pwd -P)

  if [ "$HOME_PATH" != "$RESOLVED" ]; then
    red "B2: Pfad nicht aufgelöst -- bekommen '$HOME_PATH', erwartet '$RESOLVED'"
  else
    ok "B2: der gelieferte Pfad ist aufgelöst, kein Symlink-Anteil"
  fi
)

# ==============================================================================
# B3: Fehlt node_modules, bricht es HÖRBAR ab.
#     `ln -s` zeigt auch klaglos auf ein nicht vorhandenes Ziel -- ohne die
#     Existenzprüfung fiele der Fehler erst beim ersten ts_run auf.
# ==============================================================================
(
  cd "$REPO_ROOT" || exit 1
  export RUNNER_REF="HEAD"
  # shellcheck source=/dev/null
  source "$SHIM"
  # Der Shim setzt `set -e`; gesourct gilt das hier weiter und würde den
  # ersten erwarteten Fehlschlag (B3) stumm die Subshell beenden lassen.
  set +e

  mkdir -p "$TMP/b3-repo" "$TMP/b3-dest"
  REPO="$TMP/b3-repo"        # Repo ohne node_modules

  ERR=$(shim_materialise "$TMP/b3-dest" 2>&1 >/dev/null); RC=$?

  if [ "$RC" -eq 0 ]; then
    red "B3: fehlendes node_modules wurde stillschweigend akzeptiert (Exit 0)"
  elif ! printf '%s' "$ERR" | grep -q "node_modules"; then
    red "B3: Exit $RC, aber die Meldung nennt node_modules nicht: '$ERR'"
  else
    ok "B3: fehlendes node_modules bricht hörbar ab (Exit $RC)"
  fi
)

# ==============================================================================
# B4: Ein HOHLER node_modules-Baum (Verzeichnis da, tsx nur ein toter Symlink)
#     bricht ebenso hörbar ab wie ein fehlendes node_modules -- statt klaglos
#     verlinkt zu werden und erst beim ersten ts_run mit MODULE_NOT_FOUND zu
#     krachen (#563).
# ==============================================================================
(
  cd "$REPO_ROOT" || exit 1
  export RUNNER_REF="HEAD"
  # shellcheck source=/dev/null
  source "$SHIM"
  # Der Shim setzt `set -e`; gesourct gilt das hier weiter und würde den
  # ersten erwarteten Fehlschlag (B4) stumm die Subshell beenden lassen.
  set +e

  mkdir -p "$TMP/b4-repo/node_modules" "$TMP/b4-dest"
  ln -s /nonexistent-store/tsx "$TMP/b4-repo/node_modules/tsx"   # toter Link
  REPO="$TMP/b4-repo"

  ERR=$(shim_materialise "$TMP/b4-dest" 2>&1 >/dev/null); RC=$?

  if [ "$RC" -eq 0 ]; then
    red "B4: hohler node_modules-Baum wurde stillschweigend akzeptiert (Exit 0)"
  elif ! printf '%s' "$ERR" | grep -q "pnpm install"; then
    red "B4: Exit $RC, aber die Meldung nennt pnpm install nicht: '$ERR'"
  else
    ok "B4: hohler node_modules-Baum bricht hörbar mit pnpm-Hinweis ab (Exit $RC)"
  fi
)

# ==============================================================================
echo
[ -e "$FAIL_FLAG" ] && FAIL=1
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Startpfad-Tests grün."
else
  red "Mindestens ein Startpfad-Test ist rot (siehe oben)."
fi
exit $FAIL
