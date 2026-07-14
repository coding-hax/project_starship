#!/usr/bin/env bash
# Claude-Runner: pollt GitHub Issues, arbeitet EIN Ticket, überlebt Limits.
# Läuft per systemd-Timer alle 20 Minuten. Braucht: gh, jq, claude, flock.
set -uo pipefail

REPO_DIR="${REPO_DIR:-$HOME/projects/meine-app}"
STATUS_ISSUE="${STATUS_ISSUE:-1}"     # Nr. des angepinnten Issues "🚦 Runner-Status"
MAX_RUNTIME="${MAX_RUNTIME:-45m}"     # Notbremse gegen hängende Läufe
STATE_DIR="$REPO_DIR/.runner"

cd "$REPO_DIR" || exit 1
mkdir -p "$STATE_DIR"

# --- Nie zwei Läufe gleichzeitig -------------------------------------------
exec 9>"$STATE_DIR/lock"
flock -n 9 || { echo "läuft bereits"; exit 0; }

ts() { date "+%d.%m. %H:%M"; }

status() {   # Status-Issue per EDIT aktualisieren, nicht per Kommentar
             # (sonst bekommst du bei jedem Lauf eine Push-Nachricht aufs Handy)
  gh issue edit "$STATUS_ISSUE" --body "$1" >/dev/null 2>&1
}

# --- Welches Ticket? --------------------------------------------------------
# 1) Läuft schon eins? -> fortsetzen (WIP-Limit = 1)
ISSUE=$(gh issue list --label in-progress --state open --limit 1 \
          --json number -q '.[0].number // empty')
MODE=resume

if [ -z "$ISSUE" ]; then
  # 2) Sonst: ältestes Ticket mit Label "ready", das nicht auf mich wartet
  ISSUE=$(gh issue list --label ready --state open --limit 30 \
            --json number,labels \
            -q '[.[] | select((.labels | map(.name)
                   | index("needs-input")) | not)]
                | sort_by(.number) | .[0].number // empty')
  [ -z "$ISSUE" ] && { status "✅ Nichts zu tun — kein Ticket mit Label \`ready\`.
_Stand: $(ts)_"; exit 0; }
  gh issue edit "$ISSUE" --add-label in-progress --remove-label ready >/dev/null
  MODE=start
fi

SID_FILE="$STATE_DIR/session-$ISSUE"
LOG="$STATE_DIR/last-run.log"

# --- Modell nach Label ------------------------------------------------------
# Mechanische Tickets (Umbenennen, Doku, Boilerplate) brauchen kein Sonnet.
LABELS=$(gh issue view "$ISSUE" --json labels -q '.labels[].name' | tr '\n' ' ')
case "$LABELS" in
  *model:haiku*) MODEL="haiku" ;;
  *)             MODEL="sonnet" ;;
esac

# --- Der Prompt -------------------------------------------------------------
read -r -d '' PROMPT <<EOF
Du arbeitest UNBEAUFSICHTIGT. Es sitzt niemand am Terminal.

Arbeite an Issue #$ISSUE in diesem Repo.

Ablauf:
1. Lies CLAUDE.md und die Dokumente in docs/.
2. Lies das Issue: gh issue view $ISSUE --comments
3. Falls es bereits einen Branch und einen Fortschrittskommentar gibt:
   checke den Branch aus, lies den Fortschrittskommentar und 'git log',
   und mach beim nächsten offenen Punkt weiter. Fang NICHT von vorne an.
4. Arbeite die Akzeptanzkriterien ab. Committe nach jedem abgeschlossenen
   Schritt und pushe den Branch.
5. Halte den Fortschrittskommentar am Issue nach JEDEM Schritt aktuell.
6. Wenn du eine Entscheidung brauchst: Kommentar am Issue mit konkreten
   Optionen und deiner Empfehlung, Label 'needs-input' setzen, beenden.
   Rate niemals. Schreib die Frage NICHT nach stdout.
7. Wenn fertig: PR öffnen, 'gh pr merge --squash --auto --delete-branch',
   dann 'gh pr checks --watch'. GitHub merged, sobald die Checks grün sind.
   Bei rotem Check: Ursache beheben, erneut pushen. Nach dem 3. Fehlversuch
   aufgeben -> Kommentar + Label 'needs-input'.
   Bei fehlgeschlagenem Check 'protected-paths': Kommentar schreiben, der die
   Aenderung erklaert, Label 'needs-input' setzen, beenden. Das Label
   'human-approved' setzt NUR der Mensch.
8. 'in-progress' entfernen, wenn der PR gemerged ist.
EOF

# --- Claude starten ---------------------------------------------------------
ARGS=(-p "$PROMPT" --output-format json
      --model "$MODEL"
      --allowedTools "Read,Edit,Write,Glob,Grep,Bash")
# Hinweis: Opus steht auf dem Pro-Plan in Claude Code NICHT zur Verfügung.
# Geplant wird im Chat, ausgeführt wird hier mit Sonnet bzw. Haiku.

if [ "$MODE" = "resume" ] && [ -s "$SID_FILE" ]; then
  ARGS+=(--resume "$(cat "$SID_FILE")")
fi

OUT=$(timeout "$MAX_RUNTIME" claude "${ARGS[@]}" 2>&1 | tee "$LOG")
RC=$?

# Session-ID sichern (nur Komfort — die echte Wahrheit liegt in Git + Issue)
echo "$OUT" | jq -r '.session_id // empty' 2>/dev/null > "$SID_FILE"

# --- Auswertung -------------------------------------------------------------
if [ $RC -eq 0 ]; then
  gh issue edit "$ISSUE" --remove-label blocked-limit >/dev/null 2>&1
  status "🟢 Läuft. Zuletzt an #$ISSUE gearbeitet.
_Stand: $(ts)_"
  exit 0
fi

# Exit-Codes von 'claude -p' sind nicht dokumentiert stabil
# -> auf null/nicht-null prüfen und die Ausgabe lesen.
if echo "$OUT" | grep -qiE "usage limit|rate limit|limit reached|quota"; then
  gh issue edit "$ISSUE" --add-label blocked-limit >/dev/null
  status "⏸️ **Limit erreicht.** Ticket #$ISSUE ist angehalten und wird
automatisch fortgesetzt, sobald wieder Kontingent da ist.
Nächster Versuch: in ~20 Minuten.
_Stand: $(ts)_"
  exit 0     # kein Fehler — der Timer probiert es einfach wieder
fi

if [ $RC -eq 124 ]; then
  status "⏱️ Lauf an #$ISSUE nach $MAX_RUNTIME abgebrochen (Notbremse).
Wird beim nächsten Lauf fortgesetzt.
_Stand: $(ts)_"
  exit 0
fi

gh issue comment "$ISSUE" --body "🤖 Der Runner ist mit einem Fehler abgebrochen (Exit $RC).
Letzte Zeilen:
\`\`\`
$(tail -n 20 "$LOG")
\`\`\`"
gh issue edit "$ISSUE" --add-label needs-input >/dev/null
status "❌ Fehler bei #$ISSUE — Details stehen als Kommentar am Ticket.
_Stand: $(ts)_"
exit 1
