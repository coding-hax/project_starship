# CI-Wache (Runner-Takt)

Der **Runner-Takt** (alle ~5 Minuten) bleibt trotzdem als Beobachter aktiv —
er wird seltener gebraucht, nicht überflüssig. Für ein `in-progress`-Ticket
mit offenem PR prüft er dessen CI-Zustand, bevor er überhaupt an eine
Fortsetzung oder ein anderes Ticket denkt:

| CI-Zustand des PR | Was der Takt tut | Agentenlauf? |
| --- | --- | --- |
| läuft noch (irgendein Check pending) | nichts — `in-progress` bleibt stehen, kein anderes Ticket wird gewählt | nein |
| rot, sonst irgendein Check | ein Bau-Agent startet gezielt, mit Job, Testnamen, Zeilen und Fehlermeldung als Auftrag — **nicht** die rohe Log-Ausgabe | **ja** |
| konfliktbehaftet (`DIRTY`) | ein Bau-Agent startet gezielt, mit den Konfliktdateien im Auftrag (lokal per Trockenlauf-Merge ermittelt, s. u.) | **ja** |
| hinter `main` (Checks laufen nicht mehr, s.u.) | `main` per `git fetch`+`git merge`+`git push` in den Branch nachziehen (#160) | nein — außer bei echtem Konflikt |
| grün, aber noch Entwurf (Sicherheitsnetz — z. B. nach einem abgebrochenen Lauf) | Draft → `ready`, Auto-Merge aktivieren (`gh pr merge --squash --auto --delete-branch --subject <PR-Titel> --body ''`, s. `prSquashMerge()`) | nein |
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
`required_status_checks.strict=true` (siehe Branch-Schutz in
`docs/workflow/merge.md`) verlangt den
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
