#!/usr/bin/env bash
# Erzeugt eine launchd-plist je Runner-Slot (#204). Schreibt nur Dateien --
# lädt oder installiert NICHTS von selbst, genau wie der Shim-Install in
# scripts/launchd-setup.md von Hand bleibt: ein Skript, das seine eigenen
# Läufe verdoppeln könnte, sollte das nicht unbeaufsichtigt tun.
#
# Slot 1 ist der vorhandene Checkout ($REPO_DIR, Default ~/dev/project_starship)
# -- kein neuer Clone nötig. Slot 2..N sind eigene Clones unter
# ~/dev/starship-slot-<n> (Frage 2 = A, siehe Issue #204): eigene .env.local,
# eigene Postgres-DB, kein geteiltes .git.
#
# Aufruf:
#   SLOT_COUNT=3 STATUS_ISSUE=1 scripts/gen-slot-plists.sh [zielverzeichnis]
#
# Umgebungsvariablen (alle optional, mit Default):
#   SLOT_COUNT      wie viele Slots (Default 1, Deckel 10 -- siehe AK8 in claude-runner.sh)
#   STATUS_ISSUE    EIN aggregiertes Status-Issue für die ganze Flotte (Frage 4/6)
#   LEAD_SLOT       welcher Slot faehrt die globalen Waechter, solange er lebt (Default 1)
#   REPO_DIR        Pfad des Slot-1-Checkouts (Default ~/dev/project_starship)
#   SLOT_BASE       wo Slot 2..N liegen (Default ~/dev, Clones heissen starship-slot-<n>)
#   SHARED_DIR      slotübergreifender Zustand (Default ~/.starship-runner)
#   PLIST_PREFIX    Label-Präfix (Default de.starship.runner)
#   START_INTERVAL  Taktsekunden, überschreibt den Default (60s bei einem Slot,
#                   120s ab zwei) -- Deckel: unter 60s wird abgelehnt (gh-Limit)
set -euo pipefail

SLOT_COUNT="${SLOT_COUNT:-1}"
STATUS_ISSUE="${STATUS_ISSUE:-0}"
LEAD_SLOT="${LEAD_SLOT:-1}"
REPO_DIR_SLOT1="${REPO_DIR:-$HOME/dev/project_starship}"
SLOT_BASE="${SLOT_BASE:-$HOME/dev}"
SHARED_DIR="${SHARED_DIR:-$HOME/.starship-runner}"
PLIST_PREFIX="${PLIST_PREFIX:-de.starship.runner}"
OUT_DIR="${1:-.}"

case "$SLOT_COUNT" in
  ''|*[!0-9]*)
    echo "SLOT_COUNT muss eine positive Zahl sein, ist aber '$SLOT_COUNT'." >&2
    exit 1
    ;;
esac
if [ "$SLOT_COUNT" -lt 1 ] || [ "$SLOT_COUNT" -gt 10 ]; then
  echo "SLOT_COUNT=$SLOT_COUNT außerhalb des erlaubten Bereichs 1-10 (Deckel gegen Vertipper, wie in claude-runner.sh)." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

# Default-Takt: 60s bei einem Slot, 120s ab zwei. Gemessen 29.07.26 im
# 3-Slot-Betrieb: 0/5000 core-Calls, GraphQL 206/5000 -- die alten 300s waren
# vorsichtig geschaetzt, nicht gemessen. 120s halbiert die Reaktionszeit und
# laesst zum gh-Limit (5000/h) reichlich Luft. Per START_INTERVAL ueberschreibbar,
# damit es beim naechsten Lauf keine Handaenderung an der geladenen Plist braucht.
if [ "$SLOT_COUNT" -gt 1 ]; then
  default_interval=120
else
  default_interval=60
fi
START_INTERVAL="${START_INTERVAL:-$default_interval}"

# Deckel gegen das gh-API-Limit: unter 60s wird abgelehnt (AK3).
case "$START_INTERVAL" in
  ''|*[!0-9]*)
    echo "START_INTERVAL muss eine positive Zahl (Sekunden) sein, ist aber '$START_INTERVAL'." >&2
    exit 1
    ;;
esac
if [ "$START_INTERVAL" -lt 60 ]; then
  echo "START_INTERVAL=$START_INTERVAL unter 60s abgelehnt -- das gh-API-Limit (5000 Calls/h) rueckt sonst in Reichweite (siehe launchd-setup.md)." >&2
  exit 1
fi

# Bestbemuehte PATH-Ermittlung zur Generierzeit -- launchd erbt keine
# Shell-Umgebung. Muss trotzdem von Hand geprueft werden (siehe Hinweis am
# Ende jeder erzeugten Datei), node liegt bei nvm-Nutzern versionsabhaengig.
GEN_PATH=""
for bin in claude gh jq node; do
  dir=$(dirname "$(command -v "$bin" 2>/dev/null || true)" 2>/dev/null || true)
  [ -n "$dir" ] && case ":$GEN_PATH:" in *":$dir:"*) ;; *) GEN_PATH="${GEN_PATH:+$GEN_PATH:}$dir" ;; esac
done
GEN_PATH="${GEN_PATH:+$GEN_PATH:}/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

for n in $(seq 1 "$SLOT_COUNT"); do
  label="$PLIST_PREFIX.slot-$n"
  if [ "$n" -eq 1 ]; then
    repo_dir="$REPO_DIR_SLOT1"
  else
    repo_dir="$SLOT_BASE/starship-slot-$n"
  fi
  out="$OUT_DIR/$label.plist"

  cat > "$out" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>

  <!-- Auf den Shim zeigen, NICHT auf scripts/claude-runner.sh im Repo --
       siehe Abschnitt "Der Shim" in launchd-setup.md. Der Shim liest
       REPO_DIR aus der Umgebung unten und holt den Runner-Code aus
       origin/main -- er braucht dafuer KEINE Slot-Aenderung. -->
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$HOME/.local/bin/starship-runner</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>REPO_DIR</key>
    <string>$repo_dir</string>
    <key>STATUS_ISSUE</key>
    <string>$STATUS_ISSUE</string>

    <!-- #204: die einzigen vier slotspezifischen Werte. SLOT_ID ist die
         einzige Variable, die diesen Slot von den anderen unterscheidet --
         STATE_DIR/Ports leiten sich in claude-runner.sh/tests/run-lock.ts
         rechnerisch daraus ab, NICHT hier. -->
    <key>SLOT_ID</key>
    <string>$n</string>
    <key>SLOT_COUNT</key>
    <string>$SLOT_COUNT</string>
    <key>LEAD_SLOT</key>
    <string>$LEAD_SLOT</string>
    <key>SHARED_DIR</key>
    <string>$SHARED_DIR</string>

    <!-- launchd erbt die Shell-Umgebung NICHT. Von Hand gegenpruefen mit
         'which claude gh jq node' -- node liegt bei nvm versionsabhaengig,
         ein Versionswechsel verlangt ein Nachziehen hier. -->
    <key>PATH</key>
    <string>$GEN_PATH</string>

    <key>HOME</key>
    <string>$HOME</string>
  </dict>

  <key>StartInterval</key>
  <integer>$START_INTERVAL</integer>

  <!-- Nicht sofort beim Laden loslaufen -- sonst startet ein Agent in dem
       Moment, in dem du den Timer aktivierst. -->
  <key>RunAtLoad</key>
  <false/>

  <key>StandardOutPath</key>
  <string>/tmp/starship-runner-slot-$n.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/starship-runner-slot-$n.err.log</string>
</dict>
</plist>
PLIST

  echo "geschrieben: $out (Slot $n, REPO_DIR=$repo_dir)"
done

cat <<NOTE

Als naechstes je Datei, wie in scripts/launchd-setup.md beschrieben:
  cp $OUT_DIR/$PLIST_PREFIX.slot-*.plist ~/Library/LaunchAgents/
  launchctl load ~/Library/LaunchAgents/$PLIST_PREFIX.slot-<n>.plist

Slot 1 braucht KEINEN neuen Clone (nutzt \$REPO_DIR). Slot 2..N: eigener
Clone + eigene .env.local + eigene Postgres-DB, siehe launchd-setup.md,
Abschnitt "Mehrere Slots (#204)".
NOTE
