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

**„Wartend" ist nicht „in Arbeit" (#145).** Ein Ticket, an dem *niemand* sitzt,
weil eine Frage an dich offen ist, belegt keinen Bauplatz — nur ein Ticket, an
dem der Runner gerade tatsächlich baut, tut das. Stellt Claude eine Frage
(Label `needs-input`), gibt das Ticket im selben Zug `in-progress` ab und trägt
stattdessen `parked`: sichtbar wartend, aber frei für die Auswahl des nächsten
Tickets. Antwortest du und entfernst `needs-input`, wird das `parked`-Ticket vor
Queue und Label-Kaskade fortgesetzt (Branch, `git log` und Fortschrittskommentar
wie gewohnt — kein Neuanfang). Das gilt **nicht** für `blocked-limit`: ein
Usage-Limit löst sich von selbst in Minuten und bleibt bewusst `in-progress`, der
Runner fängt in der Zwischenzeit nichts Neues an (siehe Abschnitt „Zwei Arten des
Wartens" unten).

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

**Die Prioritäts-Queue (#91, umgebaut #109) — eine flache Reihenfolge, Label egal:**
Das angepinnte **Queue-Issue** (`QUEUE_ISSUE`) ist eine schlichte, geordnete Liste von
`#NN`. **Wer gelistet ist, wird bearbeitet — in genau dieser Reihenfolge**, ganz ohne
`ready` zu setzen. Das Eintragen in die Queue **ersetzt** die `ready`-Freigabe.

```
#101
#98
#104
```

Zahlen oben = zuerst. Wichtig:

- **Das Label ist für die Auswahl egal.** Ein gelistetes Ticket wird bearbeitet, auch
  ohne `ready`. Die **Rolle** kommt weiter aus dem Label: `needs-plan` → Planlauf,
  `needs-research` → Recherche, **sonst bauen**.
- **Weiterhin ausgeschlossen:** `needs-input` (wartet auf dich) und `no-opus`
  (Kill-Switch) — ein so markiertes Ticket wird auch dann nicht genommen, wenn es
  gelistet ist.
- **Sicherheit:** Weil die Liste das Freigabesignal ist, wird ein versehentlich
  gelistetes, unfertiges Ticket gebaut. Der Merge-Schutz für geschützte Pfade
  (`human-approved`) bleibt davon unberührt — er sitzt in CI, nicht in der Auswahl.
- **Nicht Gelistetes** läuft über den Fallback: die bisherige Label-Reihenfolge
  (`needs-plan` → `needs-research` → `ready`, je ältestes `createdAt`).
- **Leeres/fehlendes Queue-Issue → reiner Fallback**, also das bisherige Verhalten.

Vom Handy aus editierst du dafür nur den Issue-Body — kein Commit, kein Branch.

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
| `parked`         | Wartet auf dich (`needs-input`), belegt aber **keinen Bauplatz** mehr — löst `in-progress` ab, siehe #145. | Runner |
| `blocked-limit`  | Usage-Limit erreicht. Wird automatisch fortgesetzt.            | Runner       |
| `human-approved` | **Deine Freigabe** für einen PR, der geschützte Pfade berührt. | **Du**       |
| `model:haiku`    | Mechanisches Ticket — Runner nimmt Haiku statt Sonnet.         | **Du**       |
| `no-escalation`  | Kill-Switch: Ticket bleibt immer auf Sonnet/Haiku, nie Opus.   | **Du**       |
| `opus-boost`     | Hebt den Opus-Tagesdeckel für dieses eine Ticket auf (Zähler läuft weiter), Kill-Switch `no-escalation` gewinnt. Wird von einem Opus-Bau-Lauf ohne Fortschritt wieder abgezogen. | **Du**       |
| `tests-exempt`   | Testlose Änderung (Refactor/Typen) nachweislich gerechtfertigt — hebt das Anwesenheits-Gate in `check-test-integrity.sh` für diesen PR auf. | **Du**       |

Der Bau fordert `tests-exempt` per Kommentar an (Selbst-Ausnahme wäre derselbe
Interessenkonflikt wie bei Tests); der Planer benennt im Plan, welche Änderung
testlos gerechtfertigt ist, du setzt das Label.

Der Runner nimmt nur Tickets mit `ready`, die **nicht** `needs-input` tragen.
Ein Ticket ohne `ready` fasst er nicht an — so entscheidest **du**, was gebaut wird,
auch wenn zwanzig Tickets im Backlog liegen. Ein `needs-plan`-Ticket trägt per
Definition kein `ready`, solange der Plan fehlt — es bleibt also automatisch liegen.

**Zwei Arten des Wartens (#145).** Nicht jedes „warten" ist gleich:

- **Wartet auf einen Menschen** (`needs-input`/`parked`): kann Minuten bis Tage
  dauern. Das Ticket gibt `in-progress` ab, der Runner wählt in der Zwischenzeit
  ein anderes. Betrifft es einen PR mit geschützten Pfaden, setzt du
  `human-approved` statt `needs-input` zu entfernen.
- **Wartet auf die Zeit** (`blocked-limit`, und — sobald gebaut — CI-Wartezeit):
  löst sich von selbst in Minuten. Das Ticket **bleibt** `in-progress`, der
  Runner fängt nichts Neues an, weil es ohnehin gleich weitergeht.

Die Unterscheidung ist der Grund, warum `parked` ein eigenes Label ist statt
`in-progress` einfach zu entfernen: die Auswahl-Logik muss beide Fälle
unterschiedlich behandeln können, nicht nur den Text der Statusmeldung.

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
  diesem Tag. Die Meldung erscheint höchstens einmal je Ticket und Tag und
  nennt `opus-boost` als Ausweg vom Handy: das Label hebt die Zwei-Grenze für
  dieses Ticket auf, ohne den Zähler zu nullen, und wird von einem Opus-Lauf
  ohne Fortschritt wieder abgezogen. `no-escalation` gewinnt gegen
  `opus-boost`.
- Zustand liegt dateibasiert unter `.runner/` (`tier-<nr>`, `failcount-<nr>`,
  `opus-<datum>-<nr>`, `opus-cap-msg-<datum>-<nr>`) und überlebt Neustarts.

Details und Begründung: `docs/adr/0007-opus-eskalation-baut.md`.

**Dein Handy-Workflow:** Frage kommt als Issue-Kommentar rein (GitHub-App pingt dich)
→ du antwortest als Kommentar → du entfernst `needs-input` → das Ticket wechselt von
`parked` zurück auf `in-progress` und wird vor Queue/Label-Kaskade fortgesetzt, beim
nächsten Lauf (max. 20 Minuten später). In der Zwischenzeit hat der Runner an anderen
Tickets weitergearbeitet, nicht stillgestanden.

## Merge: der Runner-Takt wacht, Claude endet beim Push (#147)

Claude wartet nicht mehr selbst auf CI. Der Bau-Lauf endet, sobald der Branch
gepusht und ein **Draft**-PR offen ist (`gh pr create --draft --fill --title
"… — Closes #<nr>"`, nur beim ersten Push — Folgeläufe pushen auf denselben
Branch, kein zweiter PR). Weder `gh pr checks --watch` noch ein voller
`pnpm e2e`-Lauf kommen im Bau-Auftrag noch vor; die schnellen Tore (`pnpm lint`,
`pnpm typecheck`, `pnpm test`) laufen weiterhin lokal vor dem Push.

Ab dem Push übernimmt der **Runner-Takt** (alle ~5 Minuten) die Beobachtung —
für ein `in-progress`-Ticket mit offenem PR prüft er dessen CI-Zustand, bevor
er überhaupt an eine Fortsetzung oder ein anderes Ticket denkt:

| CI-Zustand des PR | Was der Takt tut | Agentenlauf? |
| --- | --- | --- |
| läuft noch (irgendein Check pending) | nichts — `in-progress` bleibt stehen, kein anderes Ticket wird gewählt | nein |
| rot, **nur** `protected-paths` | Label `needs-input`, falls es fehlt (Sicherheitsnetz — der Bau-Agent hat es beim Öffnen des Draft-PR normalerweise schon selbst gesetzt), Kommentar verweist auf die schon vorhandene Erklärung am PR (siehe unten) | nein |
| rot, sonst irgendein Check | ein Bau-Agent startet gezielt, mit Job, Testnamen, Zeilen und Fehlermeldung als Auftrag — **nicht** die rohe Log-Ausgabe | **ja** |
| hinter `main` (Checks laufen nicht mehr, s.u.) | `main` per `git fetch`+`git merge`+`git push` in den Branch nachziehen (#160) | nein — außer bei echtem Konflikt |
| grün | Draft → `ready`, Auto-Merge aktivieren (`gh pr merge --squash --auto --delete-branch`) | nein |

Die Reihenfolge der Zeilen ist die Prüfreihenfolge: `pending` → `failing` →
`behind` → `success`. Ein noch laufender Shard darf nicht durch ein Nachziehen
abgewürgt werden, und ein roter Check wird erst behoben, bevor überhaupt an
ein Nachziehen gedacht wird — `behind` wird also nur geprüft, wenn feststeht,
dass nichts mehr läuft und nichts rot ist.

Ein Draft-PR wird **nie** gemerged, egal wie grün die Checks sind — erst der
grüne Takt hebt ihn aus dem Entwurf. Läuft die CI noch zu einem
`in-progress`-Ticket, bleibt das Ticket `in-progress` (nicht "an dich
zurückgegeben" wie bei einer offenen Frage) — der Bauplatz ist weiter belegt,
weil es gleich weitergeht, nicht weil auf dich gewartet wird. Das unterscheidet
diese CI-Wartezeit vom Warten auf einen Menschen (#145): CI braucht Minuten und
läuft von allein, ein Mensch kann Stunden bis Tage brauchen — nur Letzteres gibt
den Bauplatz frei.

Der Wiederaufnahmefall (roter Check → Fix-Agent) liest denselben Zustand wie
jede andere Fortsetzung: Branch, `git log`, Fortschrittskommentar samt „Was
schon versucht wurde". Rot aus demselben Grund wie beim letzten Mal zählt
weiterhin als Fehlversuch der bestehenden Eskalation (ADR-0007, `blocker_sig`)
— nach dem **dritten** vergeblichen Versuch: Kommentar, Label `needs-input`.

**`behind`: ein zurückgefallener PR-Branch wird selbst nachgezogen (#160).**
`required_status_checks.strict=true` (siehe Branch-Schutz unten) verlangt den
aktuellen Stand von `main` — GitHub zieht den PR-Branch dabei aber nicht selbst
nach, und Auto-Merge wartet still auf etwas, das nie passiert, sobald `main`
während des Baus oder während CI läuft weiterwandert. `strict: true` bleibt
trotzdem stehen: es ist die einzige Zusicherung, dass unbeaufsichtigt gemergter
Code gegen das aktuelle `main` getestet wurde (zwei für sich grüne PRs können
inhaltlich kollidieren, ohne dass ein Check das sieht). Der Takt zieht deshalb
selbst nach, sobald ein offener PR laut `mergeStateStatus` (`gh pr view`)
`BEHIND` ist und seine Checks nicht mehr laufen: `git fetch origin main
<branch>`, `git merge origin/main`, `git push` — bewusst **kein**
`gh pr update-branch`, das scheitert, sobald der Branch Workflow-Dateien
berührt (`refusing to allow an OAuth App to … without 'workflow' scope`),
ausgerechnet bei den Tickets, die `.github/` anfassen und ohnehin am längsten
auf eine Freigabe warten. Klappt der Merge, läuft CI von selbst neu, der
nächste Takt sieht wieder `pending`. Scheitert er an einem echten Konflikt,
wird **kein** Commit erzwungen — der Merge wird abgebrochen, der Arbeitsbaum
kehrt sauber zum vorherigen Branch zurück, und ein Bau-Agent startet gezielt
mit den Konfliktdateien im Auftrag (derselbe Mechanismus wie bei einem roten
Check).

**Die Wache gilt auch für `parked`-Tickets (#154), inklusive `behind`.** Die
Tabelle oben beobachtet nur das eine `in-progress`-Ticket — ein
`parked`-Ticket (z. B. eins, das an `protected-paths` hing und auf
`human-approved` wartete) fiel bisher aus der Wache heraus: kein
`in-progress` mehr (der Bauplatz ist frei, #145), aber die Ticketauswahl
greift es erst wieder auf, sobald `needs-input` manuell weg ist. Wurde der PR
in der Zwischenzeit komplett grün, blieb der Draft für immer Draft; lag er nur
hinter `main`, wartete er ebenso ewig. Deshalb prüft der Takt **zusätzlich** —
vor jeder Ticketauswahl, ohne den Bauplatz des laufenden Tickets zu berühren —
**alle** offenen `parked`-Tickets: Ist der PR eines davon komplett grün,
fallen `parked` **und** `needs-input` weg, der Draft wird `ready`, Auto-Merge
aktiviert — genau wie beim laufenden Ticket, nur ohne dass vorher ein Mensch
`needs-input` hätte entfernen müssen. Liegt er nur hinter `main`, wird er per
`git` nachgezogen, bleibt aber geparkt (die nächste Runde sieht dann wieder
laufende Checks). Ein Konflikt beim Nachziehen eines geparkten Tickets startet
hier bewusst **keinen** Agenten — das würde das WIP-Limit=1 verletzen, falls
gerade ein anderes Ticket `in-progress` ist. Das geparkte Ticket bleibt dann
liegen und bekommt seinen Fix-Agenten regulär, sobald es selbst wieder an die
Reihe kommt (Schritt 1b) und der Bau-Agent den Konflikt als Teil seiner
normalen Arbeit löst. Läuft die CI noch oder ist sie rot, bleibt das Ticket
unverändert geparkt. Das kostet außer im Konfliktfall nie einen Agentenlauf,
nur gh-/git-Aufrufe — das Statusticket nennt freigegebene Tickets im nächsten
Update.

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
  `src/app/api/sync/`, Auth, `.github/` oder `scripts/` berührt werden. Der Bau-Agent
  setzt beim Öffnen des Draft-PR selbst `needs-input` und nimmt es in diesem Lauf
  nicht wieder ab (#163) — die Wache setzt es nur nach, falls es einmal fehlt (z. B.
  nach einem abgebrochenen Lauf), folgenlos, wenn es schon dranhängt. Der PR bleibt
  offen, bis **du** das Label `human-approved` setzt **und** `needs-input` entfernst.
  Danach läuft der Check automatisch neu, und der nächste Takt sieht grün und
  aktiviert Auto-Merge.

Alles andere — UI, Features, Styling, Doku — merged Claude ohne dich.

## Der Status auf einen Blick

Ein angepinntes Status-Issue wird vom Runner per _Edit_ aktualisiert
(nicht per Kommentar — sonst bekommst du im Minutentakt Push-Nachrichten).

**Die Farbe steht im Titel, nicht nur im Text.** Damit siehst du den Zustand schon in
der Issue-Liste auf dem Handy und musst nicht hineinklicken:

| Titel | Bedeutung | Musst du etwas tun? |
|---|---|---|
| 🟠 `Runner · arbeitet an #42 (seit 18:49)` | Lauf läuft gerade, vor dem `claude`-Aufruf gesetzt | nein |
| 🟢 `Runner · CI läuft für #42` | Draft-PR wartet auf CI-Checks — kein lokaler Prozess (#147) | nein |
| 🟢 `Runner · wartet auf Merge · #42` | CI grün, Draft auf `ready` gesetzt, Auto-Merge aktiviert | nein |
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
5. `scripts/check-sync-invariants.sh` — kein Feature-Code spricht direkt gegen `/api`
6. `scripts/check-test-integrity.sh` — Anwesenheits-Gate: Code ohne Test ist rot,
   außer das PR trägt `tests-exempt`

**Kein Merge bei rotem Build. Keine Ausnahme.**

## Migrationen (Drizzle + Dexie)

Migrationen sind hier doppelt heikel: **Server-Schema** (Drizzle) und **Client-Schema**
(Dexie-Version) müssen zusammenpassen, und alte Clients mit ungesyncter Outbox dürfen
nicht brechen. Der `schema-drift`-Guard fängt nur die *fehlende* Server-Migration —
nicht die Client-Seite und nicht die Rückwärtskompatibilität.

Berührt ein Ticket `src/db/schema.ts` oder `src/local/dexie.ts`, konsultiert der
Bau-Agent **zuerst** den `db-migration`-Subagenten (`.claude/agents/db-migration.md`,
nur-lesend) und arbeitet dessen vier Schritte ab:

1. Generiertes SQL zeigen und begründen — Up-Pfad aus `pnpm db:generate`, Down-Pfad
   als handgeschriebenes Reverse-SQL im PR-Text (CLAUDE.md Regel 4).
2. Rückwärtskompatibilität: „Kann ein Client mit ALTEM Dexie-Schema und ungesyncter
   Outbox noch pushen?" — additive Spalten (nullable/Default) ja, umbenannte oder
   gelöschte Spalten nein.
3. Dexie-Versions-Bump (`db.version(N)` in `src/local/dexie.ts`) im selben PR, wenn
   sich das Client-Schema mitbewegt — nicht nötig bei server-only-Tabellen oder einer
   additiven Spalte im generischen `records`-Store.
4. `src/db/**` und `src/local/**` sind protected paths — kein Auto-Merge, Kommentar
   + `human-approved` anfordern (siehe unten).

Ein optionaler Hinweis-Check (`scripts/check-dexie-bump.sh`) läuft im `quality`-Job:
Server-Migration berührt, aber kein Dexie-Bump → `::warning::`-Annotation. Das ist
ein **Hinweis, kein Gate** (`exit 0` immer) — additive Server-Änderungen und
server-only-Tabellen brauchen legitim keinen Dexie-Bump, ein hart-fehlschlagender
Check würde nur Fehlalarme produzieren.

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

### Wie ein Flake-Fix belegt wird

„Zehnmal hintereinander grün" heißt **zehn Wiederholungen des betroffenen Tests**,
nicht zehn volle Suiteläufe (#146 — genau das hat #131 drei Bau-Läufe und das
gesamte Opus-Tagesbudget gekostet, obwohl der Code die ganze Zeit fertig war: ein
Lauf-Fenster ist 45 Minuten, zehn volle Suiten brauchen bei ~26 Minuten je Lauf
über vier Stunden). `@playwright/test` bringt dafür die passenden Flags mit:

```bash
pnpm exec playwright test tests/habits.spec.ts \
  -g "nach dem Onlinegehen" \
  --repeat-each=10 --fail-on-flaky-tests --project=mobile
```

- `--repeat-each=10` wiederholt genau die per `-g`/Dateiname eingegrenzten Tests
  zehnmal in einem einzigen Serverstart — statt zehnmal die ganze Suite hochzufahren.
- `--fail-on-flaky-tests` ist das, was „ohne Retry" tatsächlich meint: ein Test, der
  erst im Retry grün wird, färbt den Lauf rot, statt als Erfolg durchzugehen.

Ein Akzeptanzkriterium, das sich nicht innerhalb eines Lauf-Fensters prüfen lässt,
ist keine Anforderung, sondern eine Sackgasse — der Runner kann es weder erfüllen
noch verwerfen. Deshalb gilt beim Ticketschnitt: **jedes Akzeptanzkriterium muss
innerhalb eines Lauf-Fensters prüfbar sein.** „N ganze Suiten hintereinander" ist
als Nachweisform ausgeschlossen.

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
