# Der Zyklus

```
Issue (grobe Idee, vom Handy eingeworfen)
   └─► [optional] research → Opus recherchiert den Fit → needs-answer → du entscheidest
Issue (mit Akzeptanzkriterien)
   └─► [nur bei Komplexität] plan → Opus plant im Chat → ready
   └─► Branch feat/<nr>-<slug>
         └─► Implementierung + Playwright-Tests
               └─► Entwurfs-PR (Closes #<nr>) → Label check
                     └─► AK-Check (eigener Lauf, nur lesend)
                           ├─► Lücke → check ab, zurück in den Bau
                           └─► alles erfüllt → pr ready + Auto-Merge
                                 └─► CI grün → Merge → Issue schließt automatisch
```

**Akzeptanzkriterien sind Pflicht, nicht Stil** (#839, ADR-0026). Ein Ticket
ohne den Abschnitt `## Akzeptanzkriterien` mit nummerierten Punkten oder
Checkboxen wird nicht gebaut: der Runner kommentiert, was fehlt, setzt
`needs-answer` und startet keinen Lauf. Fließtext zählt nicht.

**Der Bau-Lauf mergt nicht mehr selbst.** Er endet mit dem Label `check` und
lässt den PR im Entwurf. Erst ein eigener, nur lesender Prüf-Lauf hält den
fertigen Diff gegen die Kriterien — Befund je Kriterium mit Beleg, als
Kommentar `## ✅ AK-Check` am Ticket — und hebt den PR bei vollständiger
Erfüllung selbst aus dem Entwurf. Bei einer Lücke fällt `check` weg,
`in-progress` bleibt, die offenen Punkte stehen im Fortschrittskommentar und
der nächste Takt ist wieder ein Bau-Lauf. Erst der **zweite** vergebliche
Check endet mit `needs-answer`: zwei Runden am selben Kriterium heißen, dass
das Kriterium unklar ist.

**Die CI-Wache mergt nicht am Tor vorbei.** Der Runner-Takt beobachtet den PR
weiter wie gehabt — aber solange `check` hängt, hebt er einen grünen PR nicht
mehr selbst aus dem Entwurf, sondern startet den Prüf-Lauf. Wird die CI rot,
schlägt das umgekehrt das Tor: der Takt nimmt `check` zurück und lässt erst
reparieren, denn über einen Stand mit roten Checks ist nicht zu urteilen.

**Ein offenes Issue ohne jedes Steuerlabel ist der untriagierte Eingang** —
der Zustand ganz links im Diagramm, bevor du `research`/`plan`/`ready`/`next`
gesetzt hast. Der Runner baut es **nie**: die Auswahl-Kaskade
(`scripts/runner/select.ts`) matcht ausschließlich Tickets mit einem
Steuerlabel, alles andere trifft keinen Zweig. Das ist Absicht, keine Lücke —
`ready` ist bewusst dein Gate — außer für selbst angelegte Kinder-Tickets, die
schon mit `plan` entstehen und dieses Gate bewusst umgehen (siehe
`docs/workflow/labels.md`).

Bis #357 war genau das aber unsichtbar: ein untriagiertes Ticket lag da, ohne
dass irgendwo stand, dass es überhaupt existiert (#349/#351 sind so tagelang
liegen geblieben). Seit #357 (Owner-Entscheidung „C", 29.07.26) listet das
aggregierte Status-Issue offene, untriagierte Issues in einem eigenen
Abschnitt „🏷️ Untriagiert" — **nur Anzeige**, keine Auswahl-Änderung, keine
Label-Mutation. Du siehst sie jetzt, statt dass sie still verrotten; ob und
wann sie eine Bahn bekommen, entscheidest weiterhin du.

**WIP-Limit = 1.** Es gibt zu keinem Zeitpunkt zwei offene Feature-Branches.
Nichts läuft parallel. Das ist die wichtigste Regel im Repo.

**Bei mehreren Runner-Slots (#204) gilt WIP-Limit = 1 pro Slot, nicht global.**
Jeder Slot ist ein eigener Arbeitsbaum mit eigenem `.runner/` und arbeitet an
genau einem Ticket gleichzeitig; mit `SLOT_COUNT=3` können also bis zu drei
Tickets parallel `in-progress` sein — je eins pro Slot, nie zwei im selben.
Welcher Slot welches Ticket beansprucht, entscheidet ein atomarer `mkdir`-Claim
unter `SHARED_DIR/claims/<issue>`, nicht das Label. Details: ADR-0014
(0012/0013 sind vergeben/reserviert, siehe `docs/adr/`).

**Gebaut wird nur im eigenen Worktree.** Das WIP-Limit gilt für Tickets, nicht für
Prozesse: Runner, Chat-Sitzungen und CI greifen gleichzeitig auf denselben Checkout
zu. Wer im Haupt-Checkout den Branch wechselt oder committet, schreibt seine Arbeit
in den Branch eines fremden Tickets — genau so landete #196 im Icon-PR von #232.
Rezept und Pfadkonvention: `CLAUDE.md`, „Ein Worktree je Lauf".

## Wartend ist nicht in Arbeit

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
der Zwischenzeit nichts Neues an (siehe Abschnitt „Zwei Arten des Wartens" in
`docs/workflow/labels.md`).

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
bevor irgendein Zweig sie liest: laufendes `in-progress`, `next`, `plan`,
`research`, `ready` — überall.
Damit ist `hands-off` die verlässliche Bremse für ein Ticket, das gerade lokal
gebaut wird. Bis zu diesem Fix prüften ihn nur die Queue, `plan` und
`research`; ausgerechnet der Zweig fuer laufende Tickets und `ready`
ignorierten ihn.

Reihenfolge, wenn mehrere Labels gleichzeitig offen stehen: ein laufendes
`in-progress`-Bau-Ticket geht vor, danach `next`, danach `plan`, danach
`research`, erst danach `ready`. Ein Ticket mit `research` **und** `ready`
gleichzeitig gilt ebenso als inkonsistent wie bei `plan` — es wird über den
Recherche-Zweig gefangen, nicht gebaut.
