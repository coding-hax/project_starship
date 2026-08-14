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
  # Ohne origin kann die Aufsicht kein --repo bilden -- und ohne --repo
  # scheitert jeder gh-Aufruf unter launchd (cwd ist dort /).
  git -C "$scn/repo" remote add origin git@github.com:test/repo.git >/dev/null 2>&1

  # Der Stub muss den Fehler vom 14.08. reproduzierbar machen, sonst prüft T15
  # nichts. Dafür braucht es beides:
  #
  #   1. Die gesuchten Labels ZUERST -- dann steigt `grep -q` sofort aus.
  #   2. Danach mehr Nachlauf, als in den Pipe-Puffer passt (64 KB unter
  #      macOS). Erst dann schreibt der Stub noch, wenn grep schon weg ist,
  #      bekommt SIGPIPE und beendet die Pipeline unter `set -o pipefail` rot.
  #
  # Eine frühere Fassung schrieb 400 Zeilen Rauschen VOR die Labels: ~12 KB,
  # alles im Puffer, Stub längst fertig, kein SIGPIPE -- der Test war auch mit
  # dem Fehler grün und damit wertlos.
  # Die Füllmenge steht in $scn/lc-filler und ist normalerweise 0 -- der große
  # Nachlauf kostet je Lauf spürbar Zeit und wird nur in T15 gebraucht.
  printf '0\n' > "$scn/lc-filler"
  cat > "$scn/bin/launchctl" <<STUB
#!/usr/bin/env bash
if [ "\${1:-}" = "list" ]; then
  cat "$scn/loaded"
  n=\$(cat "$scn/lc-filler" 2>/dev/null || echo 0)
  i=0
  while [ "\$i" -lt "\$n" ]; do
    printf -- '-\t0\tcom.apple.fueller.mit.langem.namen.%s\n' "\$i"
    i=\$(( i + 1 ))
  done
fi
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

  # lsof -a -p PID -d cwd -Fn: das Arbeitsverzeichnis eines Agenten. Antwortet
  # aus \$scn/cwd-<pid>; ohne Datei gilt der Prozess als nicht hier laufend.
  cat > "$scn/bin/lsof" <<STUB
#!/usr/bin/env bash
pid=""
while [ "\$#" -gt 0 ]; do
  [ "\$1" = "-p" ] && { pid="\$2"; shift; }
  shift
done
[ -f "$scn/cwd-\$pid" ] && printf 'n%s\n' "\$(cat "$scn/cwd-\$pid")"
exit 0
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
  STALE_SLOT_MIN="${STALE_SLOT_MIN:-30}" \
  LOG_KEEP_LINES="${LOG_KEEP_LINES:-5000}" \
    bash "$SUP" "$@" 2>&1
}

# Einen Slot-Zustand mit gegebenem Alter schreiben -- genau das Format, das
# fleet.ts erzeugt (nur die Felder, die die Aufsicht liest).
set_slot_age() {   # $1 = Szenario, $2 = Slot, $3 = Alter in Minuten
  local ms
  mkdir -p "$1/state/slots/$2"
  ms=$(( ( $(date +%s) - $3 * 60 ) * 1000 ))
  printf '{"slotId":"%s","emoji":"x","title":"t","text":"t","updatedAtMs":%s}\n' \
    "$2" "$ms" > "$1/state/slots/$2/state.json"
}

# Ein Szenario, in dem der Kern benutzbar ist -- sonst überlagert der
# Kern-Alarm alles andere.
with_working_core() {
  mkdir -p "$1/repo/node_modules/.bin"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$1/repo/node_modules/.bin/tsx"
  chmod +x "$1/repo/node_modules/.bin/tsx"
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
# Unter launchd ist cwd `/`. Ohne --repo findet gh kein Repository und der
# Bericht geht stumm verloren -- genau so ging der erste echte verloren.
if grep -q -- "--repo test/repo" "$scn/gh.log"; then
  ok "T8: der Bericht trägt sein --repo selbst"
else
  red "T8: kein --repo im gh-Aufruf -- unter launchd verliert das jeden Bericht"
fi

# --- T8b: Repository aus der https-Form ableiten -----------------------------
new_scenario; scn="$SCN"
with_working_core "$scn"
git -C "$scn/repo" remote set-url origin https://github.com/test/repo.git >/dev/null 2>&1
printf '999999\n' > "$scn/state/lock"
run_sup "$scn" >/dev/null
if grep -q -- "--repo test/repo" "$scn/gh.log"; then
  ok "T8b: auch die https-Fernadresse ergibt owner/repo"
else
  red "T8b: https-Form nicht abgeleitet -- gh.log: $(cat "$scn/gh.log")"
fi

# --- T9: die Takt-Zeile steht in JEDEM Lauf ----------------------------------
# Ohne sie sieht ein gesunder Lauf aus wie eine tote Aufsicht. Sie muss auch
# dann im Log stehen, wenn nichts zu heilen war und nichts ans Issue geht.
new_scenario; scn="$SCN"
with_working_core "$scn"
set_slot_age "$scn" 1 0
set_slot_age "$scn" 2 0
run_sup "$scn" >/dev/null
if grep -q "TAKT" "$scn/state/supervisor.log" 2>/dev/null; then
  ok "T9: stiller Lauf schreibt trotzdem eine Takt-Zeile"
else
  red "T9: keine Takt-Zeile im Log"
fi
if grep -qE "slots=2/2 agenten=0 alter=\[1:0m,2:0m\] reise=nein" "$scn/state/supervisor.log"; then
  ok "T9: die Takt-Zeile trägt Slots, Agenten, Puls und Reise-Modus"
else
  red "T9: Takt-Zeile unvollständig: $(grep TAKT "$scn/state/supervisor.log")"
fi
if [ -s "$scn/gh.log" ]; then
  red "T9: die Takt-Zeile hat einen Kommentar ausgelöst — das wäre alle 10 Min. einer"
else
  ok "T9: die Takt-Zeile geht nur ins Log, nicht ans Issue"
fi

# --- T10: stehengebliebener Slot ohne Agent wird neu gestartet ---------------
new_scenario; scn="$SCN"
with_working_core "$scn"
touch "$scn/state/trip-mode"
set_slot_age "$scn" 1 45      # steht
set_slot_age "$scn" 2 0       # tickt
run_sup "$scn" >/dev/null
if grep -q "^stop 1$" "$scn/fleet.log" && grep -q "^start 1$" "$scn/fleet.log"; then
  ok "T10: stehengebliebener Slot 1 wurde neu gestartet"
else
  red "T10: erwartet 'stop 1' und 'start 1', fleet.log: $(cat "$scn/fleet.log")"
fi
if grep -qE "^(stop|start) 2$" "$scn/fleet.log"; then
  red "T10: der tickende Slot 2 wurde mit angefasst"
else
  ok "T10: der tickende Slot 2 blieb unangetastet"
fi

# --- T11: still, aber ein Agent läuft dort -> kein Eingriff ------------------
# Ein Bau-Lauf darf 45 Minuten dauern und schreibt in dieser Zeit nichts. Wer
# hier neu startet, schießt laufende Arbeit ab.
new_scenario; scn="$SCN"
with_working_core "$scn"
touch "$scn/state/trip-mode"
set_slot_age "$scn" 1 45
set_slot_age "$scn" 2 0
printf '5555\n' > "$scn/pids"
printf '10:00 500\n' > "$scn/proc-5555"     # 10 Min. alt, ganz normal
printf '%s\n' "$scn/repo" > "$scn/cwd-5555" # läuft im Repo dieses Slots
out=$(run_sup "$scn")
if grep -qE "^(stop|start) 1$" "$scn/fleet.log"; then
  red "T11: Slot mit laufendem Agenten wurde neu gestartet — Bau-Lauf abgeschossen"
else
  ok "T11: Slot mit laufendem Agenten bleibt unangetastet"
fi
if printf '%s' "$out" | grep -q "das ist ein Bau-Lauf"; then
  ok "T11: der Fall wird als Bau-Lauf erkannt, nicht als Stillstand"
else
  red "T11: kein Hinweis auf den Bau-Lauf -- Ausgabe: $out"
fi

# --- T12: ohne Reise-Modus wird gemeldet, nicht neu gestartet ----------------
new_scenario; scn="$SCN"
with_working_core "$scn"
set_slot_age "$scn" 1 45
set_slot_age "$scn" 2 0
out=$(run_sup "$scn")
if grep -qE "^(stop|start) 1$" "$scn/fleet.log"; then
  red "T12: ohne Reise-Modus wurde ein Slot neu gestartet"
else
  ok "T12: ohne Reise-Modus wird kein Slot angefasst"
fi
if printf '%s' "$out" | grep -q "ALARM"; then
  ok "T12: der Stillstand wird stattdessen als Alarm gemeldet"
else
  red "T12: Stillstand ohne Reise-Modus erzeugte keinen Alarm"
fi

# --- T13: --status fasst nichts an ------------------------------------------
new_scenario; scn="$SCN"
with_working_core "$scn"
set_slot_age "$scn" 1 45     # stünde sonst zum Neustart an
touch "$scn/state/trip-mode"
out=$(run_sup "$scn" --status)
if printf '%s' "$out" | grep -q "Lagebild"; then
  ok "T13: --status gibt ein Lagebild aus"
else
  red "T13: kein Lagebild -- Ausgabe: $out"
fi
if [ -s "$scn/fleet.log" ] || [ -s "$scn/gh.log" ]; then
  red "T13: --status hat eingegriffen (fleet: $(cat "$scn/fleet.log"), gh: $(cat "$scn/gh.log"))"
else
  ok "T13: --status verändert nichts und meldet nichts"
fi

# --- T14: das Log wächst nicht unbegrenzt ------------------------------------
new_scenario; scn="$SCN"
with_working_core "$scn"
set_slot_age "$scn" 1 0
set_slot_age "$scn" 2 0
mkdir -p "$scn/state"
i=0; while [ "$i" -lt 60 ]; do echo "alte Zeile $i" >> "$scn/state/supervisor.log"; i=$(( i + 1 )); done
LOG_KEEP_LINES=20 run_sup "$scn" >/dev/null
lines=$(wc -l < "$scn/state/supervisor.log" | tr -d ' ')
if [ "$lines" -le 20 ]; then
  ok "T14: Log auf $lines Zeilen gekürzt (Grenze 20)"
else
  red "T14: Log hat $lines Zeilen, Grenze war 20"
fi
if tail -n 1 "$scn/state/supervisor.log" | grep -q "TAKT"; then
  ok "T14: die jüngste Takt-Zeile hat die Kürzung überlebt"
else
  red "T14: die Kürzung hat die jüngste Zeile weggeschnitten"
fi

# --- T15: geladene Slots werden nicht grundlos neu gestartet -----------------
# Regression auf den Fehler vom 14.08.: `launchctl list | grep -q "$label"`
# stirbt unter `set -o pipefail` an SIGPIPE, sobald die Ausgabe lang genug ist.
# Die Aufsicht hielt daraufhin JEDEN Slot für nicht geladen und "startete" alle
# drei bei jedem Lauf. Mit 400 Zeilen Rauschen im launchctl-Stub schlägt der
# Test ohne die Reparatur zuverlässig fehl.
#
# Der launchctl-Stub macht den Fehlschlag deterministisch (Labels zuerst, dann
# Puffer-Überlauf), deshalb genügen zwei Läufe statt eines Rennens über zehn.
new_scenario; scn="$SCN"
with_working_core "$scn"
touch "$scn/state/trip-mode"
set_slot_age "$scn" 1 0
set_slot_age "$scn" 2 0
printf '3000\n' > "$scn/lc-filler"   # ~90 KB Nachlauf: mehr als der Pipe-Puffer
run_sup "$scn" >/dev/null
run_sup "$scn" >/dev/null
if [ -s "$scn/fleet.log" ]; then
  red "T15: geladene Slots wurden angefasst — fleet.log: $(sort -u "$scn/fleet.log" | tr '\n' ' ')"
else
  ok "T15: geladene Slots werden nicht grundlos neu gestartet"
fi
if grep -q "slots=2/2" "$scn/state/supervisor.log"; then
  ok "T15: die Takt-Zeile zählt beide Slots als geladen"
else
  red "T15: Takt-Zeile zählt falsch: $(grep -o 'slots=[0-9]*/[0-9]*' "$scn/state/supervisor.log" | sort -u | tr '\n' ' ')"
fi
if grep -qE "slots=[01]/2" "$scn/state/supervisor.log"; then
  red "T15: mindestens ein Lauf hat Slots verloren — das SIGPIPE-Rennen lebt noch"
else
  ok "T15: kein Lauf hat einen geladenen Slot übersehen"
fi

[ "$FAIL" -eq 0 ] && printf '\033[32mAlle Prüfungen grün.\033[0m\n'
exit "$FAIL"
