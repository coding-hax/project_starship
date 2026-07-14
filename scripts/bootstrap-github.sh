#!/usr/bin/env bash
# Einmaliges GitHub-Setup für dieses Repo (START-HERE.md, Schritt 8).
#
# Legt an: privates Repo, Labels, Milestones, Issue-Template, Status-Issue,
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
label "in-progress"    "FBCA04" "Claude arbeitet daran. Es gibt immer höchstens eins."
label "needs-input"    "D93F0B" "Claude hat eine Frage gestellt und wartet auf dich."
label "blocked-limit"  "C5DEF5" "Usage-Limit erreicht. Wird automatisch fortgesetzt."
label "human-approved" "5319E7" "Deine Freigabe für einen PR, der geschützte Pfade berührt."
label "model:haiku"    "BFDADC" "Mechanisches Ticket — Runner nimmt Haiku statt Sonnet."

# --- 3. Milestones ---------------------------------------------------------
echo "==> Milestones"
milestone() {
  gh api "repos/$SLUG/milestones" -f title="$1" -f description="$2" >/dev/null 2>&1 \
    && echo "    $1" || echo "    $1 (existiert)"
}
milestone "M0 – Fundament"       "Repo, CI, Passkey-Login, Design-Tokens, App-Shell, PWA, Sync-Grundgerüst"
milestone "M1 – Aufgaben"        "CRUD, Fälligkeit, Priorität, Swipe-Erledigen, offline"
milestone "M2 – Termine (lokal)" "Tages-/Wochenansicht, CRUD, Serientermine"
milestone "M3 – Journal"         "Editor, Stimmung, Tags, lokale Suche, E2E-Verschlüsselung"
milestone "M4 – Gewohnheiten"    "Habits, Abhaken, Streaks, Wochenraster"
milestone "M5 – Heute-Dashboard" "Zusammenführung, Web Push für Erinnerungen"
milestone "M6 – Sprachmemo"      "Aufnahme → Transkript → strukturierter Terminvorschlag"

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
    "contexts": ["quality", "e2e", "test-integrity", "protected-paths"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
echo "    Required Checks: quality, e2e, test-integrity, protected-paths"

echo ""
echo "Fertig. Prüfen:"
echo "  gh api repos/$SLUG/branches/main/protection -q '.required_status_checks.contexts'"
echo ""
echo "Trag STATUS_ISSUE=$STATUS_ISSUE in ~/Library/LaunchAgents/de.starship.runner.plist ein."
