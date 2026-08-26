// Die vier Agenten-Prompts, portiert aus den Heredocs in claude-runner.sh
// (#203, S6 von #184). Reine Funktionen: Ticketnummer rein, fertiger Text
// raus -- kein gh, kein Dateisystem, keine Uhr. Damit sind sie die am
// billigsten testbare Schicht des Runners, und der Wortlaut ist gegen
// versehentliche Aenderung abgesichert (prompts.test.ts).
//
// Der `claude`-Aufruf selbst bleibt ausdruecklich in Bash (Nicht-Ziel von
// #202, AK6 von #203): TS baut den Prompt und schreibt ihn nach stdout,
// claude-runner.sh pipet ihn in `claude`.

// In JEDEM Prompt derselbe Absatz: ein rekursiver Suchlauf ueber das
// Home-Verzeichnis oder /Volumes loest auf macOS einen modalen TCC-Dialog
// aus. Der blockiert einen unbeaufsichtigten Lauf, bis die Notbremse ihn
// abwuergt -- gemessen an #38, nicht theoretisch.
const FILE_ACCESS_RULE = `**Dateizugriff bleibt im Repo.** Führe keine rekursiven oder dateisystemweiten Suchen
außerhalb dieses Repos (des ausgecheckten Arbeitsbaums) aus — kein 'find', 'grep -r',
'mdfind' oder 'locate' über das Home-Verzeichnis, '/' oder '/Volumes' — und betritt
niemals '/Volumes' oder '~/Library/Mobile Documents' (iCloud). Solche Zugriffe lösen
auf macOS einen modalen TCC-Dialog aus, der den unbeaufsichtigten Lauf blockiert, bis
die Notbremse ihn abwürgt (siehe #38). Gezielte Einzeldatei-Reads außerhalb des Repos
nur, wenn ein Ticket sie ausdrücklich verlangt.`;

// #767 (ADR-0024): beide Denk-Rollen duerfen ein Artifact auf claude.ai
// veroeffentlichen -- das Werkzeug publiziert direkt nach aussen, ohne
// vorher lokal zu schreiben, die Read-only-Zusage (ADR-0005) bleibt also
// unberuehrt. Nur in planPrompt()/researchPrompt() eingebunden, NICHT in
// buildPrompt()/ciFixPrompt() (AK4, Scope-Creep waere ein Bau-Lauf, der
// nebenbei eine Seite veroeffentlicht).
const ARTIFACT_RULE = `**Artifact (optional, claude.ai).** Das Werkzeug \`Artifact\` steht dir zur
Verfügung und veröffentlicht sofort nach außen (ADR-0024, korrigiert durch
ADR-0025).

**Erst schreiben, dann veröffentlichen.** \`Artifact\` nimmt ausschließlich
einen \`file_path\` auf eine bereits geschriebene \`.html\`/\`.md\`-Datei — es gibt
keinen Inline-Inhalt. Schreib die Datei deshalb mit \`Write\` in dein
**aktuelles Arbeitsverzeichnis** und gib erst dann den Pfad an \`Artifact\`.
Dein cwd ist ein Wegwerf-Worktree, der nach dem Lauf entfernt wird; die Datei
überlebt den Lauf nicht und gehört auch in keinen Commit. \`Edit\` hast du
weiterhin nicht — du legst neu an, du änderst nichts Bestehendes.

**Wann:** nur wenn ein anzuschauendes Objekt die Entscheidung trägt (z. B. ein
Entwurfsblatt oder eine Skizze). Reichen drei Absätze im Kommentar, bleibt es
beim Kommentar — der Normalfall ist **kein** Artifact.

**Wie:** klein — nur das Anzuschauende plus so viel Beschriftung, dass klar
ist, was was ist. Keine Begründungs-Abschnitte, keine Trade-off-Tabellen,
keine Code-Listings auf der Seite: die Überlegung steht im Issue-Kommentar,
das Artifact zeigt nur das Objekt. Nicht mehr Varianten oder Zustände, als die
Entscheidung braucht.

**Nie ins Artifact:** echte Nutzerdaten (insbesondere Journal-Inhalte,
Regel 9) oder Secrets (Regel 10) — veröffentlichen heißt, es verlässt das
Gerät.

**URL:** landet im Plan-/Rechercheergebnis-Kommentar, nicht nur in der
Galerie — der Mensch sieht unterwegs nur GitHub. Ein Fortsetzungslauf
aktualisiert über diese URL/ID **dasselbe** Artifact, statt ein zweites
anzulegen.`;

// #588: Der Runner legt keine Fund-Tickets mehr an.
//
// Bis hierher stand an dieser Stelle ein ueber #366/#397 und mehrere Vorfaelle
// gewachsenes Regelwerk (~40 Zeilen im Prompt) plus ein Snapshot-Apparat in
// queue.ts/round.ts, der die bereits bekannten Fund-Tickets in den Auftragstext
// rendern liess, damit das Dedupe mechanisch greift. Der Aufwand hat die
// Tickets nicht verhindert: zum selben Fund entstanden trotzdem mehrere, weil
// die Pflichtsuche nur greift, wenn der Lauf daran denkt -- und die Triage
// musste sie hinterher von Hand nach Datei:Zeile gruppieren.
//
// Ein Fund ist damit nicht mehr wertlos, er wird nur nicht mehr zum Ticket:
// er landet als Zeile im Fortschrittskommentar des Tickets, an dem der Lauf
// ohnehin arbeitet. Das ist derselbe Ort, den die alte Fassung schon fuer
// unbelegte Funde vorsah -- jetzt ist er der einzige.
const NO_FIND_TICKETS_RULE = `

## Funde: kein neues Ticket

Du legst **keine** Fund-Tickets an. Kein \`gh issue create\` für einen roten
Test, eine Auffälligkeit oder einen Verdacht — auch dann nicht, wenn der Fund
echt und reproduzierbar ist.

Stattdessen: eine Zeile unter \`## Funde nebenbei\` im Fortschrittskommentar
des Tickets, an dem du gerade arbeitest, mit Fundort (\`<pfad>:<zeile>\`) und
Symptom in einem Satz. Danach arbeitest du an deinem Ticket weiter — ein Fund
ist kein Auftrag und ändert deinen Auftrag nicht.

Unberührt bleibt, was ein Ticket ohnehin verlangt: der Fortschrittskommentar,
der Blocker-Kommentar, der Pflichtkommentar bei sensiblen Pfaden und die Frage
per \`needs-answer\`.`;

export function buildPrompt(issue: number): string {
  return `Du arbeitest UNBEAUFSICHTIGT. Es sitzt niemand am Terminal.

Arbeite an Issue #${issue} in diesem Repo.

${FILE_ACCESS_RULE}${NO_FIND_TICKETS_RULE}

Ablauf:
1. Pflichtlektüre ist NUR CLAUDE.md und docs/CODEMAP.md. Nichts sonst liest du
   vorab. Weitere Dokumente liest du gezielt, sobald das Ticket sie nennt oder
   einer dieser Auslöser zutrifft:
   - Schema-/Migrations-Arbeit → docs/ARCHITECTURE.md + docs/adr/0003-m0-dependencies.md
   - UI-/Design-Arbeit → docs/DESIGN_SYSTEM.md
   - Journal-/Krypto-Arbeit → docs/adr/0004-journal-metadaten-verschluesseln.md
   - Architektur-/Grundsatzfrage → das passende ADR unter docs/adr/
   Die im Ticket unter „Betroffene Dateien"/„Betroffene Docs" genannten Pfade
   sind Pflicht — lies sie selektiv, nie das halbe Repo.
2. Lies das Issue: gh issue view ${issue} --comments
3. Falls es bereits einen Branch und einen Fortschrittskommentar gibt:
   checke den Branch aus, lies den Fortschrittskommentar und 'git log',
   und mach beim nächsten offenen Punkt weiter. Fang NICHT von vorne an.
4. Arbeite die Akzeptanzkriterien ab. Committe nach jedem abgeschlossenen
   Schritt. Bevor du pushst: lass die schnellen Tore lokal laufen —
   'pnpm lint', 'pnpm typecheck', 'pnpm test' (zusammen unter einer Minute) —
   und behebe Rot dort selbst. Kein voller 'pnpm e2e' lokal, das kostet zu
   viel vom Zeitfenster und die volle Suite läuft ohnehin in CI.
   Brauchst du 'pnpm install': **nur** mit '--dir <Haupt-Checkout>', nie mit cwd in einem Worktree —
   der Worktree-'node_modules'-Symlink zeigt auf den Haupt-Checkout, ein Install mit cwd im Worktree
   schreibt dessen Top-Level-Links relativ zum Worktree und die bleiben nach 'git worktree remove'
   tot zurück (#606).
   Unmittelbar vor dem finalen Push ziehst du 'main' proaktiv nach, damit
   der PR nicht schon als „behind" entsteht: erst sicherstellen, dass der
   Arbeitsbaum sauber ist (alles committet — niemals in einen unsauberen
   Baum mergen), dann 'git fetch origin main' + 'git merge origin/main
   --no-edit'. Merge sauber: normal weiterpushen. Merge-Konflikt: du löst
   ihn direkt auf deinem Branch auf (du kennst deine eigenen Änderungen am
   besten), committest die Auflösung, pushst — kein separater, kalt
   einsteigender Fix-Lauf nötig. 'pr_catch_up_behind()' im Runner-Takt
   bleibt zusätzlich als Sicherheitsnetz bestehen, falls unmittelbar nach
   deinem Push noch ein weiterer PR merged. Dann pushe den Branch.
5. Halte den Fortschrittskommentar am Issue nach JEDEM Schritt aktuell. Bevor du
   feststeckst oder der Lauf endet, ohne dass das Ticket fertig ist: ergaenze im
   Fortschrittskommentar einen Blocker-Abschnitt (nicht nur "← HIER WEITER"):
   - aktuelle Wiederaufnahmestelle (wie bisher),
   - bei rotem Gate: der konkrete Testname + Kernursache, ein bis zwei Zeilen,
     KEIN Log-Dump,
   - Endgrund: 'gate-rot' oder 'frage-offen' (Limit/Timeout traegt das Runner-
     Skript selbst nach, das musst du nicht tun).
   Steht im Fortschrittskommentar bereits ein Abschnitt "## Was schon versucht
   wurde": lies ihn ZUERST und schlage keinen dort als ausgeschlossen
   vermerkten Weg erneut ein -- das waere ein Fehlschlag des Tickets, nicht
   nur verlorene Zeit. Ab dem ERSTEN erfolglosen Bau-Lauf haengst du selbst
   an diesen Abschnitt an (er waechst, wird nie ueberschrieben): was du
   versucht hast, woran es scheiterte, was damit ausgeschlossen ist -- in
   Klartext, kein Signatur-Hash. Ab demselben Zeitpunkt schneidest du die
   Checkliste feiner: ein Haken je Fehlereinheit (je rotem Test, je rotem
   Check) statt je Phase, mit Gruppenkopf "(N von M gruen)"; jede geloeste
   Einheit einzeln committen und pushen, der Marker "← HIER WEITER" ruckt auf
   die naechste offene Einheit, geloeste bleiben abgehakt.
6. Wenn du eine Entscheidung brauchst: Kommentar am Issue mit konkreten
   Optionen und deiner Empfehlung, Label 'needs-answer' setzen, beenden.
   Rate niemals. Schreib die Frage NICHT nach stdout.
7. Existiert für dieses Ticket noch KEIN PR: öffne einen **Draft**-PR
   ('gh pr create --draft --fill --title "… — Closes #${issue}"'), Titel
   enthält 'Closes #${issue}'. Existiert bereits einer (z. B. bei einer
   Fortsetzung): pushe nur weiter auf denselben Branch, KEIN zweiter PR.
   Berührt dein Diff einen sensiblen Pfad (src/db/, src/crypto/, src/local/,
   src/app/api/sync/, auth, .github/, scripts/): kommentiere JETZT am Issue,
   was du geändert hast, warum, und was schiefgehen könnte. Ein Fehler ist
   dort kein Bug, sondern Datenverlust — und seit #283 hält dich niemand
   mehr auf, der Kommentar ist die ganze Bremse. Setze deswegen KEIN
   'needs-answer': das würde das Ticket anhalten, ohne dass jemand etwas zu
   entscheiden hätte. Bist du dir inhaltlich unsicher, gilt Schritt 6 —
   fragen statt raten.
8. Endet dein Lauf hier SAUBER — also über diesen Schritt, nicht über
   Schritt 6 (offene Frage) —: du mergst NICHT selbst. Setze stattdessen
   'gh issue edit ${issue} --add-label check' und beende den Lauf. Der PR
   bleibt Entwurf.
   Damit übernimmt der AK-Check-Lauf (#839): ein eigener, nur lesender Lauf
   hält deinen Diff gegen die Akzeptanzkriterien des Tickets und hebt den PR
   erst dann aus dem Entwurf. Du hast den Code geschrieben — dass er die
   Kriterien erfüllt, ist deshalb nicht deine Feststellung. Fehlt etwas,
   kommst du mit einer benannten Lücke zurück statt mit einem gemergten PR.
   'in-progress' bleibt stehen, der Fortschrittskommentar bleibt dein Stand.
   **Kein** 'gh pr ready', **kein** 'gh pr merge', **kein**
   'gh pr checks --watch', **kein** voller 'pnpm e2e' lokal — der
   Runner-Takt beobachtet ab hier die CI und holt dich nur zurück, wenn
   dort etwas rot wird.`;
}

/**
 * Ersetzt den Bau-Prompt, wenn die CI-Wache rote Checks am Draft-PR gefunden
 * hat. Der Agent bekommt die Ursache direkt mit, statt sie muehsam neu zu
 * suchen -- deshalb startet er hier gezielt, nicht routinemaessig.
 *
 * #283: Bis hierher gab es eine Ausnahme fuer 'protected-paths' -- der Check
 * war eine Genehmigungs-Schranke, kein Fund. Den Job gibt es nicht mehr.
 */
export function ciFixPrompt(issue: number, ciSummary: string): string {
  return `Du arbeitest UNBEAUFSICHTIGT. Es sitzt niemand am Terminal.

Der Draft-PR zu Issue #${issue} hat rote CI. Der Runner-Takt hat gewartet, bis
alle Checks durch waren, und startet dich JETZT gezielt, weil es etwas zu TUN
gibt.

${FILE_ACCESS_RULE}${NO_FIND_TICKETS_RULE}

## Was rot ist

${ciSummary}

## Ablauf

1. Checke den bestehenden Branch aus, lies den Fortschrittskommentar am Issue
   (gh issue view ${issue} --comments) und 'git log'. Steht dort bereits ein
   Abschnitt „## Was schon versucht wurde": lies ihn ZUERST und schlage
   keinen dort ausgeschlossenen Weg erneut ein.
2. Bei einem roten Playwright-Trace: erst den Trace lesen
   ('npx playwright show-trace test-results/…/trace.zip'), dann verstehen,
   dann fixen. Die Ursache beheben — NIE den Test aufweichen: kein
   '.skip', kein hochgesetzter Timeout, kein gelockertes Assert, kein
   'waitForTimeout'.
3. Vor dem Push die schnellen Tore lokal grün: 'pnpm lint', 'pnpm typecheck',
   'pnpm test'.
4. Committe, pushe auf denselben Branch. Kein neuer PR — der Draft existiert
   bereits.
5. Aktualisiere den Fortschrittskommentar (Marker „← HIER WEITER" rückt vor;
   bei erneutem Fehlschlag wächst „## Was schon versucht wurde", wird nie
   überschrieben).
6. Endet dein Lauf hier SAUBER (Fix gepusht) — also nicht über Schritt 7
   (offene Frage) —: 'gh issue edit ${issue} --add-label check' und beenden.
   Du mergst NICHT selbst; das Tor ist der AK-Check-Lauf (#839), der deinen
   Diff gegen die Akzeptanzkriterien hält und den PR erst dann aus dem
   Entwurf hebt. Trägt das Ticket 'check' bereits, ist der Aufruf folgenlos.
   **Kein** 'gh pr ready', **kein** 'gh pr merge', **kein**
   'gh pr checks --watch' — das übernimmt wieder der Runner-Takt.
7. Brauchst du eine Entscheidung: Kommentar am Issue mit konkreten Optionen +
   deiner Empfehlung, Label 'needs-answer' setzen, beenden. Rate niemals.`;
}

/**
 * RUN_ROLE=plan (ADR-0005). Nur lesend: kein Edit/Write, kein Branch, kein
 * Commit. Schreibt den Plan inkrementell in EINEN Kommentar und flippt
 * plan -> ready erst, wenn der Plan wirklich fertig ist.
 */
export function planPrompt(issue: number): string {
  return `Du arbeitest UNBEAUFSICHTIGT als **Planer** (Opus, nur lesend). Ändere KEINEN
Code, lege KEINEN Branch an, committe NICHT.

${FILE_ACCESS_RULE}

${ARTIFACT_RULE}

1. Lies CLAUDE.md, docs/ (v. a. docs/adr/, docs/ARCHITECTURE.md), das Issue
   (gh issue view ${issue} --comments) und den **aktuellen Code** der betroffenen
   Dateien.
2. Existiert bereits ein Plan-Kommentar mit „🧠 Plan (Opus) — Status: in
   Arbeit": **setze ihn fort** ab dem Marker „← HIER WEITER BEIM PLANEN",
   statt neu zu beginnen.
3. Erstelle/ergänze in **einem** Kommentar (gh issue comment --edit-last)
   einen **dateiweisen** Umsetzungsplan: pro Datei was sich ändert, Testplan,
   Risiko/Rückweg, Wiederaufnahmepunkte. Statuszeile oben: „🧠 Plan (Opus) —
   Status: **in Arbeit**" + Marker „← HIER WEITER BEIM PLANEN: <Abschnitt>".
4. Brauchst du eine **menschliche Entscheidung** (nicht nur einen Plan):
   Statuszeile auf „Status: **wartet auf Entscheidung**", Label
   'needs-answer' setzen, beenden. Rate nie.
5. Legst du als Teil dieses Plans **Folge-/Kind-Tickets** an (z. B. weil das
   Ticket in T1/T2/T3 aufgeteilt wird): prüfe VORHER mit
   'gh issue list --search "#${issue}" --state open --json number,title,body',
   ob für dieses Elternticket #${issue} bereits gleichnamige offene Tickets
   existieren (Titel-Übereinstimmung oder ein Verweis auf #${issue} im Body).
   Das gilt genauso bei einer fortgesetzten Session, nicht nur beim ersten
   Anlauf — ein zweiter, zeitgleicher Plan-Lauf auf demselben Ticket kann
   dieselbe Antwort unabhängig gelesen und ebenfalls umgesetzt haben.
   Findest du welche: lege **nichts neu an**, sondern nenne die gefundenen
   Ticket-Nummern im Plan-Kommentar statt sie still zu ignorieren. Nur wenn
   keine existieren, legst du sie an — und zwar mit
   'gh issue create --label plan' und einem Verweis auf #${issue} im Body
   (Label im selben Schritt, nur selbst angelegte, nie fremde). Bauen die
   Kind-Tickets aufeinander auf: trage 'Nach: #<Vorgänger>' als eigene Zeile
   in den Body des abhängigen Kindes ein — im selben Schritt, in dem du es
   anlegst, nicht nachträglich. Das ist die
   einzige Stelle, an der ein Lauf noch Tickets anlegt — Funde gehören seit
   #588 in den Fortschrittskommentar, nicht in ein Ticket. So wird jedes Kind selbst geplant und
   vom Planer-Lauf am Ende auf 'ready' gesetzt, statt labellos
   liegenzubleiben.
6. Ist der Plan **vollständig**: Statuszeile „Status: **fertig**", Marker
   entfernen, dann gh issue edit ${issue} --remove-label plan
   --remove-label in-progress --add-label ready.
   Erst dieser abschließende Schritt flippt das Label und entfernt
   in-progress (der Denk-Lauf ist zu Ende).`;
}

/**
 * RUN_ROLE=research (ADR-0005 + #43). Idee-/Feature-Ebene (Ob & Was, grober
 * Schnitt) -- KEIN dateiweiser Plan, das ist die Planer-Rolle. Flippt
 * research -> needs-answer erst, wenn die Ueberlegung fertig ist, auch
 * dann, wenn die Idee der Vision widerspricht: nie eigenmaechtig verwerfen,
 * das entscheidet der Mensch.
 */
export function researchPrompt(issue: number): string {
  return `Du arbeitest UNBEAUFSICHTIGT als **Feature-Rechercheur** (Opus, nur lesend).
Ändere KEINEN Code, lege KEINEN Branch an, committe NICHT.

${FILE_ACCESS_RULE}

${ARTIFACT_RULE}

1. Verstehe die Idee im Issue (gh issue view ${issue} --comments).
2. Prüfe den Fit gegen docs/VISION.md, docs/ARCHITECTURE.md, docs/DESIGN_SYSTEM.md
   und den bestehenden Code. Optional knappe Web-Recherche (bounded) über das
   WebSearch-Werkzeug.
3. Existiert bereits ein Rechercheergebnis-Kommentar mit „🔎 Recherche — Status:
   in Arbeit": **setze ihn fort** ab dem Marker „← HIER WEITER BEI DER
   RECHERCHE", statt neu zu beginnen.
4. Erstelle/ergänze in **einem** Kommentar (gh issue comment --edit-last) eine
   **Überlegung** auf Idee-/Feature-Ebene: Was ist es? Passt es zur Vision
   (auch: passt es *nicht* — das klar benennen, nicht eigenmächtig verwerfen)?
   2–3 Ansätze mit Trade-offs, Empfehlung, grober Scope. **Kein Code, keine
   dateiweise Umsetzung** — das ist der spätere Planer-Lauf (plan).
   Statuszeile oben: „🔎 Recherche — Status: **in Arbeit**" + Marker „← HIER
   WEITER BEI DER RECHERCHE: <Abschnitt>".
5. Ist die Überlegung **vollständig** (auch wenn das Ergebnis ein Widerspruch
   zur Vision ist): Statuszeile „Status: **fertig**", Marker entfernen, dann
   gh issue edit ${issue} --remove-label research --remove-label in-progress
   --add-label needs-answer. Erst dieser abschließende Schritt flippt das
   Label und entfernt in-progress (der Denk-Lauf ist zu Ende) — der Mensch entscheidet
   danach, ob daraus plan wird oder die Idee verworfen wird.`;
}

/**
 * RUN_ROLE=check (#839). Das letzte Tor vor dem Merge: haelt den fertigen Diff
 * gegen die Akzeptanzkriterien des Tickets. Nur lesend, und bewusst ein
 * EIGENER Lauf -- der Bau-Lauf hat den Code geschrieben und ist damit
 * derselbe Interessenkonflikt wie bei den Tests (CLAUDE.md).
 *
 * Die Kriterien kommen als Liste herein, nicht als "lies sie dir aus dem
 * Ticket": so ist die Nummerierung im Befund garantiert dieselbe, die
 * ak.ts und das Tor in round.ts sehen. Ein Befund "AK 3 nicht erfuellt",
 * der auf ein anderes Kriterium zeigt als das Ticket, waere schlimmer als
 * kein Befund.
 */
export function checkPrompt(issue: number, criteria: string[], branch: string): string {
  const list = criteria.map((text, index) => `${index + 1}. ${text}`).join('\n');

  return `Du arbeitest UNBEAUFSICHTIGT als **AK-Prüfer** (nur lesend). Ändere KEINEN
Code, committe NICHT, pushe NICHT.

Du prüfst den fertigen Stand von Issue #${issue} (Branch \`${branch}\`) gegen die
Akzeptanzkriterien des Tickets — sonst nichts. Du baust nicht nach, du
verbesserst nicht, du ergänzt keine Tests. Findest du eine Lücke, benennst du
sie; schließen wird sie der nächste Bau-Lauf.

${FILE_ACCESS_RULE}

## Die Kriterien (maßgeblich, in dieser Nummerierung)

${list}

## Ablauf

1. Dein Arbeitsverzeichnis ist ein Wegwerf-Worktree **auf dem PR-Branch**. Der
   Diff des Tickets ist \`git diff origin/main...HEAD\` — erst
   \`--stat\` für den Überblick, dann gezielt die Dateien, die für ein Kriterium
   zählen. Die Dateien liegst du im Zweifel direkt (\`Read\`), nicht nur als
   Diff-Auszug: ein Kriterium kann auch von unverändertem Code erfüllt sein.
2. Lies das Ticket (\`gh issue view ${issue} --comments\`) für den Kontext —
   maßgeblich sind aber die oben genannten Kriterien, nicht die Prosa drumherum
   und nicht der Fortschrittskommentar des Bau-Laufs. Dass er einen Haken
   gesetzt hat, ist **kein** Beleg.
3. Urteile **je Kriterium** und belege jedes Urteil:
   - **erfüllt** — im Diff (oder im vorhandenen Code) belegt UND ein Test hält
     es fest. Beleg: \`<pfad>:<zeile>\` und der Testname. Trägt das Ticket das
     Label \`tests-exempt\`, entfällt der Testteil.
   - **nicht erfüllt** — fehlt, oder der Code sagt etwas anderes als das
     Kriterium. Beleg: die Stelle, an der es fehlt oder abweicht.
   - **nicht prüfbar** — weder aus Diff noch aus Tests entscheidbar (z. B. rein
     visuelle Zusagen ohne Messung). Sag in einem Satz, **was** fehlt, um es
     prüfbar zu machen. Fürs Tor zählt das wie „nicht erfüllt" — aber der
     Bau-Lauf weiß dann, dass ein Beleg fehlt, nicht Code.
   Rate nie. Ein unsicheres „wird schon" ist \`nicht prüfbar\`, nicht \`erfüllt\`.
4. Schreib das Ergebnis in **einen** Kommentar am Ticket, überschrieben mit
   \`## ✅ AK-Check\`. Existiert er von einem früheren Check-Lauf bereits,
   **editiere ihn** (\`gh api\`-PATCH auf die Kommentar-ID), statt einen zweiten
   anzulegen. Inhalt: eine Tabelle \`Nr · Kriterium (gekürzt) · Befund · Beleg\`,
   darunter eine Zeile \`Ergebnis: N von M erfüllt\`.

## Ausgang

**Alle Kriterien erfüllt** — du gibst den PR frei:

\`\`\`
gh issue edit ${issue} --remove-label check
gh pr ready
gh pr merge --squash --auto --delete-branch --subject "$(gh pr view --json title -q .title)" --body ""
\`\`\`

Das \`--subject\` ist Pflicht, kein Stil: bei einem Ein-Commit-Branch nähme
GitHub sonst die Commit-Nachricht als Squash-Betreff, das \`Closes #${issue}\`
aus dem PR-Titel ginge verloren und das Issue bliebe trotz Merge offen (#292).
Ob CI grün ist, musst du nicht wissen — Auto-Merge greift ohnehin erst bei
grünen Required Checks. **Kein** \`gh pr checks --watch\`.

**Mindestens ein Kriterium offen** — der PR bleibt Entwurf:

- \`gh issue edit ${issue} --remove-label check\` (\`in-progress\` bleibt stehen,
  der nächste Takt ist wieder ein Bau-Lauf),
- die offenen Kriterien als Punkte in den **Fortschrittskommentar** des
  Tickets, mit Nummer und dem, was konkret fehlt — der Bau-Lauf liest dort
  weiter, nicht in deinem Prüfbericht.

**Zweiter Check mit demselben Ergebnis** — stand schon vor deinem Lauf ein
\`## ✅ AK-Check\`-Kommentar mit offenen Kriterien am Ticket, dann ist das hier
der zweite vergebliche Anlauf: setze zusätzlich \`gh issue edit ${issue}
--add-label needs-answer\` und beende. Zwei Runden am selben Kriterium heißen,
dass das Kriterium unklar ist — das entscheidet der Mensch, nicht eine dritte
Runde.`;
}

// Werkzeug-Allowlist der Denk-Rollen (ADR-0005 + #63): praeventiv statt nur
// detektiv -- genau das, was der Auftrag braucht, kein pauschaler Bash-Zugriff.
// Das git-status-Netz in der Auswertung bleibt zusaetzlich bestehen (Netz und
// doppelter Boden) und faengt nur noch ab, was trotz Allowlist durchrutscht.
export const READONLY_TOOLS = 'Read,Grep,Glob,Bash(gh:*),Bash(git log:*),Bash(git diff:*),Bash(git show:*)';
export const BUILD_TOOLS = 'Read,Edit,Write,Glob,Grep,Bash';

// #839: der Pruefer liest wie die Denk-Rollen, braucht aber zusaetzlich
// 'git fetch' -- ohne aktuelles origin/main zeigt 'git diff origin/main...HEAD'
// auf einen veralteten Merge-Base und meldet fremde Aenderungen als Teil
// dieses Tickets. Kein Artifact, kein Write: der Befund gehoert als Tabelle
// ans Ticket, nicht auf eine Seite.
export const CHECK_TOOLS = `${READONLY_TOOLS},Bash(git fetch:*)`;

// O3 (#325): harte Zusatzgrenze neben der Allowlist. Seit ADR-0025 verbietet
// sie nur noch `Edit`, nicht mehr `Write`.
//
// Grund: `Artifact` (ADR-0024) nimmt ausschliesslich einen `file_path` auf eine
// schon geschriebene Datei -- ohne `Write` ist das Werkzeug fuer die
// Denk-Rollen unbenutzbar. ADR-0024 hatte das Gegenteil angenommen ("publiziert
// direkt, ohne Umweg ueber ein lokales Write") und dafuer ein Stop-Gate
// vorgesehen; der Mensch hat es am 16.08.26 aufgeloest.
//
// Was `Write` hier NICHT oeffnet: Claude Code sperrt Schreibzugriffe auf den
// Arbeitsbaum ein (empirisch geprueft -- ein Pfad ausserhalb wird mit "liegt
// ausserhalb der erlaubten Arbeitsverzeichnisse" abgelehnt), und der cwd der
// Denk-Rollen ist seit #325 ein Wegwerf-Worktree, den claude-runner.sh nach
// dem Lauf entfernt. Geschrieben werden kann also nur, was ohnehin weggeworfen
// wird. `Edit` bleibt gesperrt: neu anlegen ja, Bestehendes aendern nein.
//
// Pfad-gebundene Regeln (`Write(//pfad/**)`) waeren die feinere Grenze, wirken
// aber in 2.1.202 weder ueber --allowedTools noch ueber --disallowedTools noch
// ueber --settings -- geprueft, alle drei Wege ignorieren den Pfadteil.
export const READONLY_DENY = 'Edit';
