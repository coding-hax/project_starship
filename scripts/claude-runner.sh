#!/usr/bin/env bash
# Claude-Runner: pollt GitHub Issues, arbeitet EIN Ticket, überlebt Limits.
# Läuft per launchd (macOS) oder systemd (Linux) alle 20 Minuten.
#
# Braucht: gh, jq und die EIGENSTÄNDIGE claude-CLI im PATH.
# (Die VS-Code-Erweiterung zählt nicht — sie legt `claude` nicht in den PATH.)
#
# Bewusst OHNE flock und timeout: beides sind GNU-Werkzeuge und fehlen auf macOS.
# Das Skript bringt portable Ersatzlösungen mit und läuft so auf beiden Systemen.
set -uo pipefail

REPO_DIR="${REPO_DIR:-$HOME/Documents/Max/vsc/claude proj/project_starship}"
STATUS_ISSUE="${STATUS_ISSUE:-0}"       # Nr. des angepinnten Runner-Status-Issues
MAX_RUNTIME="${MAX_RUNTIME:-2700}"      # Sekunden. Notbremse gegen hängende Läufe.
STATE_DIR="$REPO_DIR/.runner"

cd "$REPO_DIR" || { echo "REPO_DIR nicht gefunden: $REPO_DIR" >&2; exit 1; }
mkdir -p "$STATE_DIR"

for tool in gh jq claude; do
  command -v "$tool" >/dev/null 2>&1 || { echo "'$tool' fehlt im PATH." >&2; exit 1; }
done

# --- Nie zwei Läufe gleichzeitig -------------------------------------------
# mkdir ist atomar auf POSIX — das ersetzt flock, das es auf macOS nicht gibt.
LOCK="$STATE_DIR/lock.d"
if ! mkdir "$LOCK" 2>/dev/null; then
  OWNER=$(cat "$LOCK/pid" 2>/dev/null || echo "")
  if [ -n "$OWNER" ] && kill -0 "$OWNER" 2>/dev/null; then
    echo "läuft bereits (PID $OWNER)"; exit 0
  fi
  # Verwaister Lock (Rechner abgestürzt, Prozess tot) — übernehmen.
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null || { echo "läuft bereits"; exit 0; }
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

ts() { date "+%d.%m. %H:%M"; }

# Status-Issue per EDIT aktualisieren, nicht per Kommentar
# (sonst bekommst du bei jedem Lauf eine Push-Nachricht aufs Handy).
#
# Die Farbe steht im TITEL, nicht nur im Text: auf dem Handy sieht man in der
# Issue-Liste sonst nur die statische Ampel und muss reinklicken, um den Zustand
# zu erfahren. Genau das soll man sich sparen.
#
#   🟢 läuft            – nichts zu tun
#   🟡 wartet auf dich  – EINGREIFEN (Frage offen oder Freigabe nötig)
#   🔴 Fehler           – EINGREIFEN
#   🔵 Limit erreicht   – pausiert, läuft von selbst weiter
#   ⚪️ nichts zu tun    – kein Ticket auf `ready`
status() {   # $1 = Titelzeile (ohne Emoji), $2 = Emoji, $3 = Text
  [ "$STATUS_ISSUE" -gt 0 ] 2>/dev/null || return 0
  gh issue edit "$STATUS_ISSUE" \
    --title "$2 Runner · $1" \
    --body "$3

_Stand: $(ts)_" >/dev/null 2>&1
}

# Wartet irgendein Ticket auf den Menschen? Dann ist Gelb die Wahrheit,
# auch wenn der Runner selbst gerade nichts zu tun hat.
waiting_issues() {
  gh issue list --label needs-input --state open --limit 20 \
    --json number -q '[.[].number] | map("#" + tostring) | join(", ")' 2>/dev/null
}

# --- Ersatz für `timeout` (fehlt auf macOS) --------------------------------
TIMED_OUT="$STATE_DIR/timed-out"
run_limited() {   # $1 = Sekunden, Rest = Befehl. Ausgabe geht nach $LOG.
  local secs="$1"; shift
  rm -f "$TIMED_OUT"

  "$@" > "$LOG" 2>&1 &
  local cmd_pid=$!

  (
    sleep "$secs"
    if kill -0 "$cmd_pid" 2>/dev/null; then
      touch "$TIMED_OUT"
      kill -TERM "$cmd_pid" 2>/dev/null
      sleep 10
      kill -KILL "$cmd_pid" 2>/dev/null
    fi
  ) &
  local watchdog=$!

  wait "$cmd_pid"; local rc=$?
  kill "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  return $rc
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
  if [ -z "$ISSUE" ]; then
    # Nichts zu holen. Aber liegt etwas bei DIR? Dann ist Gelb die Wahrheit —
    # "nichts zu tun" wäre hier eine Lüge, die dich das Ticket übersehen lässt.
    WAITING=$(waiting_issues)
    if [ -n "$WAITING" ]; then
      status "wartet auf dich ($WAITING)" "🟡" \
        "🟡 **Ich warte auf eine Antwort von dir.**

Offene Fragen an: $WAITING

Antworte als Kommentar am Ticket und **entferne dann das Label \`needs-input\`** —
sonst starte ich in 20 Minuten mit derselben offenen Frage neu."
    else
      status "nichts zu tun" "⚪️" \
        "⚪️ Kein Ticket mit Label \`ready\`. Ich habe nichts zu arbeiten.

Gib ein Ticket frei, indem du ihm das Label \`ready\` gibst."
    fi
    exit 0
  fi
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
# Hinweis: Opus ist fuer den Runner tabu (siehe docs/TOKEN-BUDGET.md).
# Geplant wird im Chat, ausgefuehrt wird hier mit Sonnet bzw. Haiku.

if [ "$MODE" = "resume" ] && [ -s "$SID_FILE" ]; then
  ARGS+=(--resume "$(cat "$SID_FILE")")
fi

run_limited "$MAX_RUNTIME" claude "${ARGS[@]}"
RC=$?
OUT=$(cat "$LOG" 2>/dev/null || echo "")

# Session-ID sichern (nur Komfort — die echte Wahrheit liegt in Git + Issue)
echo "$OUT" | jq -r '.session_id // empty' 2>/dev/null > "$SID_FILE"

# --- Auswertung -------------------------------------------------------------
if [ $RC -eq 0 ]; then
  gh issue edit "$ISSUE" --remove-label blocked-limit >/dev/null 2>&1

  # Der Lauf war sauber — aber hat Claude dabei eine Frage gestellt?
  # Dann wartet das Ticket jetzt auf dich, und Grün wäre irreführend.
  WAITING=$(waiting_issues)
  if [ -n "$WAITING" ]; then
    status "wartet auf dich ($WAITING)" "🟡" \
      "🟡 **Ich warte auf eine Antwort von dir.**

Offene Fragen an: $WAITING

Antworte als Kommentar am Ticket und **entferne dann das Label \`needs-input\`**.
Betrifft es einen PR mit geschützten Pfaden, setzt du stattdessen \`human-approved\`."
  else
    status "läuft · zuletzt #$ISSUE" "🟢" \
      "🟢 **Läuft.** Zuletzt an #$ISSUE gearbeitet. Nichts zu tun für dich."
  fi
  exit 0
fi

# Exit-Codes von 'claude -p' sind nicht dokumentiert stabil
# -> auf null/nicht-null prüfen und die Ausgabe lesen.
if echo "$OUT" | grep -qiE "usage limit|rate limit|limit reached|quota"; then
  gh issue edit "$ISSUE" --add-label blocked-limit >/dev/null
  status "Limit erreicht · #$ISSUE pausiert" "🔵" \
    "🔵 **Limit erreicht.** Ticket #$ISSUE ist angehalten und wird automatisch
fortgesetzt, sobald wieder Kontingent da ist. Nächster Versuch: in ~20 Minuten.

**Kein Eingreifen nötig.** Der Arbeitsstand liegt in Git und im Fortschrittskommentar,
nicht in der Session."
  exit 0     # kein Fehler — der Timer probiert es einfach wieder
fi

if [ -f "$TIMED_OUT" ]; then
  rm -f "$TIMED_OUT"
  status "Notbremse bei #$ISSUE" "🔵" \
    "🔵 Lauf an #$ISSUE nach ${MAX_RUNTIME}s abgebrochen (Notbremse gegen hängende Läufe).
Wird beim nächsten Lauf fortgesetzt. **Kein Eingreifen nötig.**"
  exit 0
fi

gh issue comment "$ISSUE" --body "🤖 Der Runner ist mit einem Fehler abgebrochen (Exit $RC).
Letzte Zeilen:
\`\`\`
$(tail -n 20 "$LOG")
\`\`\`"
gh issue edit "$ISSUE" --add-label needs-input >/dev/null
status "Fehler bei #$ISSUE" "🔴" \
  "🔴 **Fehler bei #$ISSUE.** Der Runner ist abgebrochen (Exit $RC).

Die Details stehen als Kommentar am Ticket. Ich fasse #$ISSUE nicht wieder an,
solange das Label \`needs-input\` hängt."
exit 1
