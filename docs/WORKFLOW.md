# Workflow

Ticketsystem: **GitHub Issues + GitHub Projects.**
Grund: kostenlos, im selben Repo wie der Code, und über die `gh`-CLI direkt für Claude nutzbar —
kein zweites System, kein Kontextbruch.

## Der Zyklus

```
Issue (grobe Idee, vom Handy eingeworfen)
   └─► [optional] needs-research → Opus recherchiert den Fit → needs-input → du entscheidest
Issue (mit Akzeptanzkriterien)
   └─► [nur bei Komplexität] needs-plan → Opus plant im Chat → ready
   └─► Branch feat/<nr>-<slug>
         └─► Implementierung + Playwright-Tests
               └─► PR (Closes #<nr>)
                     └─► CI grün → Merge → Issue schließt automatisch
                           └─► nächstes Issue
```

**WIP-Limit = 1.** Es gibt zu keinem Zeitpunkt zwei offene Feature-Branches.
Nichts läuft parallel. Das ist die wichtigste Regel im Repo.

**Recherche-Schritt vor `needs-plan` (optional, Idee-Ebene):** Wirfst du eine grobe
Feature-Idee als Issue ein, setzt du das Label `needs-research`. Der Runner lässt
Opus dann nur-lesend prüfen, *ob* & *was*: Fit zu `docs/VISION.md`,
`docs/ARCHITECTURE.md`, `docs/DESIGN_SYSTEM.md` und bestehendem Code, 2–3 Ansätze
mit Trade-offs, Empfehlung, **grober** Schnitt — **kein dateiweiser Plan, kein
Code-Wie**, das ist eine Stufe abstrakter als `needs-plan`. Widerspricht die Idee
der Vision, steht das klar in der Überlegung — Opus verwirft sie nicht
eigenmächtig, das entscheidest du. Ist die Überlegung fertig, tauscht der
abschließende Lauf `needs-research` gegen `needs-input`; sagst du dann „ja",
nimmst du `needs-input` runter und setzt `needs-plan` — erst der Planer-Lauf macht
daraus einen dateiweisen Umsetzungsplan (die Konzept-Entscheidung aus der
Recherche wird dabei nicht neu aufgerollt).

**Planungsschritt vor `ready`:** Komplexe Tickets (mehrdeutig, architektonisch,
mehrere Dateien, geschützte Pfade, Migrationen, Krypto, Sync) bekommen zuerst das
Label `needs-plan`. Geplant wird von Opus, nie gebaut — siehe `docs/TOKEN-BUDGET.md`
und `docs/adr/0005-opus-im-runner.md` — bis Schrittfolge, Testplan, Risiko/Rückweg und
Wiederaufnahmepunkte konkret genug sind, dass Sonnet/Haiku keine
Architektur-Entscheidungen mehr treffen müssen. Erst danach: `needs-plan` runter,
`ready` rauf.

**Automatik im Runner:** Ein `needs-plan`-Ticket (ohne `needs-input`, ohne
`no-opus`) wird vom Runner selbst mit Opus geplant — streng nur-lesend
(`--allowedTools "Read,Grep,Glob,Bash"`, kein Branch, kein Commit). Der Plan
entsteht inkrementell in **einem** Kommentar (`--edit-last`); erst der
abschließende Lauf entfernt `needs-plan` und setzt `ready`. Bricht ein
Planer-Lauf ab (Limit, Timeout), bleiben Label, Teilplan und
Wiederaufnahme-Marker stehen — der nächste Lauf setzt dort fort, nie von vorne.
Ein Ticket mit **beiden** Labeln `needs-plan` und `ready` gilt als inkonsistent
und wird als `needs-plan` behandelt, nicht gebaut. `needs-research` läuft
genauso (eigener Recherche-Prompt statt Planungs-Prompt, `--allowedTools
"Read,Grep,Glob,Bash,WebSearch"` — die bounded Web-Recherche aus dem
Recherche-Prompt braucht das zusätzliche Werkzeug), flippt aber auf
`needs-input` statt `ready`, weil danach eine Entscheidung ansteht, kein Bau.
Für **kein** Denk-Label (`needs-plan` oder `needs-research`) gibt es einen
Tages-Deckel — Planung und Recherche laufen so oft, wie sie brauchen (siehe
ADR-0005, PR #46). Kill-Switch für beide: `no-opus`.

Reihenfolge, wenn mehrere Labels gleichzeitig offen stehen: ein laufendes
`in-progress`-Bau-Ticket geht vor, danach `needs-plan`, danach `needs-research`,
erst danach `ready`. Ein Ticket mit `needs-research` **und** `ready` gleichzeitig
gilt ebenso als inkonsistent wie bei `needs-plan` — es wird über den
Recherche-Zweig gefangen, nicht gebaut.

Einfache/mechanische Tickets (klarer CSS-Fix, Doku, Umbenennung) überspringen
`needs-plan` und gehen direkt auf `ready` — der Planungsschritt würde hier nur
Tokens kosten, ohne die Ausführung konkreter zu machen.

**Kein Code-Änderungsbedarf am Runner:** Er nimmt ohnehin nur Tickets mit `ready`.
Ein Ticket mit `needs-plan` oder `needs-research` und ohne `ready` liegt
automatisch still, auch ohne eigene Guard-Logik im Runner-Skript.

## Labels — sie steuern den Runner

Der Runner (`scripts/claude-runner.sh`) liest ausschließlich Labels. Sie sind die
Zustandsmaschine des ganzen Setups:

| Label            | Bedeutung                                                      | Wer setzt es |
| ---------------- | -------------------------------------------------------------- | ------------ |
| `needs-research` | Grobe Idee, noch kein Ticket — Opus recherchiert den Fit, dann `needs-input`. | **Du**       |
| `needs-plan`     | Ticket erfasst, aber noch nicht baubereit — Opus plant im Chat. | **Du** oder Runner (beim Auslagern eines Fund-Tickets) |
| `ready`          | Von dir freigegeben. Claude darf das Ticket nehmen.            | **Du**       |
| `in-progress`    | Claude arbeitet daran. Es gibt immer höchstens eins.           | Runner       |
| `needs-input`    | **Claude hat eine Frage gestellt und wartet auf dich.**        | Claude       |
| `blocked-limit`  | Usage-Limit erreicht. Wird automatisch fortgesetzt.            | Runner       |
| `human-approved` | **Deine Freigabe** für einen PR, der geschützte Pfade berührt. | **Du**       |
| `model:haiku`    | Mechanisches Ticket — Runner nimmt Haiku statt Sonnet.         | **Du**       |
| `no-escalation`  | Kill-Switch: Ticket bleibt immer auf Sonnet/Haiku, nie Opus.   | **Du**       |

Der Runner nimmt nur Tickets mit `ready`, die **nicht** `needs-input` tragen.
Ein Ticket ohne `ready` fasst er nicht an — so entscheidest **du**, was gebaut wird,
auch wenn zwanzig Tickets im Backlog liegen. Ein `needs-plan`-Ticket trägt per
Definition kein `ready`, solange der Plan fehlt — es bleibt also automatisch liegen.

## Modell-Eskalation beim Bauen (ADR-0007)

Bleibt ein Ticket in der Bau-Rolle dreimal in Folge ohne Fortschritt stecken,
schaltet der Runner eine Modellstufe hoch: `sonnet` (bzw. `haiku` bei
`model:haiku`) → `opus`. Auf `opus` baut der letzte Versuch tatsächlich Code —
das ist die einzige Stelle im Repo, an der Opus schreibt statt nur zu lesen.

- **Fortschritt** = neuer Commit auf dem Feature-Branch (Vergleich der
  Branch-Spitze auf `origin` vor/nach dem Lauf). Fortschritt setzt Stufe und
  Fehlversuchs-Zähler zurück.
- **Kein Fortschritt** = kein neuer Commit **und** dieselbe Blocker-Signatur
  wie im Vorlauf (siehe #33). Ein Lauf, der durch Limit oder Notbremse
  unterbrochen wurde, zählt nie als Fehlversuch.
- Bleibt Opus als höchste Stufe ebenfalls dreimal ohne Fortschritt: Stop,
  Label `needs-input`, Blocker-Kommentar am Ticket.
- **Opus-Deckel:** höchstens 2 Opus-Bau-Läufe pro Ticket und Kalendertag.
  Überschreitung → sofort `needs-input`, kein weiterer Opus-Bau-Versuch an
  diesem Tag.
- Zustand liegt dateibasiert unter `.runner/` (`tier-<nr>`, `failcount-<nr>`,
  `opus-<datum>-<nr>`) und überlebt Neustarts.

Details und Begründung: `docs/adr/0007-opus-eskalation-baut.md`.

**Dein Handy-Workflow:** Frage kommt als Issue-Kommentar rein (GitHub-App pingt dich)
→ du antwortest als Kommentar → du entfernst `needs-input` → beim nächsten Lauf
(max. 20 Minuten später) macht Claude weiter.

## Merge: automatisch, aber nicht ungeprüft

Claude merged selbst — aber nur über `gh pr merge --auto`. Der Merge wird damit
_beantragt_, nicht ausgeführt: GitHub führt ihn aus, sobald alle Required Checks
grün sind. Ein roter Check bedeutet: kein Merge, egal was Claude denkt.

**Branch-Schutz auf `main` (zwingend einzurichten, sonst hängt alles in der Luft):**

```bash
gh api -X PUT repos/:owner/:repo/branches/main/protection \
  -F required_status_checks.strict=true \
  -f 'required_status_checks.contexts[]=quality' \
  -f 'required_status_checks.contexts[]=e2e' \
  -f 'required_status_checks.contexts[]=test-integrity' \
  -f 'required_status_checks.contexts[]=protected-paths' \
  -F enforce_admins=false \
  -F required_pull_request_reviews=null \
  -F restrictions=null
gh repo edit --enable-auto-merge --enable-squash-merge --delete-branch-on-merge
```

**Zwei Wächter machen den Auto-Merge erst vertretbar:**

- `test-integrity` — lehnt jeden PR ab, der Tests entfernt, abschaltet
  (`.skip`, `.only`) oder mit `waitForTimeout` grün macht. Reine Textprüfung,
  kein Modell beteiligt.
- `protected-paths` — schlägt fehl, sobald `src/db/`, `src/crypto/`, `src/local/`,
  `src/app/api/sync/`, Auth, `.github/` oder `scripts/` berührt werden. Der PR bleibt
  offen, bis **du** das Label `human-approved` setzt. Danach läuft der Check
  automatisch neu und der Merge greift.

Alles andere — UI, Features, Styling, Doku — merged Claude ohne dich.

## Der Status auf einen Blick

Ein angepinntes Status-Issue wird vom Runner per _Edit_ aktualisiert
(nicht per Kommentar — sonst bekommst du im Minutentakt Push-Nachrichten).

**Die Farbe steht im Titel, nicht nur im Text.** Damit siehst du den Zustand schon in
der Issue-Liste auf dem Handy und musst nicht hineinklicken:

| Titel | Bedeutung | Musst du etwas tun? |
|---|---|---|
| 🟠 `Runner · arbeitet an #42 (seit 18:49)` | Lauf läuft gerade, vor dem `claude`-Aufruf gesetzt | nein |
| 🟢 `Runner · wartet auf nächsten Lauf · als Nächstes #43` | idle (kein laufender Prozess), Queue nicht leer, nächster Takt startet automatisch | nein |
| 🟢 `Runner · nichts offen · zuletzt #42` | idle, Queue leer | nein |
| 🟡 `Runner · wartet auf dich (#42)` | Frage offen oder Freigabe nötig | **ja** |
| 🔴 `Runner · Fehler bei #42` | abgebrochen, Details am Ticket | **ja** |
| 🔵 `Runner · Limit erreicht · #42 pausiert` | macht von selbst weiter | nein |
| ⚪️ `Runner · nichts zu tun` | kein Ticket auf `ready`, `needs-plan` oder `needs-research` | nein (außer du willst was) |

🟢 heißt jetzt ausdrücklich **idle**: kein laufender Prozess, egal ob noch Arbeit
in der Queue liegt oder nicht — das unterscheidet den Titel klar von 🟠.

Nur **Gelb und Rot** verlangen dich. Alles andere ist Information.

Gelb erscheint auch dann, wenn der Runner selbst gerade nichts zu tun hat, aber
irgendwo ein `needs-input` hängt — „nichts zu tun" wäre in dem Fall eine Lüge,
die dich das Ticket übersehen ließe.

## Board-Spalten

`Backlog` → `Ready` → `In Progress` (max. 1) → `In Review` → `Done`

## Definition of Ready

Ein Issue darf erst nach `Ready`, wenn es enthält:

- **Ziel** in einem Satz (was soll danach möglich sein)
- **Akzeptanzkriterien** im Given/When/Then-Format
- **Nicht-Ziele** (was in diesem Ticket ausdrücklich nicht passiert)
- **Betroffener Milestone**

Ein Ticket mit dem Label `needs-plan` ist per Definition **nicht** ready — ihm fehlt
der Plan aus dem vorherigen Abschnitt (Schrittfolge, Testplan, Risiko/Rückweg,
Wiederaufnahmepunkte). Erst wenn Opus diesen Plan im Chat ergänzt hat und
`needs-plan` gegen `ready` tauscht, darf der Runner es nehmen.

### Issue-Template

```markdown
## Ziel

Ich kann eine Aufgabe erfassen, ohne dafür die Ansicht zu wechseln.

## Akzeptanzkriterien

- [ ] Given ich bin auf "Aufgaben", When ich auf den FAB tippe,
      Then öffnet sich ein Bottom-Sheet mit fokussiertem Titelfeld.
- [ ] Given ich bin offline, When ich eine Aufgabe speichere,
      Then erscheint sie sofort in der Liste und die Outbox enthält einen Eintrag.
- [ ] Given ich war offline und werde online, When der Sync läuft,
      Then existiert die Aufgabe serverseitig.

## Betroffene Dateien

<!-- Wird beim Ticketschreiben ausgefüllt. Spart dem Agenten die Suche = spart Tokens. -->

- `src/features/tasks/quick-add.tsx` (neu)
- `src/local/outbox.ts` (lesen, nicht ändern)
- `tests/tasks.spec.ts` (erweitern)

## Nicht-Ziele

- Keine Wiederholungsregeln (eigenes Ticket)
- Keine Anhänge

## Milestone

M1 – Aufgaben
```

Die Akzeptanzkriterien sind kein Prosa-Wunsch, sondern die **Spezifikation der Playwright-Tests**.
Was nicht als Kriterium dasteht, wird nicht gebaut.

## Branch & Commit

- Branch: `feat/42-quick-add-task`
- Commits: Conventional Commits — `feat(tasks): add bottom sheet quick add`
- PR-Beschreibung: was, warum, was bewusst nicht. Screenshot bei UI-Änderungen.

## CI (GitHub Actions, bei jedem PR)

1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test` (Vitest)
4. `pnpm e2e` (Playwright, gegen Preview-Deployment)

**Kein Merge bei rotem Build. Keine Ausnahme.**

## Playwright-Regeln

- Konfiguration: `trace: 'retain-on-failure'`, `screenshot: 'only-on-failure'`,
  `video: 'retain-on-failure'`, HTML-Reporter.
- **Bei rotem Test wird der Trace gelesen, bevor irgendetwas geändert wird.**
  `npx playwright show-trace test-results/…/trace.zip` — erst verstehen, dann fixen.
- Der Fix behebt die Ursache. **Nie** den Test aufweichen: kein `test.skip`,
  kein hochgesetzter Timeout als Lösung, kein gelockertes Assert, kein `waitForTimeout`.
- Selektoren über `getByRole` / `getByLabel`. Keine CSS-Klassen als Selektor.
- Jeder Feature-Test läuft in beiden Viewports: 375 × 812 (iPhone) und 1280 × 800.
- **Offline-Tests sind Pflicht** — `context.setOffline(true)`, Mutation, wieder online,
  Assertion gegen den Serverzustand.

## Was Claude autonom darf und was nicht

**Darf:**

- Issues lesen, kommentieren, Branch anlegen, implementieren, testen, PR öffnen
- Fehlgeschlagene Tests analysieren und beheben
- Neue Issues für Gefundenes anlegen (statt es nebenbei mitzuerledigen)

**Darf nicht ohne Rückfrage:**

- Neue Dependencies einführen (→ ADR)
- Das Datenmodell ändern (→ ADR + Migration)
- Von Vision oder Architektur abweichen
- Nach `main` pushen oder den eigenen PR mergen
- Ein Ticket beginnen, während ein anderes offen ist

## Nützliche Befehle

```bash
gh issue list --milestone "M1 – Aufgaben" --state open
gh issue view 42
gh pr create --fill --title "feat(tasks): quick add — Closes #42"
gh pr checks           # CI-Status
gh run view --log-failed
```
