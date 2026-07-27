# Workflow

Ticketsystem: **GitHub Issues + GitHub Projects.**
Grund: kostenlos, im selben Repo wie der Code, und über die `gh`-CLI direkt für Claude nutzbar —
kein zweites System, kein Kontextbruch.

## Der Zyklus

```
Issue (grobe Idee, vom Handy eingeworfen)
   └─► [optional] research → Opus recherchiert den Fit → needs-answer → du entscheidest
Issue (mit Akzeptanzkriterien)
   └─► [nur bei Komplexität] plan → Opus plant im Chat → ready
   └─► Branch feat/<nr>-<slug>
         └─► Implementierung + Playwright-Tests
               └─► PR (Closes #<nr>)
                     └─► CI grün → Merge → Issue schließt automatisch
                           └─► nächstes Issue
```

**WIP-Limit = 1.** Es gibt zu keinem Zeitpunkt zwei offene Feature-Branches.
Nichts läuft parallel. Das ist die wichtigste Regel im Repo.

**Gebaut wird nur im eigenen Worktree.** Das WIP-Limit gilt für Tickets, nicht für
Prozesse: Runner, Chat-Sitzungen und CI greifen gleichzeitig auf denselben Checkout
zu. Wer im Haupt-Checkout den Branch wechselt oder committet, schreibt seine Arbeit
in den Branch eines fremden Tickets — genau so landete #196 im Icon-PR von #232.
Rezept und Pfadkonvention: `CLAUDE.md`, „Ein Worktree je Lauf".

**„Wartend" ist nicht „in Arbeit" (#145, neu geschnitten in #272).** Ein Ticket,
an dem *niemand* sitzt, weil eine Frage an dich offen ist, belegt keinen
Bauplatz — nur ein Ticket, an dem der Runner gerade tatsächlich baut, tut das.

Stellt Claude eine Frage, setzt es `needs-answer` und **behält `in-progress`**.
Die Auswahl überspringt jedes Ticket mit diesem Label, es belegt also keinen
Bauplatz; der Runner nimmt sich einfach das nächste. Antwortest du und entfernst
`needs-answer`, wird die Arbeit über denselben „läuft schon"-Zweig fortgesetzt
(Branch, `git log` und Fortschrittskommentar wie gewohnt — kein Neuanfang, und
kein Label muss dafür geschrieben werden).

Bis #272 gab es dafür ein eigenes Label `parked`: das Ticket gab `in-progress`
ab und bekam `parked`. Genau deshalb brauchte es danach einen eigenen Zweig, um
es wiederzufinden, eine eigene Wache und ein Sicherheitsnetz gegen den
Zwischenzustand. Alle drei sind mit `parked` weggefallen.

Das gilt **nicht** für `blocked-limit`: ein Usage-Limit löst sich von selbst in
Minuten und bleibt bewusst `in-progress` ohne Wartelabel, der Runner fängt in
der Zwischenzeit nichts Neues an (siehe Abschnitt „Zwei Arten des Wartens"
unten).

**Recherche-Schritt vor `plan` (optional, Idee-Ebene):** Wirfst du eine grobe
Feature-Idee als Issue ein, setzt du das Label `research`. Der Runner lässt
Opus dann nur-lesend prüfen, *ob* & *was*: Fit zu `docs/VISION.md`,
`docs/ARCHITECTURE.md`, `docs/DESIGN_SYSTEM.md` und bestehendem Code, 2–3 Ansätze
mit Trade-offs, Empfehlung, **grober** Schnitt — **kein dateiweiser Plan, kein
Code-Wie**, das ist eine Stufe abstrakter als `plan`. Widerspricht die Idee
der Vision, steht das klar in der Überlegung — Opus verwirft sie nicht
eigenmächtig, das entscheidest du. Ist die Überlegung fertig, tauscht der
abschließende Lauf `research` gegen `needs-answer`; sagst du dann „ja",
nimmst du `needs-answer` runter und setzt `plan` — erst der Planer-Lauf macht
daraus einen dateiweisen Umsetzungsplan (die Konzept-Entscheidung aus der
Recherche wird dabei nicht neu aufgerollt).

**Planungsschritt vor `ready`:** Komplexe Tickets (mehrdeutig, architektonisch,
mehrere Dateien, geschützte Pfade, Migrationen, Krypto, Sync) bekommen zuerst das
Label `plan`. Geplant wird von Opus, nie gebaut — siehe `docs/TOKEN-BUDGET.md`
und `docs/adr/0005-opus-im-runner.md` — bis Schrittfolge, Testplan, Risiko/Rückweg und
Wiederaufnahmepunkte konkret genug sind, dass Sonnet/Haiku keine
Architektur-Entscheidungen mehr treffen müssen. Erst danach: `plan` runter,
`ready` rauf.

**Automatik im Runner:** Ein `plan`-Ticket (ohne `needs-answer`, ohne
`hands-off`) wird vom Runner selbst mit Opus geplant — streng nur-lesend
(`--allowedTools "Read,Grep,Glob,Bash"`, kein Branch, kein Commit). Der Plan
entsteht inkrementell in **einem** Kommentar (`--edit-last`); erst der
abschließende Lauf entfernt `plan` und setzt `ready`. Bricht ein
Planer-Lauf ab (Limit, Timeout), bleiben Label, Teilplan und
Wiederaufnahme-Marker stehen — der nächste Lauf setzt dort fort, nie von vorne.
Ein Ticket mit **beiden** Labeln `plan` und `ready` gilt als inkonsistent
und wird als `plan` behandelt, nicht gebaut. `research` läuft
genauso (eigener Recherche-Prompt statt Planungs-Prompt, `--allowedTools
"Read,Grep,Glob,Bash,WebSearch"` — die bounded Web-Recherche aus dem
Recherche-Prompt braucht das zusätzliche Werkzeug), flippt aber auf
`needs-answer` statt `ready`, weil danach eine Entscheidung ansteht, kein Bau.
Für **kein** Denk-Label (`plan` oder `research`) gibt es einen
Tages-Deckel — Planung und Recherche laufen so oft, wie sie brauchen (siehe
ADR-0005, PR #46). Kill-Switch für beide: `hands-off`.

**`hands-off` gilt für jeden Auswahlzweig (#227).** Der Schalter hält nicht nur
Plan- und Recherche-Läufe an, sondern nimmt das Ticket aus der Auswahl heraus,
bevor irgendein Zweig sie liest: laufendes `in-progress`, Queue, `plan`,
`research`, `ready` — überall.
Damit ist `hands-off` die verlässliche Bremse für ein Ticket, das gerade lokal
gebaut wird. Bis zu diesem Fix prüften ihn nur Queue, `plan` und
`research`; ausgerechnet der Zweig fuer laufende Tickets und `ready`
ignorierten ihn.

Reihenfolge, wenn mehrere Labels gleichzeitig offen stehen: ein laufendes
`in-progress`-Bau-Ticket geht vor, danach `plan`, danach `research`,
erst danach `ready`. Ein Ticket mit `research` **und** `ready` gleichzeitig
gilt ebenso als inkonsistent wie bei `plan` — es wird über den
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
  ohne `ready`. Die **Rolle** kommt weiter aus dem Label: `plan` → Planlauf,
  `research` → Recherche, **sonst bauen**.
- **Weiterhin ausgeschlossen:** `needs-answer` (wartet auf dich) und `hands-off`
  (Kill-Switch) — ein so markiertes Ticket wird auch dann nicht genommen, wenn es
  gelistet ist.
- **Sicherheit:** Weil die Liste das Freigabesignal ist, wird ein versehentlich
  gelistetes, unfertiges Ticket gebaut. Ein Merge-Schutz für geschützte Pfade besteht seit #276 nicht mehr (`protected-paths` ist nur noch ein Hinweis).
- **Nicht Gelistetes** läuft über den Fallback: die bisherige Label-Reihenfolge
  (`plan` → `research` → `ready`, je ältestes `createdAt`).
- **Leeres/fehlendes Queue-Issue → reiner Fallback**, also das bisherige Verhalten.

Vom Handy aus editierst du dafür nur den Issue-Body — kein Commit, kein Branch.

Einfache/mechanische Tickets (klarer CSS-Fix, Doku, Umbenennung) überspringen
`plan` und gehen direkt auf `ready` — der Planungsschritt würde hier nur
Tokens kosten, ohne die Ausführung konkreter zu machen.

**Kein extra Code-Änderungsbedarf am Runner für den Fallback:** Ohne
Queue-Eintrag gilt weiterhin die Label-Kaskade — ein Ticket mit `plan`
oder `research` und ohne `ready` liegt dort automatisch still, auch ohne
eigene Guard-Logik. Ist das Ticket dagegen gelistet, entscheidet allein die
Reihenfolge in der Queue (siehe oben); das Label ist dann nur noch für die
**Rolle** relevant (Plan/Recherche/Bau), nicht mehr für die Auswahl.

## Labels — sie steuern den Runner

Der Runner (`scripts/claude-runner.sh`) liest ausschließlich Labels. Sie sind die
Zustandsmaschine des ganzen Setups:

| Label            | Bedeutung                                                      | Wer setzt es |
| ---------------- | -------------------------------------------------------------- | ------------ |
| `research` | Grobe Idee, noch kein Ticket — Opus recherchiert den Fit, dann `needs-answer`. | **Du**       |
| `plan`     | Ticket erfasst, aber noch nicht baubereit — Opus plant im Chat. | **Du** oder Runner (beim Auslagern eines Fund-Tickets) |
| `ready`          | Von dir freigegeben. Claude darf das Ticket nehmen.            | **Du**       |
| `in-progress`    | Claude arbeitet daran. Es gibt immer höchstens eins.           | Runner       |
| `needs-answer`    | **Wartet auf dich: Antwort oder Freigabe.** Das mechanische Tor — schließt das Ticket aus der Queue aus und parkt es. | Claude / Runner |
| `blocked-limit`  | Usage-Limit erreicht. Wird automatisch fortgesetzt.            | Runner       |
| `model:haiku`    | Mechanisches Ticket — Runner nimmt Haiku statt Sonnet.         | **Du**       |
| `no-escalation`  | Kill-Switch: Ticket bleibt immer auf Sonnet/Haiku, nie Opus.   | **Du**       |
| `opus-boost`     | Hebt den Opus-Tagesdeckel für dieses eine Ticket auf (Zähler läuft weiter), Kill-Switch `no-escalation` gewinnt. Wird von einem Opus-Bau-Lauf ohne Fortschritt wieder abgezogen. | **Du**       |
| `tests-exempt`   | Testlose Änderung (Refactor/Typen) nachweislich gerechtfertigt — hebt das Anwesenheits-Gate in `check-test-integrity.sh` für diesen PR auf. | **Du**       |

Der Bau fordert `tests-exempt` per Kommentar an (Selbst-Ausnahme wäre derselbe
Interessenkonflikt wie bei Tests); der Planer benennt im Plan, welche Änderung
testlos gerechtfertigt ist, du setzt das Label.

**Im Fallback** (leeres/fehlendes Queue-Issue oder Ticket nicht gelistet) nimmt
der Runner nur Tickets mit `ready`, die **nicht** `needs-answer` tragen — ein
`plan`-Ticket trägt per Definition kein `ready`, solange der Plan fehlt,
und bleibt automatisch liegen. **Ist das Ticket gelistet**, ersetzt das die
`ready`-Freigabe (siehe „Die Prioritäts-Queue" oben). So entscheidest **du** in
jedem Fall, was gebaut wird, auch wenn zwanzig Tickets im Backlog liegen —
per Queue-Editor oder per Label.

**Zwei Arten des Wartens (#145).** Nicht jedes „warten" ist gleich:

- **Wartet auf einen Menschen** (`needs-answer`): kann Minuten bis Tage dauern.
  Es steht eine echte Frage im Ticket, die eine geschriebene Antwort braucht.
  Das Ticket **behält** `in-progress`, wird von der Auswahl aber übersprungen —
  der Runner baut in der Zwischenzeit etwas anderes. Nimmst du das Label ab,
  läuft es weiter, ohne dass irgendetwas umgelabelt werden muss.
- **Wartet auf die Zeit** (`blocked-limit`, und — sobald gebaut — CI-Wartezeit):
  löst sich von selbst in Minuten. Das Ticket bleibt `in-progress` **ohne**
  Wartelabel, der Runner fängt nichts Neues an, weil es ohnehin gleich
  weitergeht.

Beide behalten `in-progress`; der Unterschied liegt allein im Wartelabel. Genau
das ist seit #272 der Punkt: nicht ein zweites Zustandslabel entscheidet, ob ein
Bauplatz belegt ist, sondern die Frage, ob jemand auf einen Menschen wartet.

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
  Label `needs-answer`, Blocker-Kommentar am Ticket.
- **Opus-Deckel:** höchstens 2 Opus-Bau-Läufe pro Ticket und Kalendertag.
  Überschreitung → sofort `needs-answer`, kein weiterer Opus-Bau-Versuch an
  diesem Tag. Die Meldung erscheint höchstens einmal je Ticket und Tag und
  nennt `opus-boost` als Ausweg vom Handy: das Label hebt die Zwei-Grenze für
  dieses Ticket auf, ohne den Zähler zu nullen, und wird von einem Opus-Lauf
  ohne Fortschritt wieder abgezogen. `no-escalation` gewinnt gegen
  `opus-boost`.
- Zustand liegt dateibasiert unter `.runner/` (`tier-<nr>`, `failcount-<nr>`,
  `opus-<datum>-<nr>`, `opus-cap-msg-<datum>-<nr>`) und überlebt Neustarts.

Details und Begründung: `docs/adr/0007-opus-eskalation-baut.md`.

**Dein Handy-Workflow:** Frage kommt als Issue-Kommentar rein (GitHub-App pingt
dich) → du antwortest als Kommentar → du entfernst `needs-answer` → das Ticket
wird beim nächsten Lauf (max. 20 Minuten später) fortgesetzt, nicht neu
gestartet (Mechanik siehe oben, „Wartend ist nicht in Arbeit"). In der
Zwischenzeit hat der Runner an anderen Tickets weitergearbeitet, nicht
stillgestanden.

## Merge: Claude hebt seinen PR selbst aus dem Entwurf (#147, #167)

Claude wartet nicht mehr selbst auf CI. Existiert für das Ticket noch kein
PR, öffnet der erste Push einen **Draft**-PR (`gh pr create --draft --fill
--title "… — Closes #<nr>"`); Folgeläufe pushen auf denselben Branch, kein
zweiter PR. Weder `gh pr checks --watch` noch ein voller `pnpm e2e`-Lauf
kommen im Bau-Auftrag noch vor; die schnellen Tore (`pnpm lint`,
`pnpm typecheck`, `pnpm test`) laufen weiterhin lokal vor dem Push.

**Unmittelbar vor dem finalen Push zieht Claude `main` proaktiv nach
(#191)**, statt das erst einen Takt später `pr_catch_up_behind()` reaktiv
erledigen zu lassen: `git fetch origin main` + `git merge origin/main
--no-edit` — vorausgesetzt, der Arbeitsbaum ist sauber (alles committet,
nie in einen unsauberen Baum mergen). Klappt der Merge, wird normal
weitergepusht; ein PR entsteht dadurch in aller Regel schon aktuell.
Kollidiert er inhaltlich, löst Claude den Konflikt direkt auf dem eigenen
Branch auf (voller Kontext der eigenen Änderungen) und pusht die Auflösung
mit — kein separater, kalt einsteigender Fix-Lauf. `pr_catch_up_behind()`
bleibt unverändert als Netz bestehen: merged ein anderer PR erst in den
Sekunden nach diesem Push, greift der Runner-Takt wie gehabt nach.

**Endet der Bau-Lauf sauber** (Ticket fertig oder Fortsetzung erfolgreich
gepusht — nicht über eine offene Frage), hebt Claude den PR **selbst** aus
dem Entwurf und aktiviert Auto-Merge, bevor der Lauf endet:
`gh pr ready` + `gh pr merge --squash --auto --delete-branch` (ohne
PR-Nummer — wirkt auf den PR des aktuellen Branches). Das setzt nicht
voraus, dass CI schon grün ist: Auto-Merge greift ohnehin erst, wenn alle
Required Checks durch sind, GitHub liefert diese Zusicherung, nicht Claudes
Einschätzung. **Ein Entwurf bedeutet ab jetzt: der Lauf ist nicht sauber zu
Ende gekommen** (Notbremse, Limit, harter Fehler) — nicht mehr „es hat noch
niemand hingeschaut". Bei einer offenen Frage (`needs-answer`) endet der Lauf
bewusst **vor** diesem Schritt, der PR bleibt Entwurf.

Der **Runner-Takt** (alle ~5 Minuten) bleibt trotzdem als Beobachter aktiv —
er wird seltener gebraucht, nicht überflüssig. Für ein `in-progress`-Ticket
mit offenem PR prüft er dessen CI-Zustand, bevor er überhaupt an eine
Fortsetzung oder ein anderes Ticket denkt:

| CI-Zustand des PR | Was der Takt tut | Agentenlauf? |
| --- | --- | --- |
| läuft noch (irgendein Check pending) | nichts — `in-progress` bleibt stehen, kein anderes Ticket wird gewählt | nein |
| rot, **nur** `protected-paths` | Kann seit #276 nicht mehr eintreten — der Wächter blockiert nicht mehr. | nein |
| rot, sonst irgendein Check | ein Bau-Agent startet gezielt, mit Job, Testnamen, Zeilen und Fehlermeldung als Auftrag — **nicht** die rohe Log-Ausgabe | **ja** |
| konfliktbehaftet (`DIRTY`) | ein Bau-Agent startet gezielt, mit den Konfliktdateien im Auftrag (lokal per Trockenlauf-Merge ermittelt, s. u.) | **ja** |
| hinter `main` (Checks laufen nicht mehr, s.u.) | `main` per `git fetch`+`git merge`+`git push` in den Branch nachziehen (#160) | nein — außer bei echtem Konflikt |
| grün, aber noch Entwurf (Sicherheitsnetz — z. B. nach einem abgebrochenen Lauf) | Draft → `ready`, Auto-Merge aktivieren (`gh pr merge --squash --auto --delete-branch`) | nein |
| grün, schon `ready` | nichts zu tun — GitHub mergt von selbst, sobald die Required Checks final durch sind | nein |

Die Reihenfolge der Zeilen ist die Prüfreihenfolge: `pending` → `failing` →
`conflict` → `behind` → `success`. Ein noch laufender Shard darf nicht durch
ein Nachziehen abgewürgt werden, und ein roter Check wird erst behoben, bevor
überhaupt an ein Nachziehen gedacht wird. `conflict` steht bewusst **vor**
`behind`: GitHub berechnet `mergeStateStatus` serverseitig, und ein PR mit
einem echten Merge-Konflikt meldet **dauerhaft** `DIRTY`, nie wieder `BEHIND`
— stünde `behind` zuerst in der Prüfreihenfolge, wäre es für einen
konfliktbehafteten PR für immer unerreichbar, und CI würde bei jedem grünen
Check-Lauf fälschlich `success` melden, obwohl GitHub selbst gar nicht mergen
kann (#217). `behind` wird also nur geprüft, wenn feststeht, dass nichts
mehr läuft, nichts rot ist und kein echter Konflikt vorliegt.

In aller Regel ist der PR beim ersten grünen Blick des Takts schon `ready`
(Claude hat das selbst am Lauf-Ende erledigt) — der Merge passiert dann durch
GitHub, ohne dass der Takt noch etwas tun muss. Läuft die CI noch zu einem
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
— nach dem **dritten** vergeblichen Versuch: Kommentar, Label `needs-answer`
**und** `needs-answer` (#196) — eine echte Frage, keine Freigabe.

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

**`conflict`: ein `DIRTY`-PR bekommt einen eigenen Zustand (#217).** Weil
GitHub bei einem echten Merge-Konflikt nie wieder `BEHIND` meldet (s. o.),
reicht der `behind`-Pfad allein nicht — ohne eigene Prüfung blieb ein
konfliktbehafteter PR für immer bei `success` hängen, sobald seine Checks
zufällig grün waren: `gh pr ready` + Auto-Merge liefen ins Leere, GitHub
mergt nie, und der Takt meldete jede Runde erneut „kein Eingreifen nötig".
Der Takt probiert deshalb bei `DIRTY` denselben lokalen Trockenlauf-Merge wie
bei `behind` (`git fetch` + `git merge origin/main`, kein Commit): klappt er
doch (GitHubs Berechnung war beim Abruf veraltet), wird normal nachgezogen,
kein Agentenlauf. Scheitert er — der Normalfall bei `DIRTY` — startet ein
Bau-Agent gezielt mit den Konfliktdateien im Auftrag. Anders als bei
`behind` gibt es hier **keine** stille Wiederholung bei einem
Infrastruktur-Fehlschlag (`git fetch`/`checkout`/`push`): ein `DIRTY`-PR löst
sich nie durch bloßes Abwarten, also startet der Bau-Agent auch dann, mit
`unbekannt` als Dateiliste im Auftrag. Wiederholte Fehlschläge zählen wie
gewohnt in die bestehende Eskalation ein (ADR-0007) — nach dem dritten
vergeblichen Versuch: Kommentar und `needs-answer`.

**Die Wache gilt auch für wartende Tickets (#154), mit denselben Zuständen wie
das laufende Ticket (#173, erweitert um `conflict` in #217).** Seit #202 (S5
von #184) ist das keine Beschreibung mehr, die zwei getrennte Bash-Blöcke
zufällig einhalten, sondern eine einzige Übergangstabelle:
`scripts/runner/watch.ts`, `watchReaction()` (`WatchState × waiting ->
Reaktion`). `watchRunningIssue()` und `watchWaitingIssues()` lösen den
PR-Zustand (S4, `PrState`) je zu einem `WatchState` auf und lassen danach
dieselbe Tabelle entscheiden — „wartet" ist dort ein Eingabefeld, kein eigener
Zweig.

Die Tabelle oben beobachtet nur das Ticket, an dem gerade gebaut wird. Ein
wartendes Ticket fiele sonst aus jeder Wache heraus: sein PR kann in der
Zwischenzeit grün werden, ohne dass jemand hinsieht. Deshalb prüft der Takt
**zusätzlich** — vor jeder Ticketauswahl, ältestes zuerst — **alle** offenen
Tickets mit `needs-answer`. Für die gibt es seit #272 nur noch zwei Ausgänge:

- **grün, noch Entwurf:** Draft wird `ready`, Auto-Merge aktiviert,
  `needs-answer` fällt weg — die Frage ist mit dem Merge gegenstandslos. Kein
  Agentenlauf.
- **alles andere** (CI läuft noch, rote Checks, hinter `main`, Merge-Konflikt,
  `DIRTY`): **nichts passiert.** Das Ticket wartet auf eine Antwort, nicht auf
  einen freien Bauplatz.

Bis #272 gab es hier einen dritten Ausgang: bei Konflikt oder roten Checks
wurde ein geparktes Ticket entparkt und sofort ein Fix-Agent gestartet — sofern
der Mensch schon geantwortet hatte und der Bauplatz frei war. Dieser
Zwischenzustand („geparkt, aber beantwortet") kann nicht mehr entstehen: wer
antwortet, nimmt `needs-answer` ab, und damit greift der ganz normale
„läuft schon"-Zweig der Auswahl samt der Wache oben. Der Fix-Lauf passiert
dadurch weiterhin — nur eine Runde später und ohne eigenen Sonderpfad.

Das kostet außer im Konflikt-/Failing-Fall nie einen Agentenlauf, nur
gh-/git-Aufrufe — das Statusticket nennt freigegebene **und** entparkte
Tickets im nächsten Update.

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

**Ein Wächter macht den Auto-Merge erst vertretbar:**

- `test-integrity` — lehnt jeden PR ab, der Tests entfernt, abschaltet
  (`.skip`, `.only`) oder mit `waitForTimeout` grün macht. Reine Textprüfung,
  kein Modell beteiligt.

`protected-paths` **blockiert seit #276 nicht mehr.** Der Check läuft weiter
und nennt im Log, welche empfindlichen Dateien ein PR berührt — aber er ist
immer grün, und das Label `human-approved` gibt es nicht mehr.

Der Grund: die PRs werden ohnehin direkt freigegeben. Das Label hat keinen
zusätzlichen Blick auf den Diff erzeugt, sondern nur einen zusätzlichen
Handgriff — und einen, der regelmäßig zur eigentlichen Bremse wurde (Label am
PR statt am Issue, zwei gleichzeitige Check-Suites, von denen eine die Payload
ohne Label sah, Tickets tagelang still).

**Der bewusst in Kauf genommene Preis:** ein unbeaufsichtigter Runner-Lauf
kann eine Migration, eine Krypto-Änderung oder einen Sync-Eingriff selbst
mergen, ohne dass ein Mensch draufgesehen hat. Die verbleibenden Netze sind
`schema-drift`, `quality` (Sync-Invarianten), `test-integrity`, `e2e-offline`
und die `db-migration`-Review-Rolle. Wer das zurückdrehen will, ändert
`.github/workflows/guards.yml` — die Pfadliste steht dort unverändert.

Damit merged Claude alles ohne dich.

**Wie ein Ticket geschlossen wird — und wie nicht (#172).** Ein Squash-Merge
schließt in GitHub automatisch jedes Ticket, dessen `Closes #N` irgendwo in
der zusammengefassten Commit-Nachricht auftaucht. Ohne eigene Angabe sammelt
GitHub dafür **alle** Commit-Nachrichten des Branches ein — nicht nur den
PR-Titel. Zieht ein Branch beim Nachziehen von `main` (#160) fremde
Merge-Commits mit (z. B. von PR #165/#166), landen deren `Closes #N` mit im
Squash und schließen ein Ticket, dessen eigener PR noch gar nicht gemergt
ist — beobachtet an #163, fälschlich geschlossen durch den Squash von PR
#168, während #163s eigentlicher PR #166 noch offen war. Weil die
Ticketauswahl nur offene Issues kennt, wäre so ein Ticket sonst für immer
verloren.

Zwei Mechanismen verhindern das:

- **Eigenes Subject/Body** (`prSquashMerge()` in `scripts/runner/pr.ts`):
  Jeder Squash-Merge, den der Runner auslöst, übergibt `--subject` (den
  PR-Titel) und ein leeres `--body` explizit — GitHub sammelt dann nichts
  mehr selbst ein. Ein Ticket schließt **nur**, wenn sein eigener PR-Titel
  `Closes #N` trägt.
- **Netz** (`reopenFalselyClosedIssues()`): Vor jeder Ticketauswahl prüft
  der Runner alle offenen PRs mit `Closes #N` im Titel. Ist das referenzierte
  Ticket trotzdem `CLOSED`, kann dieser (noch offene) PR es nicht gewesen
  sein — der Runner öffnet das Ticket wieder und kommentiert den Grund samt
  PR-Nummer.

Der bestehende Merge-Weg (`--squash --auto --delete-branch`) bleibt dabei
unverändert; Auto-Merge wird nicht durch einen manuellen Merge ersetzt.
Abgedeckt in `scripts/tests/squash-close-guard.test.sh`.

## Der Status auf einen Blick

Ein angepinntes Status-Issue wird vom Runner per _Edit_ aktualisiert
(nicht per Kommentar — sonst bekommst du im Minutentakt Push-Nachrichten).

**Die Farbe steht im Titel, nicht nur im Text.** Damit siehst du den Zustand schon in
der Issue-Liste auf dem Handy und musst nicht hineinklicken:

| Titel | Bedeutung | Musst du etwas tun? |
|---|---|---|
| 🟠 `Runner · arbeitet an #42 (seit 18:49)` | Lauf läuft gerade, vor dem `claude`-Aufruf gesetzt | nein |
| 🟢 `Runner · CI läuft für #42` | PR wartet auf CI-Checks (meist schon `ready`, seit #167) — kein lokaler Prozess (#147) | nein |
| 🟢 `Runner · wartet auf Merge · #42` | CI gerade grün geworden, Wache hat einen noch offenen Draft auf `ready` gesetzt, Auto-Merge aktiviert (Sicherheitsnetz, #167) | nein |
| 🟢 `Runner · wartet auf nächsten Lauf · als Nächstes #43` | idle (kein laufender Prozess), Queue nicht leer, nächster Takt startet automatisch | nein |
| 🟢 `Runner · nichts offen · zuletzt #42` | idle, Queue leer | nein |
| 🟡 `Runner · wartet auf dich (#42)` | Frage offen oder Freigabe nötig — der Text im Ticket trennt beides: „wartet auf deine Antwort" (`needs-answer`) vs. „wartet auf eine Freigabe" (#196) | **ja** |
| 🔴 `Runner · Fehler bei #42` | abgebrochen, Details am Ticket | **ja** |
| 🔵 `Runner · Limit erreicht · #42 pausiert` | macht von selbst weiter | nein |
| ⚪️ `Runner · nichts zu tun` | kein Ticket auf `ready`, `plan` oder `research` | nein (außer du willst was) |

🟢 heißt jetzt ausdrücklich **idle**: kein laufender Prozess, egal ob noch Arbeit
in der Queue liegt oder nicht — das unterscheidet den Titel klar von 🟠.

Nur **Gelb und Rot** verlangen dich. Alles andere ist Information.

Gelb erscheint auch dann, wenn der Runner selbst gerade nichts zu tun hat, aber
irgendwo ein `needs-answer` hängt — „nichts zu tun" wäre in dem Fall eine Lüge,
die dich das Ticket übersehen ließe.

## Board-Spalten

`Backlog` → `Ready` → `In Progress` (max. 1) → `In Review` → `Done`

## Definition of Ready

Ein Issue darf erst nach `Ready`, wenn es enthält:

- **Ziel** in einem Satz (was soll danach möglich sein)
- **Akzeptanzkriterien** im Given/When/Then-Format
- **Nicht-Ziele** (was in diesem Ticket ausdrücklich nicht passiert)
- **Betroffener Milestone**

Ein Ticket mit dem Label `plan` ist per Definition **nicht** ready — ihm fehlt
der Plan aus dem vorherigen Abschnitt (Schrittfolge, Testplan, Risiko/Rückweg,
Wiederaufnahmepunkte). Erst wenn Opus diesen Plan im Chat ergänzt hat und
`plan` gegen `ready` tauscht, darf der Runner es nehmen.

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
4. `src/db/**` und `src/local/**` sind empfindliche Pfade. Seit #276 blockiert das
   den Merge nicht mehr — der Kommentar am Ticket bleibt trotzdem Pflicht (siehe unten).

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
