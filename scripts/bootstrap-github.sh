#!/usr/bin/env bash
# Einmaliges GitHub-Setup für dieses Repo (START-HERE.md, Schritt 8).
#
# Legt an: privates Repo, Labels, Issue-Template, Status-Issue,
# Branch-Schutz auf main. Idempotent — ein zweiter Lauf schadet nicht.
#
# Voraussetzung: gh auth login ist durch.
set -euo pipefail

REPO_NAME="${REPO_NAME:-project-starship}"

command -v gh >/dev/null || { echo "gh fehlt."; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Nicht eingeloggt. Erst: gh auth login"; exit 1; }

OWNER=$(gh api user -q .login)
SLUG="$OWNER/$REPO_NAME"
echo "==> Repo: $SLUG"

# --- 1. Repo ---------------------------------------------------------------
if gh repo view "$SLUG" >/dev/null 2>&1; then
  echo "    existiert bereits."
else
  gh repo create "$SLUG" --private --source=. --remote=origin --push
  echo "    angelegt und gepusht."
fi

git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$SLUG.git"
git push -u origin main 2>/dev/null || true

# --- 2. Labels -------------------------------------------------------------
# Sie sind die Zustandsmaschine des Runners (docs/WORKFLOW.md).
echo "==> Labels"
label() { gh label create "$1" --color "$2" --description "$3" --force >/dev/null; echo "    $1"; }
label "ready"          "0E8A16" "Freigegeben. Claude darf das Ticket nehmen."
# Der Rang (#725, S2 von ADR-0023): schlägt die Label-Kaskade komplett, Position
# 2 direkt hinter einem laufenden 'in-progress'. Ersetzt die Zeilenreihenfolge
# im früheren Queue-Issue (#92) — fällt erst mit dem Ticket selbst weg, nicht
# schon beim Start eines Bau-Laufs.
label "next"           "FF6B6B" "Vor allem anderen — die Queue."
label "in-progress"    "FBCA04" "Claude arbeitet daran. Es gibt immer höchstens eins je Slot (#204)."
label "needs-answer"   "B60205" "Es steht eine Frage im Ticket. Ohne deine geschriebene Antwort geht es nicht weiter."
label "blocked-limit"  "C5DEF5" "Opus-Tagesbudget für dieses Ticket erschöpft. Läuft morgen von selbst weiter."
# Setzt und entfernt der Runner selbst, aus einer 'Nach:'-Zeile im Ticket-Body.
# Von Hand gepflegt würde es verrotten — und dann nie wieder gebaut, still.
label "blocked-by"     "D4C5F9" "Wartet auf ein anderes Ticket (siehe Queue). Der Runner pflegt es selbst."
# Startstufe für dieses Ticket (ADR-0013). Höchstens eins davon setzen; eine
# schon eingetretene Eskalation schlägt das Label — es ist der Start, nicht die
# Fessel.
label "model:haiku"    "BFDADC" "Startstufe Haiku — mechanisches Ticket."
label "model:sonnet"   "9CC3C7" "Startstufe Sonnet — der Normalfall, muss man selten setzen."
label "model:opus"     "8B5CF6" "Startstufe Opus — baut sofort, ohne die drei erfolglosen Läufe."
label "tests-exempt"   "FEF2C0" "Testlose Änderung (Refactor/Typen) — vom Menschen freigegeben."
label "hands-off"      "44546A" "Der Runner fasst dieses Ticket nicht an — auf keinem Zweig."
label "plan"           "1D76DB" "Rolle: plant das Ticket, statt es zu bauen (Opus, außer ein model:*-Label sagt etwas anderes)."
label "research"       "0052CC" "Rolle: recherchiert den Fit und schlägt vor (Opus, außer ein model:*-Label sagt etwas anderes)."
label "check"          "2DA44E" "Rolle: prüft den fertigen Diff gegen die Akzeptanzkriterien — das Tor vor dem Merge (#839)."
# Eskalations-Schalter (ADR-0007). Fehlten hier bis #266 -- ein frisch
# aufgesetztes Repo hatte den Kill-Switch gegen den Opus-Bau also gar nicht.
label "no-escalation"  "5319E7" "Friert das Ticket auf der Startstufe ein — der Runner schaltet nie selbst hoch."
label "opus-boost"     "B197FC" "Hebt den Opus-Tagesdeckel für dieses Ticket einmalig auf."
# Reine Sortier-Labels: sie steuern nichts, sie beschriften nur.
label "bug"            "D73A4A" "Etwas funktioniert nicht."
label "epic"           "006B75" "Rein zum Sortieren — steuert nichts im Runner. Markiert zusammenhängende Tickets."

# --- 3. Milestones ---------------------------------------------------------
# Absichtlich keine. Die Roadmap steht ausschliesslich in docs/VISION.md.
# Die Milestones hier waren eine zweite Kopie davon, die nach der Neusortierung
# vom 16.07.26 nie nachgezogen wurde: ab M2 trug dieselbe Nummer in beiden
# Quellen einen anderen Inhalt. Zwei Roadmaps, eine gepflegt.

# --- 4. Status-Issue -------------------------------------------------------
# Der Runner schreibt die Farbe in den TITEL, damit man den Zustand in der
# Issue-Liste sieht, ohne reinzuklicken. Der Titel ändert sich also laufend —
# gesucht wird deshalb nach dem stabilen Teil, nicht nach dem ganzen Titel.
# Sonst legt ein zweiter Lauf ein Duplikat an.
echo "==> Status-Issue"
EXISTING=$(gh issue list --state open --limit 50 --json number,title \
             -q '[.[] | select(.title | test("Runner"))] | .[0].number // empty' 2>/dev/null || echo "")
if [ -n "$EXISTING" ]; then
  STATUS_ISSUE="$EXISTING"
  echo "    existiert: #$STATUS_ISSUE"
else
  URL=$(gh issue create --title "⚪️ Runner · nichts zu tun" \
    --body "⚪️ Kein Ticket mit Label \`ready\`. Ich habe nichts zu arbeiten.

_Dieses Issue wird vom Runner per **Edit** aktualisiert, nicht per Kommentar.
Sonst bekommst du im 20-Minuten-Takt eine Push-Nachricht._

**Die Farbe im Titel ist der Zustand:**
🟢 läuft · 🟡 wartet auf dich · 🔴 Fehler · 🔵 pausiert (Limit) · ⚪️ nichts zu tun")
  STATUS_ISSUE="${URL##*/}"
  echo "    angelegt: #$STATUS_ISSUE"
fi
gh issue pin "$STATUS_ISSUE" >/dev/null 2>&1 && echo "    angepinnt." || echo "    (pin fehlgeschlagen — von Hand anpinnen)"

# Nummer in die launchd-Vorlage schreiben, damit der Runner sie findet.
if [ -f scripts/launchd-setup.md ]; then
  sed -i '' -E "s|(<key>STATUS_ISSUE</key>\n?.*<string>)[0-9]+(</string>)|\1$STATUS_ISSUE\2|" \
    scripts/launchd-setup.md 2>/dev/null || true
fi
echo "    -> STATUS_ISSUE=$STATUS_ISSUE (in die plist eintragen)"

# --- 5. Repo-Einstellungen -------------------------------------------------
echo "==> Auto-Merge, Squash, Branch löschen"
gh repo edit "$SLUG" --enable-auto-merge --enable-squash-merge --delete-branch-on-merge >/dev/null
echo "    gesetzt."

# --- 6. Branch-Schutz ------------------------------------------------------
# OHNE DIESEN SCHRITT IST DER AUTO-MERGE WERTLOS: dann könnte Claude rote PRs mergen.
# Das ist die einzige echte Schranke im ganzen System.
echo "==> Branch-Schutz auf main"
gh api -X PUT "repos/$SLUG/branches/main/protection" \
  --input - >/dev/null <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["quality", "e2e", "test-integrity", "protected-paths", "schema-drift"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
echo "    Required Checks: quality, e2e, test-integrity, protected-paths, schema-drift"

echo ""
echo "Fertig. Prüfen:"
echo "  gh api repos/$SLUG/branches/main/protection -q '.required_status_checks.contexts'"
echo ""
echo "Trag STATUS_ISSUE=$STATUS_ISSUE in ~/Library/LaunchAgents/de.starship.runner.plist ein."
