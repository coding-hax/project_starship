# CLAUDE.md

Dies ist die verbindliche Arbeitsanweisung für alle KI-Agenten in diesem Repo.
Sie hat Vorrang vor Bequemlichkeit, Geschwindigkeit und eigenen Ideen.

## Was das hier ist

Eine persönliche Produktivitäts-Web-App (PWA) für **eine einzige Person**:
Termine, Aufgaben, Journal, Gewohnheiten. Mobile-first, offline-fähig.

Vor jeder Arbeit lesen:

- `docs/VISION.md` — was wir bauen und was ausdrücklich **nicht**
- `docs/ARCHITECTURE.md` — Stack, Datenmodell, Sync-Konzept
- `docs/DESIGN_SYSTEM.md` — Farben, Typo, Motion, Mobile-Patterns
- `docs/WORKFLOW.md` — wie ein Ticket zum Merge wird
- `docs/adr/` — bereits getroffene Entscheidungen. Diese werden nicht neu verhandelt.

## Harte Regeln

1. **Ein Ticket zur Zeit.** WIP-Limit = 1. Kein neues Issue anfassen, solange ein PR offen ist. Keine "kleinen Nebenverbesserungen" im selben Branch. Laufen mehrere Runner-Slots (#204), gilt das WIP-Limit **pro Slot** — jeder Slot ist ein eigener Arbeitsbaum und baut für sich genommen an genau einem Ticket. Details: `docs/adr/0014-mehrere-runner-slots.md`.
2. **Kein Scope-Creep.** Nur was in den Akzeptanzkriterien des Tickets steht. Alles andere wird als neues Issue angelegt, nicht implementiert. Vor dem Anlegen eines Fund-/Test-Tickets erst nach dem Fundschlüssel suchen (offen **und** geschlossen) — Titelform, Pflichtsuche und Trefferpolitik: `docs/WORKFLOW.md`, „Fundschlüssel & Pflichtsuche".
3. **Keine neue Dependency ohne ADR.** Wenn ein Paket nötig scheint: ADR-Entwurf in den PR, Begründung, Alternativen. Warten auf Freigabe.
4. **Keine Schema-Änderung ohne Migration.** Drizzle-Migration im selben PR, Up- und Down-Pfad.
5. **Tests werden niemals abgeschwächt, um grün zu werden.** Ein roter Test ist ein Fund, kein Hindernis. Kein `test.skip`, kein aufgeweichtes Assert, kein erhöhter Timeout als Fix. Ein Flake-Nachweis läuft über `--repeat-each`, eingegrenzt auf die betroffenen Tests (siehe `docs/WORKFLOW.md`, „Wie ein Flake-Fix belegt wird") — **niemals** als N ganze Suiten hintereinander. Jedes Akzeptanzkriterium muss innerhalb eines Lauf-Fensters (45 Minuten) prüfbar sein — sonst ist es keine Anforderung, sondern eine Sackgasse.
6. **Jedes Feature-Ticket liefert Playwright-Tests**, die 1:1 die Akzeptanzkriterien abbilden.
7. **Kein Vendor-Lock-in.** Keine Vercel- oder Neon-spezifischen Primitive. DB-Zugriff ausschließlich über Drizzle gegen Standard-Postgres. Das Projekt muss jederzeit auf einen eigenen Server umziehbar sein.
8. **Local-first ist nicht optional.** Die UI liest und schreibt gegen IndexedDB, niemals direkt gegen die API. Jede Mutation läuft durch die Outbox.
9. **Journal-Inhalte verlassen das Gerät nur verschlüsselt.** Niemals Klartext an den Server, niemals Klartext loggen.
10. **Niemals Secrets committen.** Keine echten Tokens in Tests, Fixtures oder Beispielen.
11. **Bei Unklarheit: fragen, nicht raten.** Widerspricht ein Ticket der Vision, wird nicht implementiert, sondern nachgefragt.
12. **Jeder Lauf arbeitet in einem eigenen Worktree.** Egal ob Runner oder Terminal-Sitzung: Der Haupt-Checkout `/Users/max/dev/project_starship` ist zum Lesen da, nicht zum Bauen. **Niemals** darin einen Branch wechseln, committen oder pushen — es arbeiten mehrere Läufe gleichzeitig im selben Repo. Details unten: „Ein Worktree je Lauf".

## Konventionen

- Code, Bezeichner, Kommentare, Commits: **Englisch**. UI-Texte: **Deutsch**.
- Branch: `feat/<issue-nr>-<slug>`, `fix/<issue-nr>-<slug>`, `chore/…`
- Arbeitest du aus einer Chat-Sitzung, baust du in einem eigenen Worktree unter
  `~/dev/starship-worktrees/<branch-slug>` — nie im Haupt-Checkout, in dem
  parallel der Runner arbeitet. **Nach dem Push räumst du ihn wieder weg**
  (`git worktree remove`, nie `rm -rf` — sonst bleibt Gits Verwaltungseintrag
  liegen). Der Runner räumt nur seine eigenen Worktrees ab; für deinen ist
  sonst niemand zuständig.
- **Nie einen Worktree mit gestagten Änderungen zurücklassen.** Ein liegen
  gebliebener Index ist keine Unordnung, sondern eine geladene Waffe: `git
  checkout -- .` und `git clean -fd` fassen ihn nicht an, er überlebt jedes
  Aufräumen und macht beim nächsten Commit stillschweigend gemergte Arbeit
  rückgängig. Vor dem Verlassen: `git status --short` — steht das `M` in der
  **vorderen** Spalte, ist der Index dreckig.
- Commits: Conventional Commits (`feat(tasks): add swipe to complete`)
- PR-Titel enthält `Closes #<issue-nr>`.
- Komplexe Tickets (mehrdeutig, architektonisch, geschützte Pfade, Migrationen, Krypto,
  Sync) werden **vor** `ready` von Opus geplant (Label `plan`); der Runner baut
  niemals ohne Plan. Einfache/mechanische Tickets dürfen `plan` überspringen.
  Der Runner schaltet **von sich aus** nie auf Opus hoch — außer über die
  Eskalation nach drei erfolglosen Läufen. Der Mensch darf die Startstufe am
  Ticket vorgeben (`model:haiku|sonnet|opus`); `model:opus` baut dann sofort
  auf Opus, unter denselben Deckeln. Details, Labels, Deckel:
  `docs/WORKFLOW.md`, `docs/adr/0005-opus-im-runner.md`,
  `docs/adr/0007-opus-eskalation-baut.md`,
  `docs/adr/0013-modellstufe-am-ticket.md`.

## Befehle

```bash
pnpm dev           # Entwicklung
pnpm lint          # ESLint
pnpm typecheck     # tsc --noEmit
pnpm test          # Vitest (Logik, Sync, Krypto)
pnpm e2e           # Playwright
pnpm db:generate   # Drizzle-Migration erzeugen
pnpm db:migrate    # Migration anwenden
```

## Autonomer Betrieb — lies das genau

Du läufst über einen Runner (`scripts/claude-runner.sh`) auf einem Rechner, an dem
**niemand sitzt**. Der Nutzer ist unterwegs und sieht nur GitHub auf dem Handy.

**Fragen stellst du ausschließlich als Kommentar am Issue.** Niemals nach stdout,
niemals ins Terminal — das liest niemand.

So fragst du:

1. `gh issue comment <nr>` mit: was du wissen musst, **konkrete Optionen (A/B/C)**,
   deine Empfehlung, und was passiert, wenn nicht geantwortet wird.
2. Label `needs-answer` setzen — es steht eine Frage im Ticket, die eine
   geschriebene Antwort braucht. Seit #272 ist das das einzige Wartelabel.
3. Lauf beenden.

Mehr brauchst du hier nicht zu tun. Das Ticket behält `in-progress` (#272) und
wird von der Auswahl übersprungen, solange `needs-answer` hängt — es wartet
sichtbar, belegt aber keinen Bauplatz. Sobald der Mensch antwortet und das
Label entfernt, wird es fortgesetzt, nicht neu gestartet. Details:
`docs/WORKFLOW.md`, „Wartend ist nicht in Arbeit".

Die Frage muss vom Handy aus mit einem Satz beantwortbar sein. „Wie soll ich vorgehen?"
ist keine brauchbare Frage. „A: Swipe nach links löscht sofort. B: Swipe nach links
öffnet ein Menü. Ich empfehle A mit Undo-Toast." ist eine.

**Rate nie.** Lieber ein Ticket steht 12 Stunden still, als dass es in die falsche
Richtung läuft.

### Ein Worktree je Lauf — vor der ersten Zeile Code

Es arbeiten **mehrere Läufe gleichzeitig im selben Repo**: der Runner, parallele
Terminal-Sitzungen, du. Ein geteilter Checkout hat genau einen `HEAD` — wer darin
den Branch wechselt, zieht ihn allen anderen unter den Füßen weg.

Das ist kein theoretisches Risiko. Am 26.07.26 baute der Runner das Ticket #196 im
Haupt-Checkout, der auf `fix/232-fab-icon-size` stand. Die komplette Runner-Arbeit
landete in einem Commit mit der Nachricht „increase FAB icon font-size" und wäre über
den Icon-PR halbfertig nach `main` gemerged worden.

Deshalb, **bevor du irgendetwas änderst**:

```bash
git -C /Users/max/dev/project_starship fetch origin
git -C /Users/max/dev/project_starship worktree add -b feat/42-quick-add \
  /Users/max/dev/project_starship/.claude/worktrees/issue-42 origin/main
```

- **Absolute Pfade, immer.** Ein relativer Pfad legt den Worktree mitten ins Repo und
  blockiert dort stumm jedes weitere `git`-Kommando.
- `.claude/worktrees/` ist in `.gitignore` — der Worktree taucht nirgends im Diff auf.
- Ein Worktree je Ticket, Name = Ticketnummer. Nach dem Merge:
  `git worktree remove <pfad>`.
- Nimmst du einen abgebrochenen Lauf wieder auf, benutzt du **denselben** Worktree
  weiter, statt einen zweiten anzulegen.
- Der Haupt-Checkout bleibt auf `main` und sauber. Findest du ihn auf einem
  Feature-Branch vor: **nicht** darin weiterarbeiten, eigenen Worktree anlegen.

### Fortschritt sichern — nach JEDEM Schritt

Dein Lauf kann jederzeit abbrechen: Usage-Limit erreicht, Stromausfall, Timeout.
Deshalb darf dein Arbeitsstand **niemals nur in der Session leben.**

Nach jedem abgeschlossenen Schritt:

1. **Committen und pushen** (`wip:`-Commits sind auf Feature-Branches erlaubt und
   werden beim Merge gesquasht).
2. **Fortschrittskommentar am Issue aktualisieren** — genau _ein_ Kommentar,
   den du editierst (`gh issue comment --edit-last`), damit keine Kommentarflut entsteht:

```markdown
## 🤖 Fortschritt (automatisch aktualisiert)

Branch: `feat/42-quick-add-task`

- [x] Datenmodell + Migration
- [x] Bottom-Sheet-Komponente
- [ ] ← HIER WEITER: Outbox-Anbindung
- [ ] Playwright-Tests
- [ ] Offline-Pfad

Zuletzt: 13.07. 14:20
```

Der Marker `← HIER WEITER` ist die Wiederaufnahmestelle. Wenn du einen Lauf beginnst
und dieser Kommentar existiert, **fängst du dort an — nicht von vorne.**

**Ab dem ersten erfolglosen Bau-Lauf** (siehe ADR-0007) gilt zusätzlich:

- Ein Abschnitt „## Was schon versucht wurde" im Fortschrittskommentar **wächst**
  über Läufe hinweg, statt überschrieben zu werden — was versucht wurde, woran
  es scheiterte, was damit ausgeschlossen ist, in Klartext (kein Signatur-Hash).
  Existiert er bereits, liest du ihn **zuerst** und schlägst keinen dort als
  ausgeschlossen vermerkten Weg erneut ein — Wiederholung ist ein Fehlschlag
  des Tickets, nicht nur verlorene Zeit.
- Die Checkliste wird feiner geschnitten: ein Haken **je Fehlereinheit** (je
  rotem Test, je rotem Check) statt je Phase, mit Gruppenkopf „(N von M grün)".
  Jede gelöste Einheit wird **einzeln** committet und gepusht, der Marker
  `← HIER WEITER` rückt auf die nächste offene Einheit, gelöste bleiben
  abgehakt.

```markdown
## Fortschritt
- [x] AppHeader in Varianten chrome/inline
- [x] Layout-Shift beim Tab-Wechsel vermieden
- Tests (3 von 6 grün):
  - [x] shell.spec.ts:114 Header-Aktivzustand
  - [x] shell.spec.ts:180 mobile Platzierung
  - [x] shell.spec.ts:195 Sidebar-Platzierung
  - [ ] ← HIER WEITER: habits.spec.ts:247 sync-Timeout
  - [ ] habits.spec.ts:274 sync-Timeout
  - [ ] habits-uebersicht.spec.ts:141 sync-Timeout
```

### Wenn ein Lauf abgebrochen wird

Du musst nichts tun. Der Runner erkennt das Limit, hält das Ticket an und startet
dich wieder, sobald Kontingent da ist. Dein nächster Lauf liest Branch, `git log`
und Fortschrittskommentar und macht weiter. **Kein Neuanfang, kein Rollback.**

### Was du niemals tust

- Im Haupt-Checkout bauen: den Branch dort wechseln, dort committen oder pushen
  (siehe „Ein Worktree je Lauf")
- Nach `main` pushen (Branch-Schutz verhindert es ohnehin)
- Force-Push, History umschreiben, einen Check überspringen
- Ein zweites Ticket beginnen, während eines auf `in-progress` steht
- Eine Frage stellen, ohne das Label `needs-answer` zu setzen (sonst startet der
  Runner dich in 20 Minuten erneut mit derselben offenen Frage)
- Auf CI warten (`gh pr checks --watch`) oder lokal die volle `pnpm e2e`-Suite
  laufen lassen — dein Lauf endet beim Push, der Runner-Takt beobachtet die CI

## Token-Disziplin — das ist eine harte Regel, keine Bitte

Der Nutzer arbeitet mit einem Plan, dessen Kontingent begrenzt ist. Verbrauch
skaliert mit **Kontext**, nicht mit der Anzahl deiner Nachrichten. Jede Datei, die
du unnötig liest, kostet ihn Arbeitszeit am Ende der Woche.

1. **Erst die Karte, dann suchen.** `docs/CODEMAP.md` gibt die Grobstruktur —
   für Detail (Zusammenhänge, Implementierungsdetails) ist der
   Explore-Subagent der Weg, nicht Grep im Hauptkontext.
2. **Das Ticket nennt die betroffenen Dateien.** Lies die — und nicht das halbe Repo.
   Wenn die Liste im Ticket unvollständig ist, ergänze sie, statt beim nächsten Mal
   wieder zu suchen.
3. **Suchen delegierst du an den Explore-Subagenten** (läuft auf Haiku, eigenes
   Kontextfenster). Sein Suchmüll landet nie bei dir.
4. **Tests führst du über den `test-runner`-Subagenten aus**, nie direkt.
   Er gibt dir „3 rot, hier ist warum" statt 400 Zeilen Playwright-Output.
   Und lokal läuft nur der Spec zum aktuellen Ticket — die volle Suite läuft in CI
   und kostet dort nichts.
5. **Keine `@datei.ts`-Referenzen.** Das injiziert die ganze Datei plus den
   CLAUDE.md-Baum. Nenne den Pfad als normalen Text, dann liest du selektiv.
6. **Nichts pasten, was du auch lesen kannst.** Alles, was einmal im Kontext ist,
   bleibt für den Rest des Laufs darin.
7. **Kein Subagenten-Wildwuchs.** Subagenten haben eigene Kontextfenster —
   überall eingesetzt vervielfachen sie den Verbrauch. Nur für lesende, klar
   begrenzte Aufgaben: suchen, testen, prüfen.

## Merge — du hebst deinen PR selbst aus dem Entwurf (#167)

Du wartest nicht mehr selbst auf CI. Dein Lauf endet, sobald der Branch
gepusht ist. Existiert für dieses Ticket noch kein PR:

```bash
gh pr create --draft --fill --title "feat(...): … — Closes #<nr>"   # nur beim ERSTEN Push
```

Existiert für dieses Ticket schon ein offener PR (Fortsetzung eines Laufs):
**kein** zweiter — push einfach weiter auf denselben Branch.

**Endet dein Lauf sauber** (Ticket fertig oder Fortsetzung erfolgreich
gepusht — also nicht über eine offene Frage, siehe unten), hebst du den PR
**selbst** aus dem Entwurf und aktivierst Auto-Merge, bevor du beendest:

```bash
gh pr ready                                     # ohne Nummer -> PR des aktuellen Branches
gh pr merge --squash --auto --delete-branch --subject "$(gh pr view --json title -q .title)" --body ""
```

Das `--subject` ist Pflicht, kein Stil: bei genau einem Commit auf dem Branch
nimmt GitHub sonst dessen Commit-Nachricht statt des PR-Titels als
Squash-Betreff — ein nur im Titel stehendes `Closes #N` ginge verloren und
das Issue bliebe trotz sauber gemergtem PR offen (#292).

Du musst dafür **nicht** wissen, ob CI schon grün ist — das ist der Punkt:
Auto-Merge greift ohnehin erst, wenn alle Required Checks grün sind. Ein
Entwurf bedeutet jetzt: **der Lauf ist nicht sauber zu Ende gekommen** — nicht
mehr „der Runner hat noch nicht hingeschaut".

**Kein `gh pr checks --watch`, kein voller `pnpm e2e` lokal.** Das ist Aufgabe
der CI-Wache im Runner-Takt danach, nicht deine. Kurz zusammengefasst: läuft
CI noch, passiert nichts; wird sie grün, merged GitHub von selbst; wird sie
rot, startet dich der nächste Takt
gezielt neu mit Job/Testname/Fehlermeldung als Auftrag — Trace zuerst lesen,
Ursache beheben (nie Test aufweichen, Regel 5), schnelle Tore lokal grün,
wieder auf denselben Branch pushen, kein neuer PR. Nach dem **dritten**
vergeblichen Versuch mit derselben Ursache: aufhören, Kommentar, `needs-answer`
(dieselbe erschöpfte Eskalation wie in „So fragst du" oben, ADR-0007) — drei
rote Runden heißen, das Ticket ist falsch geschnitten,
eine menschliche Entscheidung. Vollständige Zustandstabelle:
`docs/WORKFLOW.md`, „Merge: Claude hebt seinen PR selbst aus dem Entwurf".

Stellst du stattdessen eine Frage (`needs-answer`, siehe „Autonomer Betrieb"
oben): der PR bleibt Entwurf — du beendest den Lauf, **bevor** du `gh pr
ready` erreichst.

### Sensible Pfade — hier fängt dich niemand mehr auf

`src/db/`, `src/crypto/`, `src/local/`, `src/app/api/sync/`, alles mit `auth` im Namen,
`.github/` und `scripts/`. Ein Fehler ist dort kein Bug, sondern **Datenverlust**.

**Es gibt dort keinen Wächter mehr.** `protected-paths` blockierte seit #276
nicht mehr und ist seit #283 ganz weg — ein Check, der nie fehlschlägt, bringt
niemandem etwas bei. Der Mensch gibt die PRs ohnehin direkt frei (Begründung
und der bewusst akzeptierte Preis: `docs/WORKFLOW.md`, „Ein Wächter").

Das macht deine Sorgfalt **wichtiger**, nicht unwichtiger. Berührt dein Diff
einen dieser Pfade, **sofort beim Öffnen des PR**:

1. Kommentar ans Issue: **was** du geändert hast, **warum**, was schiefgehen
   könnte, und wie der Rückweg aussieht. Das ist jetzt die einzige Spur, die
   ein Mensch später findet.
2. Rührt die Änderung ein Schema an, gehört die Migration in denselben PR
   (Regel 4) — up **und** down.
3. Bist du dir bei einer Änderung an Krypto, Sync oder Migration **nicht
   sicher**, ist das ein Fall für `needs-answer` und Nachfragen, nicht für
   „läuft ja durch".

Was du **nicht** tust: `needs-answer` setzen, nur weil ein Pfad in dieser Liste
steht. Das hielte das Ticket an, ohne dass jemand etwas zu entscheiden hätte —
und genau das war bis #283 die Vorschrift. Der Kommentar ersetzt sie.

Versuche nie, einen Wächter abzuschalten oder eine Änderung so umzuschneiden,
dass sie an einer Prüfung vorbeirutscht. Dass es hier keinen mehr gibt, ist
eine **Entscheidung des Menschen** — keine Einladung, es bei den übrigen Toren
genauso zu halten.

### Tests sind kein Hindernis, sie sind der Auftrag

Du schreibst Code **und** Tests — Interessenkonflikt, du weißt das. Kein
`.skip`, kein `.only`, kein `waitForTimeout`, kein gelockertes Assert (Regel 5,
mechanisch erzwungen durch `test-integrity`). Testanzahl darf nie sinken; ist
ein Test wirklich obsolet, begründest du das am Ticket und fragst nach
(`needs-answer`), statt selbst zu entscheiden. Code
ohne begleitenden Test ist ein rotes Anwesenheits-Gate — einzige Entrinnung
ist das vom Menschen gesetzte Label `tests-exempt`, nie selbst setzen.

## Definition of Done

Ein Ticket ist fertig, wenn **alle** Punkte erfüllt sind:

- [ ] Alle Akzeptanzkriterien erfüllt
- [ ] Playwright-Test je Akzeptanzkriterium, grün
- [ ] Offline-Pfad getestet (Mutation offline → online → serverseitig angekommen)
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm e2e` grün
- [ ] Mobile (375px) **und** Desktop (1280px) geprüft
- [ ] Keine neuen Dependencies ohne ADR
- [ ] Dark Mode funktioniert
- [ ] `prefers-reduced-motion` respektiert
