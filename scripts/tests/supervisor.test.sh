#!/usr/bin/env bash
# Tests für scripts/runner-supervisor.sh — die Aufsicht über die Flotte.
#
# Geprüft wird das, was im Ernstfall niemand nachkontrolliert: dass die
# Aufsicht ohne Reise-Modus NICHTS startet (die Garantie aus fleet.sh bleibt
# unangetastet), dass sie verwaiste Sperren und gestagte Änderungen genau dann
# anfasst, wenn sie tot bzw. dreckig sind, und dass ein kaputter Runner-Kern
# die Flotte anhält statt zwei Wochen Kontingent zu verfeuern.
#
# Alles Zerstörerische läuft entweder im Trockenlauf (--dry-run, dann steht
# der Handgriff nur im Log) oder gegen echte Wegwerf-Repos unter $TMP. Es wird
# nie ein echter Prozess beendet und nie eine echte Plist geladen: launchctl,
# pgrep, ps, gh, plutil, pnpm, pmset, df und fleet.sh sind gestubbt.
#
# Aufruf: bash scripts/tests/supervisor.test.sh
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$TEST_DIR/../.."
SUP="$ROOT/scripts/runner-supervisor.sh"

FAIL=0
red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

TMP=$(mktemp -d)
# macOS hängt /tmp hinter einem Symlink auf /private/tmp -- aufgelöst, sonst
# vergleichen sich Pfade nicht (gleiche Falle wie worktree.test.sh).
TMP=$(cd "$TMP" && pwd -P)
trap 'rm -rf "$TMP"' EXIT

SCN_N=0
SCN=""

# Ein frisches Szenario: eigenes STATE_DIR, eigenes Repo, eigene Stubs.
#
# Setzt die globale $SCN, statt den Pfad auf stdout zu geben: In einer
# Kommandosubstitution ($(...)) liefe die Funktion in einer Subshell, $SCN_N
# bliebe für immer 1 -- alle Szenarien teilten sich ein Verzeichnis -- und
# jede Zeile Git-Ausgabe landete mitten im Pfad.
new_scenario() {
  SCN_N=$(( SCN_N + 1 ))
  local scn="$TMP/scn$SCN_N"
  mkdir -p "$scn/state/launchd" "$scn/repo" "$scn/bin"

  # Zwei Slots, damit "einer fehlt" überhaupt darstellbar ist.
  : > "$scn/state/launchd/de.starship.runner.slot-1.plist"
  : > "$scn/state/launchd/de.starship.runner.slot-2.plist"
  # Beide Slots geladen -- Tests überschreiben das gezielt.
  printf 'de.starship.runner.slot-1\nde.starship.runner.slot-2\n' > "$scn/loaded"
  : > "$scn/pids"          # laufende Agenten (leer)
  : > "$scn/fleet.log"
  : > "$scn/gh.log"

  git -C "$scn/repo" init -q >/dev/null 2>&1
  git -C "$scn/repo" config user.email t@e.st >/dev/null 2>&1
  git -C "$scn/repo" config user.name Test >/dev/null 2>&1
  echo a > "$scn/repo/a.txt"
  git -C "$scn/repo" add a.txt >/dev/null 2>&1
  git -C "$scn/repo" commit -qm init >/dev/null 2>&1

  cat > "$scn/bin/launchctl" <<STUB
#!/usr/bin/env bash
[ "\${1:-}" = "list" ] && cat "$scn/loaded"
exit 0
STUB

  # Slot 2 zeigt bewusst auf DASSELBE Repo -- all_repos() filtert das weg,
  # sonst liefe jede Prüfung doppelt über denselben Pfad.
  cat > "$scn/bin/plutil" <<STUB
#!/usr/bin/env bash
printf '%s' "$scn/repo"
STUB

  cat > "$scn/bin/pgrep" <<STUB
#!/usr/bin/env bash
cat "$scn/pids"
STUB

  # ps -o etime= -p PID / ps -o ppid= -p PID, beantwortet aus $scn/proc-<pid>
  # (Format: "<etime> <ppid>").
  #
  # Der Stub antwortet ausschließlich auf `etime` im macOS-Format
  # (MM:SS / HH:MM:SS / DD-HH:MM:SS) und lehnt jedes andere Keyword ab -- genau
  # so, wie es das echte `ps` täte. Eine frühere Fassung nahm auch `etimes`
  # (procps/Linux) entgegen: Die Suite war grün, während die Aufsicht auf dem
  # Mac bei jedem Agenten in einen Syntaxfehler lief.
  cat > "$scn/bin/ps" <<STUB
#!/usr/bin/env bash
field="\${2:-}"; pid="\${4:-}"
line=\$(cat "$scn/proc-\$pid" 2>/dev/null) || exit 1
case "\$field" in
  "etime=") printf '%s\n' "\${line%% *}" ;;
  "ppid=")  printf '%s\n' "\${line##* }" ;;
  *) printf 'ps: unbekanntes Keyword: %s\n' "\$field" >&2; exit 1 ;;
esac
STUB

  cat > "$scn/bin/gh" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$scn/gh.log"
STUB

  cat > "$scn/bin/pnpm" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

  cat > "$scn/bin/pg_isready" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

  # Kein Schlaf am Netzteil -- die Warnung soll hier nicht dazwischenfunken.
  cat > "$scn/bin/pmset" <<'STUB'
#!/usr/bin/env bash
printf 'AC Power:\n sleep                0\n'
STUB

  cat > "$scn/bin/df" <<'STUB'
#!/usr/bin/env bash
printf 'Filesystem 1G-blocks Used Avail\n/dev/disk1 900 100 500\n'
STUB

  cat > "$scn/bin/hostname" <<'STUB'
#!/usr/bin/env bash
printf 'testmac\n'
STUB

  cat > "$scn/fleet.sh" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$scn/fleet.log"
exit 0
STUB

  chmod +x "$scn/bin/"* "$scn/fleet.sh"
  SCN="$scn"
}

# Aufsicht in einem Szenario laufen lassen. Weitere Argumente gehen durch.
run_sup() {
  local scn="$1"; shift
  PATH="$scn/bin:$PATH" \
  SUPERVISOR_STATE_DIR="$scn/state" \
  REPO_DIR="$scn/repo" \
  FLEET_SH="$scn/fleet.sh" \
  PLIST_DIR="$scn/state/launchd" \
  STATUS_ISSUE=1 \
    bash "$SUP" "$@" 2>&1
}

# --- T1: ohne Reise-Modus wird nie gestartet ---------------------------------
# Die Garantie aus fleet.sh (Vorfall 10.08.26) darf die Aufsicht nicht
# aushebeln: Sie sieht den fehlenden Slot, meldet ihn -- und rührt ihn nicht an.
new_scenario; scn="$SCN"
printf 'de.starship.runner.slot-1\n' > "$scn/loaded"   # Slot 2 fehlt
out=$(run_sup "$scn")
if grep -q "start" "$scn/fleet.log"; then
  red "T1: ohne Reise-Modus wurde fleet.sh start gerufen"
elif printf '%s' "$out" | grep -q "kein Reise-Modus"; then
  ok "T1: ohne Reise-Modus wird gemeldet, aber nicht gestartet"
else
  red "T1: fehlender Slot wurde nicht gemeldet -- Ausgabe: $out"
fi

# --- T2: mit Reise-Modus wird genau der fehlende Slot gestartet --------------
new_scenario; scn="$SCN"
printf 'de.starship.runner.slot-1\n' > "$scn/loaded"   # Slot 2 fehlt
touch "$scn/state/trip-mode"
out=$(run_sup "$scn")
if grep -q "^start 2$" "$scn/fleet.log"; then
  ok "T2: Reise-Modus startet den fehlenden Slot 2"
else
  red "T2: erwartet 'start 2' in fleet.log, steht drin: $(cat "$scn/fleet.log")"
fi
if grep -q "^start 1$" "$scn/fleet.log"; then
  red "T2: der geladene Slot 1 wurde ebenfalls gestartet"
else
  ok "T2: der geladene Slot 1 bleibt unangetastet"
fi

# --- T3: Sperren -- tot wird geräumt, lebendig bleibt liegen -----------------
new_scenario; scn="$SCN"
printf '999999\n' > "$scn/state/lock"                  # mit Sicherheit tot
run_sup "$scn" >/dev/null
if [ -f "$scn/state/lock" ]; then
  red "T3: verwaiste Sperre (tote PID) wurde nicht entfernt"
else
  ok "T3: verwaiste Sperre (tote PID) entfernt"
fi

new_scenario; scn="$SCN"
printf '%s\n' "$$" > "$scn/state/lock"                 # diese Testsitzung lebt
run_sup "$scn" >/dev/null
if [ -f "$scn/state/lock" ]; then
  ok "T3: Sperre eines lebenden Besitzers bleibt liegen"
else
  red "T3: Sperre eines LEBENDEN Besitzers wurde entfernt -- verdrängt echte Läufe"
fi

# --- T4: dreckiger Index wird geleert, der Arbeitsbaum nicht angefasst -------
# Der Fall, der stillschweigend gemergte Arbeit rückgängig macht (CLAUDE.md).
new_scenario; scn="$SCN"
echo geaendert > "$scn/repo/a.txt"
echo neu > "$scn/repo/b.txt"
git -C "$scn/repo" add a.txt b.txt
run_sup "$scn" >/dev/null
if git -C "$scn/repo" diff --cached --quiet; then
  ok "T4: gestagte Änderungen sind aus dem Index"
else
  red "T4: Index ist weiterhin dreckig"
fi
if [ "$(cat "$scn/repo/a.txt")" = "geaendert" ] && [ -f "$scn/repo/b.txt" ]; then
  ok "T4: Arbeitsbaum blieb unangetastet (nichts verworfen)"
else
  red "T4: die Aufsicht hat Dateien im Arbeitsbaum verändert -- Datenverlust"
fi

# --- T5: Waise an PID 1 und hängender Agent ----------------------------------
# Im Trockenlauf, damit der Test nie ein echtes kill absetzt.
new_scenario; scn="$SCN"
printf '4242\n' > "$scn/pids"
printf '02:00 1\n' > "$scn/proc-4242"      # 2 Minuten alt, aber Elternteil 1
out=$(run_sup "$scn" --dry-run)
if printf '%s' "$out" | grep -q "würde: kill -9 4242"; then
  ok "T5: Waise an PID 1 wird beendet (unabhängig vom Alter)"
else
  red "T5: Waise an PID 1 nicht erkannt -- Ausgabe: $out"
fi

new_scenario; scn="$SCN"
printf '4243\n' > "$scn/pids"
printf '02:00:00 500\n' > "$scn/proc-4243"  # 120 Min., lebender Elternteil
out=$(run_sup "$scn" --dry-run)
if printf '%s' "$out" | grep -q "würde: kill -9 4243"; then
  ok "T5: hängender Agent jenseits der Zeitgrenze wird beendet"
else
  red "T5: hängender Agent nicht erkannt -- Ausgabe: $out"
fi

new_scenario; scn="$SCN"
printf '4244\n' > "$scn/pids"
printf '10:00 500\n' > "$scn/proc-4244"     # 10 Min., voellig normal
out=$(run_sup "$scn" --dry-run)
if printf '%s' "$out" | grep -q "würde: kill -9 4244"; then
  red "T5: ein normal laufender Agent wurde abgeschossen"
else
  ok "T5: normal laufender Agent bleibt unangetastet"
fi

# --- T6: kaputter Kern hält die Flotte an ------------------------------------
# Ohne node_modules/.bin/tsx ist der Kern nicht ausführbar. Erst beim dritten
# Lauf wird angehalten -- ein einzelner Aussetzer (Install läuft gerade) darf
# die Flotte nicht stoppen.
new_scenario; scn="$SCN"
run_sup "$scn" >/dev/null
run_sup "$scn" >/dev/null
if grep -q "^stop$" "$scn/fleet.log"; then
  red "T6: Flotte wurde schon vor dem dritten Fehlversuch angehalten"
else
  ok "T6: zwei Fehlversuche halten die Flotte noch nicht an"
fi
out=$(run_sup "$scn")
if grep -q "^stop$" "$scn/fleet.log"; then
  ok "T6: dritter Fehlversuch hält die Flotte an"
else
  red "T6: Flotte wurde nach drei Fehlversuchen nicht angehalten"
fi
if printf '%s' "$out" | grep -q "ALARM"; then
  ok "T6: der Ausfall wird als Alarm geführt"
else
  red "T6: kaputter Kern erzeugte keinen Alarm"
fi

# --- T7: ein stiller Lauf schreibt nichts ans Issue --------------------------
# Zwei Wochen Rauschen liest niemand. Nur ein tsx-fähiger Kern macht den Lauf
# wirklich still, deshalb wird hier eins gelegt.
new_scenario; scn="$SCN"
mkdir -p "$scn/repo/node_modules/.bin"
cat > "$scn/repo/node_modules/.bin/tsx" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$scn/repo/node_modules/.bin/tsx"
run_sup "$scn" >/dev/null
if [ -s "$scn/gh.log" ]; then
  red "T7: stiller Lauf hat ans Issue geschrieben: $(cat "$scn/gh.log")"
else
  ok "T7: stiller Lauf schreibt nichts ans Issue"
fi

# --- T8: ein Lauf mit Fund meldet ans Issue ----------------------------------
new_scenario; scn="$SCN"
mkdir -p "$scn/repo/node_modules/.bin"
cat > "$scn/repo/node_modules/.bin/tsx" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$scn/repo/node_modules/.bin/tsx"
printf '999999\n' > "$scn/state/lock"
run_sup "$scn" >/dev/null
if grep -q "issue comment 1" "$scn/gh.log"; then
  ok "T8: ein Fund wird ans Status-Issue gemeldet"
else
  red "T8: Fund wurde nicht gemeldet -- gh.log: $(cat "$scn/gh.log")"
fi

[ "$FAIL" -eq 0 ] && printf '\033[32mAlle Prüfungen grün.\033[0m\n'
exit "$FAIL"
