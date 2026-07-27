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

export function buildPrompt(issue: number): string {
  return `Du arbeitest UNBEAUFSICHTIGT. Es sitzt niemand am Terminal.

Arbeite an Issue #${issue} in diesem Repo.

${FILE_ACCESS_RULE}

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
   Optionen und deiner Empfehlung, Label 'needs-input' setzen, beenden.
   Rate niemals. Schreib die Frage NICHT nach stdout.
7. Existiert für dieses Ticket noch KEIN PR: öffne einen **Draft**-PR
   ('gh pr create --draft --fill --title "… — Closes #${issue}"'), Titel
   enthält 'Closes #${issue}'. Existiert bereits einer (z. B. bei einer
   Fortsetzung): pushe nur weiter auf denselben Branch, KEIN zweiter PR.
   Berührt dein Diff einen geschützten Pfad (src/db/, src/crypto/,
   src/local/, src/app/api/sync/, auth, .github/, scripts/): kommentiere
   JETZT am Issue, was du geändert hast, warum, und was schiefgehen könnte,
   und setze SELBST 'gh issue edit ${issue} --add-label needs-input' — nimm
   es in diesem Lauf NICHT wieder ab. Das parkt das Ticket (#145) sofort,
   der Runner wählt als nächstes ein anderes, statt auf das rote
   CI-Ergebnis zu warten, das du ohnehin nicht mehr live mitbekommst.
8. Endet dein Lauf hier SAUBER — also über diesen Schritt, nicht über
   Schritt 6 (offene Frage) —: hebe deinen PR SELBST aus dem Entwurf und
   aktiviere Auto-Merge, auch wenn du gerade in Schritt 7 wegen eines
   geschützten Pfads 'needs-input' gesetzt hast:
   'gh pr ready' und 'gh pr merge --squash --auto --delete-branch'
   (ohne PR-Nummer — wirkt auf den PR des aktuellen Branches). Du musst
   NICHT wissen, ob CI schon grün ist: GitHub merged automatisch nur bei
   grünen Required Checks. Bei geschütztem Pfad hält 'protected-paths'
   ohnehin rot, bis ein Mensch 'human-approved' setzt — der PR ist dann
   zwar kein Entwurf mehr, wartet aber trotzdem. Dein Lauf endet danach.
   **Kein** 'gh pr checks --watch', **kein** voller 'pnpm e2e' lokal — der
   Runner-Takt beobachtet ab hier die CI und holt dich nur zurück, wenn
   dort etwas rot wird.`;
}

/**
 * Ersetzt den Bau-Prompt, wenn die CI-Wache rote Checks am Draft-PR gefunden
 * hat, die NICHT ausschliesslich 'protected-paths' sind. Der Agent bekommt die
 * Ursache direkt mit, statt sie muehsam neu zu suchen -- deshalb startet er
 * hier gezielt, nicht routinemaessig.
 */
export function ciFixPrompt(issue: number, ciSummary: string): string {
  return `Du arbeitest UNBEAUFSICHTIGT. Es sitzt niemand am Terminal.

Der Draft-PR zu Issue #${issue} hat rote CI. Der Runner-Takt hat gewartet, bis
alle Checks durch waren, und startet dich JETZT gezielt, weil es etwas zu TUN
gibt.

${FILE_ACCESS_RULE}

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
   (offene Frage) —: 'gh pr ready' und
   'gh pr merge --squash --auto --delete-branch' (ohne PR-Nummer — wirkt
   auf den PR des aktuellen Branches). Meist ist der PR das schon (ein
   früherer sauberer Bau-Lauf hat das erledigt) — der Aufruf ist folgenlos,
   wenn er es bereits ist, und das Sicherheitsnetz, falls nicht. Dein Lauf
   endet danach. **Kein** 'gh pr checks --watch' — das übernimmt wieder
   der Runner-Takt.
7. Brauchst du eine Entscheidung: Kommentar am Issue mit konkreten Optionen +
   deiner Empfehlung, Label 'needs-input' setzen, beenden. Rate niemals.`;
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
   'needs-input' setzen, beenden. Rate nie.
5. Ist der Plan **vollständig**: Statuszeile „Status: **fertig**", Marker
   entfernen, dann gh issue edit ${issue} --remove-label plan --add-label
   ready. Erst dieser abschließende Schritt flippt das Label.`;
}

/**
 * RUN_ROLE=research (ADR-0005 + #43). Idee-/Feature-Ebene (Ob & Was, grober
 * Schnitt) -- KEIN dateiweiser Plan, das ist die Planer-Rolle. Flippt
 * research -> needs-input erst, wenn die Ueberlegung fertig ist, auch
 * dann, wenn die Idee der Vision widerspricht: nie eigenmaechtig verwerfen,
 * das entscheidet der Mensch.
 */
export function researchPrompt(issue: number): string {
  return `Du arbeitest UNBEAUFSICHTIGT als **Feature-Rechercheur** (Opus, nur lesend).
Ändere KEINEN Code, lege KEINEN Branch an, committe NICHT.

${FILE_ACCESS_RULE}

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
   gh issue edit ${issue} --remove-label research --add-label needs-input.
   Erst dieser abschließende Schritt flippt das Label — der Mensch entscheidet
   danach, ob daraus plan wird oder die Idee verworfen wird.`;
}

// Werkzeug-Allowlist der Denk-Rollen (ADR-0005 + #63): praeventiv statt nur
// detektiv -- genau das, was der Auftrag braucht, kein pauschaler Bash-Zugriff.
// Das git-status-Netz in der Auswertung bleibt zusaetzlich bestehen (Netz und
// doppelter Boden) und faengt nur noch ab, was trotz Allowlist durchrutscht.
export const READONLY_TOOLS = 'Read,Grep,Glob,Bash(gh:*),Bash(git log:*),Bash(git diff:*),Bash(git show:*)';
export const BUILD_TOOLS = 'Read,Edit,Write,Glob,Grep,Bash';
