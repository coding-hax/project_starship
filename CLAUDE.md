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

1. **Ein Ticket zur Zeit.** WIP-Limit = 1. Kein neues Issue anfassen, solange ein PR offen ist. Keine "kleinen Nebenverbesserungen" im selben Branch.
2. **Kein Scope-Creep.** Nur was in den Akzeptanzkriterien des Tickets steht. Alles andere wird als neues Issue angelegt, nicht implementiert.
3. **Keine neue Dependency ohne ADR.** Wenn ein Paket nötig scheint: ADR-Entwurf in den PR, Begründung, Alternativen. Warten auf Freigabe.
4. **Keine Schema-Änderung ohne Migration.** Drizzle-Migration im selben PR, Up- und Down-Pfad.
5. **Tests werden niemals abgeschwächt, um grün zu werden.** Ein roter Test ist ein Fund, kein Hindernis. Kein `test.skip`, kein aufgeweichtes Assert, kein erhöhter Timeout als Fix.
6. **Jedes Feature-Ticket liefert Playwright-Tests**, die 1:1 die Akzeptanzkriterien abbilden.
7. **Kein Vendor-Lock-in.** Keine Vercel- oder Neon-spezifischen Primitive. DB-Zugriff ausschließlich über Drizzle gegen Standard-Postgres. Das Projekt muss jederzeit auf einen eigenen Server umziehbar sein.
8. **Local-first ist nicht optional.** Die UI liest und schreibt gegen IndexedDB, niemals direkt gegen die API. Jede Mutation läuft durch die Outbox.
9. **Journal-Inhalte verlassen das Gerät nur verschlüsselt.** Niemals Klartext an den Server, niemals Klartext loggen.
10. **Niemals Secrets committen.** Keine echten Tokens in Tests, Fixtures oder Beispielen.
11. **Bei Unklarheit: fragen, nicht raten.** Widerspricht ein Ticket der Vision, wird nicht implementiert, sondern nachgefragt.

## Konventionen

- Code, Bezeichner, Kommentare, Commits: **Englisch**. UI-Texte: **Deutsch**.
- Branch: `feat/<issue-nr>-<slug>`, `fix/<issue-nr>-<slug>`, `chore/…`
- Commits: Conventional Commits (`feat(tasks): add swipe to complete`)
- PR-Titel enthält `Closes #<issue-nr>`.
- Komplexe Tickets (mehrdeutig, architektonisch, geschützte Pfade, Migrationen, Krypto,
  Sync) werden **vor** `ready` von Opus geplant (Label `needs-plan`, siehe
  `docs/WORKFLOW.md`). Der Runner baut niemals ohne Plan; Opus bleibt im Runner tabu,
  außer in den eng begrenzten Denk-Rollen aus `docs/adr/0005-opus-im-runner.md`
  (Planung, Feature-Recherche — nie Bauen) und der Eskalations-Rolle aus
  `docs/adr/0007-opus-eskalation-baut.md` (Opus baut als letzte Stufe, wenn
  Sonnet/Haiku dreimal ohne Fortschritt bleiben; Deckel max. 2 Läufe/Ticket/Tag,
  Kill-Switch `no-escalation`, Deckel-Bypass fürs laufende Ticket per Label
  `opus-boost` — hebt nur die Zwei-Grenze auf, ohne den Tageszähler zu nullen,
  und wird von einem Opus-Bau-Lauf ohne Fortschritt wieder abgezogen;
  `no-escalation` gewinnt gegen `opus-boost`). Einfache/mechanische Tickets
  dürfen `needs-plan` überspringen.

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
2. Label `needs-input` setzen.
3. Lauf beenden.

Die Frage muss vom Handy aus mit einem Satz beantwortbar sein. „Wie soll ich vorgehen?"
ist keine brauchbare Frage. „A: Swipe nach links löscht sofort. B: Swipe nach links
öffnet ein Menü. Ich empfehle A mit Undo-Toast." ist eine.

**Rate nie.** Lieber ein Ticket steht 12 Stunden still, als dass es in die falsche
Richtung läuft.

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
  - [ ] habits-heute.spec.ts:141 sync-Timeout
```

### Wenn ein Lauf abgebrochen wird

Du musst nichts tun. Der Runner erkennt das Limit, hält das Ticket an und startet
dich wieder, sobald Kontingent da ist. Dein nächster Lauf liest Branch, `git log`
und Fortschrittskommentar und macht weiter. **Kein Neuanfang, kein Rollback.**

### Was du niemals tust

- Nach `main` pushen (Branch-Schutz verhindert es ohnehin)
- Force-Push, History umschreiben, einen Check überspringen
- Ein zweites Ticket beginnen, während eines auf `in-progress` steht
- Eine Frage stellen, ohne das Label `needs-input` zu setzen (sonst startet der
  Runner dich in 20 Minuten erneut mit derselben offenen Frage)
- Auf CI warten (`gh pr checks --watch`) oder lokal die volle `pnpm e2e`-Suite
  laufen lassen — dein Lauf endet beim Push, der Runner-Takt beobachtet die CI

## Token-Disziplin — das ist eine harte Regel, keine Bitte

Der Nutzer arbeitet mit einem Plan, dessen Kontingent begrenzt ist. Verbrauch
skaliert mit **Kontext**, nicht mit der Anzahl deiner Nachrichten. Jede Datei, die
du unnötig liest, kostet ihn Arbeitszeit am Ende der Woche.

1. **Erst die Karte, dann suchen.** `docs/CODEMAP.md` beantwortet die meisten
   „wo liegt…?"-Fragen. Grep erst, wenn die Karte nicht reicht.
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

## Merge — der Runner-Takt wacht, du endest beim Push

Du wartest nicht mehr selbst auf CI. Dein Lauf endet, sobald der Branch
gepusht und ein **Draft**-PR offen ist:

```bash
gh pr create --draft --fill --title "feat(...): … — Closes #<nr>"   # nur beim ERSTEN Push
```

Existiert für dieses Ticket schon ein offener PR (Fortsetzung eines Laufs):
**kein** zweiter — push einfach weiter auf denselben Branch.

**Kein `gh pr checks --watch`, kein voller `pnpm e2e` lokal.** Das war früher
dein Job; jetzt übernimmt ihn der Runner-Takt (alle ~5 Minuten, kostet ohne
Agentenlauf nichts):

- **CI läuft noch** → nichts tun. `in-progress` bleibt stehen, kein anderes
  Ticket wird angefasst — der Bauplatz ist weiter belegt, auch wenn gerade
  kein Agent läuft.
- **CI grün** → der Takt setzt den Draft auf `ready` und aktiviert Auto-Merge
  (`gh pr merge --squash --auto --delete-branch`) — **ohne** dich, **ohne**
  Agentenlauf. Ein Draft-PR wird nie gemerged, egal wie grün — erst dieser
  Schritt hebt ihn aus dem Entwurf.
- **CI rot** (außer `protected-paths`, siehe unten) → der Takt startet dich
  gezielt neu, mit Job, Testnamen, Zeilen und Fehlermeldung als Auftrag —
  nicht der rohen Log-Ausgabe. Lies den bestehenden Branch, `git log` und den
  Fortschrittskommentar (inkl. „Was schon versucht wurde") zuerst, behebe die
  Ursache (Playwright-Trace zuerst lesen, dann fixen — kein `.skip`, kein
  hochgesetzter Timeout, kein gelockertes Assert), lass die schnellen Tore
  (`pnpm lint`, `pnpm typecheck`, `pnpm test`) lokal grün werden, push wieder
  auf denselben Branch. Kein neuer PR.
- Nach dem **dritten** vergeblichen Versuch mit derselben Fehlerursache
  (bestehende Eskalation, siehe ADR-0007/`blocker_sig`): aufhören, Kommentar
  ans Issue mit dem, was du versucht hast, Label `needs-input`. Drei rote
  Runden bedeuten, dass das Ticket falsch geschnitten ist — das ist eine
  menschliche Entscheidung, keine technische.

### Geschützte Pfade — hier merged niemand automatisch

`src/db/`, `src/crypto/`, `src/local/`, `src/app/api/sync/`, alles mit `auth` im Namen,
`.github/` und `scripts/`.

Ein Fehler ist dort kein Bug, sondern **Datenverlust**. Der CI-Check `protected-paths`
schlägt fehl, sobald ein PR sie berührt. Berührt dein Diff einen dieser Pfade:
schreib den Kommentar **sofort beim Öffnen des Draft-PR** — warte nicht auf das
rote CI-Ergebnis, das bekommst du ohnehin nicht mehr live mit (der Runner-Takt
beobachtet die CI ab jetzt, nicht du). Was du tust:

1. Kommentar ans Issue: **was** du geändert hast, **warum**, und was schiefgehen könnte.
2. Label `human-approved` anfordern — nicht selbst setzen.

Bleibt `protected-paths` als **einziger** roter Check stehen, setzt der Runner-Takt
`needs-input` — das ist die vorgesehene Genehmigungs-Schranke, kein Fund für einen
Fix-Lauf. Der Mensch setzt vom Handy aus `human-approved` **und entfernt**
`needs-input` — danach läuft der Check automatisch neu, der nächste Takt sieht grün
und aktiviert Auto-Merge. Versuche **nie**, diesen Check zu umgehen, ihn
abzuschalten oder die Änderung so umzuschneiden, dass sie am Wächter vorbeirutscht.
Das wäre der schwerste Vertrauensbruch, der in diesem Repo möglich ist.

### Tests sind kein Hindernis, sie sind der Auftrag

Du schreibst den Code **und** die Tests. Das ist ein Interessenkonflikt, und du
weißt das. Deshalb:

- Tests bilden die Akzeptanzkriterien des Tickets ab — nicht das, was dein Code
  zufällig kann.
- Kein `.skip`, kein `.only`, kein `waitForTimeout`, kein gelockertes Assert.
  Der CI-Wächter `test-integrity` findet das und lehnt den PR ab.
- Testanzahl darf nie sinken. Wenn ein Test wirklich obsolet ist: begründen,
  `human-approved` anfordern.
- Code ohne begleitenden Test ist ein rotes Anwesenheits-Gate in `test-integrity`.
  Einzige Entrinnung ist das vom Menschen gesetzte Label `tests-exempt` für
  nachweislich testlose Änderungen (reines Refactor, Typ-Only) — nie selbst setzen.

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
