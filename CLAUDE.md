# CLAUDE.md

Verbindliche Arbeitsanweisung für alle KI-Agenten in diesem Repo. Vorrang vor
Bequemlichkeit, Geschwindigkeit und eigenen Ideen.

Gegliedert nach **Moment im Lauf**: jede Regel steht genau einmal, an der Stelle,
an der sie greift.

## Was das hier ist

Persönliche Produktivitäts-PWA für **eine einzige Person**: Termine, Aufgaben,
Journal, Routinen. Mobile-first, offline-fähig.

```bash
pnpm dev           # Entwicklung
pnpm lint          # ESLint
pnpm typecheck     # tsc --noEmit
pnpm test          # Vitest (Logik, Sync, Krypto)
pnpm e2e           # Playwright
pnpm db:generate   # Drizzle-Migration erzeugen
pnpm db:migrate    # Migration anwenden
```

---

## Bevor du anfängst

**Pflichtlektüre ist diese Datei und `docs/CODEMAP.md`. Sonst nichts.** Alles
Weitere liest du nur bei konkretem Anlass:

| Anlass | Dann liest du |
| --- | --- |
| Schema, Migration, Sync | `docs/ARCHITECTURE.md` |
| UI, Design, Motion | `docs/DESIGN_SYSTEM.md` |
| Journal, Krypto | `docs/adr/0004-journal-metadaten-verschluesseln.md` |
| Zweifel, ob ein Ticket zum Produkt passt | `docs/VISION.md` |
| Architektur- oder Grundsatzfrage | das passende ADR unter `docs/adr/` |

ADRs sind getroffene Entscheidungen. Sie werden nicht neu verhandelt.

**Ein Ticket zur Zeit.** WIP-Limit 1 — kein neues Issue anfassen, solange ein PR
offen ist. Bei mehreren Runner-Slots gilt das **pro Slot**
(`docs/adr/0014-mehrere-runner-slots.md`).

**Eigener Worktree, vor der ersten Zeile Code.** Mehrere Läufe teilen dieses
Repo, ein Checkout hat einen `HEAD`. Im Haupt-Checkout **niemals** den Branch
wechseln, committen oder pushen — auch nicht, wenn du ihn auf einem
Feature-Branch vorfindest.

```bash
git -C /Users/max/dev/project_starship fetch origin
git -C /Users/max/dev/project_starship worktree add -b feat/42-quick-add \
  /Users/max/dev/project_starship/.claude/worktrees/issue-42 origin/main
```

- **Absolute Pfade, immer** — ein relativer Pfad blockiert stumm jedes
  `git`-Kommando.
- Ein Worktree je Ticket, Name = Ticketnummer; `.claude/worktrees/` ist in
  `.gitignore`. Aus einer Chat-Sitzung stattdessen
  `~/dev/starship-worktrees/<branch-slug>`.
- Abräumen nach dem Merge: `git worktree remove <pfad>`, **nie** `rm -rf`. Der
  Runner räumt nur seine eigenen.
- Abgebrochenen Lauf im **selben** Worktree fortsetzen, keinen zweiten anlegen.
- `pnpm install` **nur** mit `--dir <Haupt-Checkout>`, nie mit cwd im Worktree.

Gründe — zwei echte Vorfälle: `docs/warum/worktree.md`.

**Branch:** `feat/<nr>-<slug>`, `fix/<nr>-<slug>`, `chore/<nr>-<slug>`.

**Plan vor Bau.** Komplexe Tickets (mehrdeutig, architektonisch, sensible Pfade,
Migration, Krypto, Sync) plant Opus vor `ready` (Label `plan`) — ohne Plan baut
der Runner nicht; einfache dürfen `plan` überspringen. Hochschalten auf Opus tut
der Runner **nie von sich aus**, nur per Eskalation nach drei erfolglosen
Läufen; der Mensch darf die Stufe vorgeben (`model:haiku|sonnet|opus`).
`docs/workflow/eskalation.md`, `docs/adr/0013-modellstufe-am-ticket.md`.

---

## Während du baust

**Ohne Akzeptanzkriterien wird nicht gebaut** (ADR-0026). Findet der Runner im
Ticket-Body keinen Abschnitt `## Akzeptanzkriterien` mit einer Aufzählung
darunter — nummeriert, Checkboxen oder schlichte Punkte —, startet er dich gar
nicht erst: Kommentar ans Ticket, `needs-answer`, Ende. Fließtext zählt nicht.

**Kein Scope-Creep.** Nur was in den Akzeptanzkriterien steht. Ein Fund neben der
Spur (roter Test, Auffälligkeit, Verdacht) wird als Zeile unter „## Funde
nebenbei" im Fortschrittskommentar vermerkt — Fundort `<pfad>:<zeile>`, Symptom
in einem Satz. **Kein `gh issue create`.** Ein Fund ist kein Auftrag und ändert
deinen Auftrag nicht. Einzige Ausnahme: der Planer, der ein Ticket in
Kind-Tickets aufteilt.

**Änderung an der Grundlage braucht Papier — im selben PR:**

- Neue Dependency → ADR-Entwurf mit Begründung und Alternativen, auf Freigabe
  warten.
- Schema-Änderung → Drizzle-Migration, Up- **und** Down-Pfad.

**Architektur-Invarianten** (Details `docs/ARCHITECTURE.md`):

- **Local-first.** Die UI liest und schreibt gegen IndexedDB, nie direkt gegen
  die API; jede Mutation läuft durch die Outbox. `check-sync-invariants.sh`
  erzwingt das.
- **Journal-Inhalte verlassen das Gerät nur verschlüsselt** — nie Klartext an
  den Server, nie Klartext loggen.
- **Kein Vendor-Lock-in.** DB-Zugriff nur über Drizzle gegen Standard-Postgres,
  keine Vercel- oder Neon-Primitive. Das Projekt muss jederzeit auf einen
  eigenen Server umziehbar sein.
- **Niemals Secrets committen** — keine echten Tokens in Tests, Fixtures,
  Beispielen.

**Sprache:** Code, Bezeichner, Kommentare, Commits **Englisch**. UI-Texte
**Deutsch**.

### Tests sind der Auftrag, nicht das Hindernis

Du schreibst Code **und** Tests — der Interessenkonflikt ist dir bewusst.

- Jedes Feature-Ticket liefert Playwright-Tests, die 1:1 die Akzeptanzkriterien
  abbilden. Code ohne begleitenden Test ist ein rotes Anwesenheits-Gate; einzige
  Entrinnung ist das vom Menschen gesetzte Label `tests-exempt` — **nie selbst
  setzen**.
- **Tests werden niemals abgeschwächt, um grün zu werden** — kein `.skip`,
  `.only`, `waitForTimeout`, aufgeweichtes Assert, erhöhter Timeout als Fix.
  `check-test-integrity.sh` ist Required Check und fängt es ohnehin.
- Ein roter Test ist ein Fund, kein Hindernis. Die Testanzahl darf nie sinken;
  ist ein Test wirklich obsolet, begründest du das am Ticket und fragst nach —
  du entscheidest das nicht selbst.
- Ein Flake-Nachweis läuft über `--repeat-each`, eingegrenzt auf die betroffenen
  Tests — **niemals** als N ganze Suiten hintereinander
  (`docs/workflow/ticket-und-tests.md`, „Wie ein Flake-Fix belegt wird").
- Jedes Akzeptanzkriterium muss innerhalb eines Lauf-Fensters (45 Minuten)
  prüfbar sein. Sonst ist es keine Anforderung, sondern eine Sackgasse.

### Token-Disziplin

Verbrauch skaliert mit **Kontext**, nicht mit der Anzahl deiner Nachrichten. Was
einmal im Kontext ist, bleibt den Rest des Laufs darin.

- **Erst die Karte, dann suchen.** `docs/CODEMAP.md` gibt die Grobstruktur.
- **Das Ticket nennt die betroffenen Dateien.** Lies die — nicht das halbe Repo.
  Ist die Liste unvollständig, ergänze sie am Ticket.
- **Suchen delegierst du an den Explore-Subagenten** (Haiku, eigenes
  Kontextfenster). Sein Suchmüll landet nie bei dir.
- **Tests führst du über den `test-runner`-Subagenten aus**, nie direkt. Lokal
  läuft nur der Spec zum aktuellen Ticket; die volle Suite läuft in CI.
- **Keine `@datei.ts`-Referenzen** — das injiziert die ganze Datei plus den
  CLAUDE.md-Baum. Nenne den Pfad als normalen Text.
- **Nichts pasten, was du auch lesen kannst.**
- **Kein Subagenten-Wildwuchs.** Nur für lesende, klar begrenzte Aufgaben.

Modellpolitik und Hebel im Detail: `docs/TOKEN-BUDGET.md`.

---

## Nach jedem Schritt

Dein Lauf kann jederzeit abbrechen — Usage-Limit, Stromausfall, Timeout. Dein
Arbeitsstand darf **niemals nur in der Session leben.**

1. **Committen und pushen.** Conventional Commits (`feat(tasks): add swipe to
   complete`); `wip:` ist auf Feature-Branches erlaubt und wird gesquasht.
2. **Fortschrittskommentar am Issue aktualisieren** — genau *ein* Kommentar, den
   du editierst, damit keine Kommentarflut entsteht.

```markdown
## 🤖 Fortschritt (automatisch aktualisiert)

Branch: `feat/42-quick-add-task`

- [x] Datenmodell + Migration
- [ ] ← HIER WEITER: Outbox-Anbindung
- [ ] Playwright-Tests

Zuletzt: 13.07. 14:20
```

`← HIER WEITER` ist die Wiederaufnahmestelle. Existiert der Kommentar, **fängst
du dort an — nicht von vorne.**

**Ab dem ersten erfolglosen Bau-Lauf** zusätzlich:

- Ein Abschnitt „## Was schon versucht wurde" **wächst** über Läufe hinweg statt
  überschrieben zu werden: was versucht wurde, woran es scheiterte, was damit
  ausgeschlossen ist. Existiert er, liest du ihn **zuerst** und schlägst keinen
  dort ausgeschlossenen Weg erneut ein.
- Die Checkliste wird feiner: ein Haken **je Fehlereinheit** (je rotem Test, je
  rotem Check) statt je Phase, Gruppenkopf „(N von M grün)". Jede gelöste
  Einheit **einzeln** committen und pushen, der Marker rückt auf die nächste.

**Wird dein Lauf abgebrochen, musst du nichts tun.** Der Runner hält das Ticket
an und startet dich wieder, sobald Kontingent da ist. Dein nächster Lauf liest
Branch, `git log` und Fortschrittskommentar und macht weiter — kein Neuanfang.

---

## Wenn du nicht weiterkommst

Du läufst auf einem Rechner, an dem **niemand sitzt**. Der Nutzer ist unterwegs
und sieht nur GitHub auf dem Handy. **Fragen stellst du ausschließlich als
Kommentar am Issue** — niemals nach stdout, niemals ins Terminal.

1. `gh issue comment <nr>`: was du wissen musst, **konkrete Optionen (A/B/C)**,
   deine Empfehlung, und was passiert, wenn niemand antwortet.
2. Label `needs-answer` setzen. Ohne das Label startet dich der Runner in
   20 Minuten erneut mit derselben offenen Frage.
3. Lauf beenden.

Das Ticket behält `in-progress` und wird von der Auswahl übersprungen, solange
`needs-answer` hängt — es wartet sichtbar, belegt aber keinen Bauplatz. Sobald
der Mensch antwortet und das Label entfernt, wird es **fortgesetzt, nicht neu
gestartet** (`docs/workflow/zyklus.md`, „Wartend ist nicht in Arbeit").

Die Frage muss vom Handy aus mit einem Satz beantwortbar sein. „Wie soll ich
vorgehen?" ist keine brauchbare Frage. „A: Swipe nach links löscht sofort.
B: Swipe nach links öffnet ein Menü. Ich empfehle A mit Undo-Toast." ist eine.

**Rate nie.** Lieber steht ein Ticket 12 Stunden still, als dass es in die
falsche Richtung läuft. Widerspricht ein Ticket der Vision, wird nicht
implementiert, sondern nachgefragt.

---

## Am Ende

Dein Lauf endet, sobald der Branch gepusht ist. **Du wartest nicht auf CI.**

```bash
gh pr create --draft --fill --title "feat(...): … — Closes #<nr>"   # nur beim ERSTEN Push
```

Existiert für dieses Ticket schon ein offener PR, gibt es **keinen zweiten** —
du pushst weiter auf denselben Branch.

**Endet dein Lauf sauber** (Ticket fertig oder Fortsetzung gepusht — also nicht
über eine offene Frage), gibst du an den AK-Check ab. **Du mergst nicht selbst:**

```bash
gh issue edit <nr> --add-label check
```

Der PR bleibt Entwurf, `in-progress` bleibt stehen, dein Lauf endet. Den Rest
macht ein eigener, nur lesender Prüf-Lauf (ADR-0026): er hält deinen Diff gegen
die Akzeptanzkriterien des Tickets und hebt den PR erst dann aus dem Entwurf.
**Du hast den Code geschrieben — dass er die Kriterien erfüllt, ist deshalb
nicht deine Feststellung.** Derselbe Interessenkonflikt wie bei den Tests.

Fehlt etwas, nimmt der Prüfer `check` wieder ab und schreibt die offenen
Kriterien in den Fortschrittskommentar; der nächste Takt bist wieder du, mit
einer benannten Lücke statt einem gemergten PR.

`gh pr ready` und `gh pr merge` rufst du **nicht** — die stehen nur noch im
Prüf-Lauf. Ob CI grün ist, musst du ohnehin **nicht** wissen.

**Kein `gh pr checks --watch`** — das ist Aufgabe der CI-Wache im Runner-Takt
(die volle Suite lokal läuft ohnehin nicht, siehe Token-Disziplin). Wird CI rot,
startet dich der nächste Takt gezielt
mit Job, Testname und Fehlermeldung: Trace zuerst lesen, Ursache beheben (nie
den Test aufweichen), schnelle Tore lokal grün, auf denselben Branch pushen,
kein neuer PR. Nach dem **dritten** vergeblichen Versuch mit derselben Ursache:
aufhören, Kommentar, `needs-answer` — drei rote Runden heißen, das Ticket ist
falsch geschnitten.
Zustandstabelle: `docs/workflow/merge.md`; der neue Takt steht in
`docs/workflow/zyklus.md`.

**Bevor du den Worktree verlässt:** `git status --short`. Steht das `M` in der
**vorderen** Spalte, ist der Index dreckig — das räumt kein `git clean` weg und
kostet dich beim nächsten Commit gemergte Arbeit (`docs/warum/worktree.md`).

**Niemals:** nach `main` pushen (Branch-Schutz verhindert es ohnehin),
force-pushen, History umschreiben, einen Check überspringen.

---

## Sensible Pfade

`src/db/`, `src/crypto/`, `src/local/`, `src/app/api/sync/`, alles mit `auth` im
Namen, `.github/`, `scripts/`. Ein Fehler ist dort kein Bug, sondern
**Datenverlust**. Einen Wächter gibt es hier nicht mehr — das macht deine
Sorgfalt wichtiger, nicht unwichtiger (`docs/warum/sensible-pfade.md`).

Berührt dein Diff einen dieser Pfade, **sofort beim Öffnen des PR**:

1. Kommentar ans Issue: **was** du geändert hast, **warum**, was schiefgehen
   könnte, wie der Rückweg aussieht. Das ist die einzige Spur, die ein Mensch
   später findet.
2. Schema berührt? Migration in denselben PR, up **und** down (siehe oben).
3. Bei Krypto, Sync oder Migration **nicht sicher**? `needs-answer` — nicht
   „läuft ja durch". Aber **nicht** `needs-answer` setzen, nur weil ein Pfad in
   dieser Liste steht: das hielte das Ticket an, ohne dass jemand etwas zu
   entscheiden hätte.

Versuche nie, einen Wächter abzuschalten oder eine Änderung so umzuschneiden,
dass sie an einer Prüfung vorbeirutscht.

---

## Definition of Done

- [ ] Alle Akzeptanzkriterien erfüllt
- [ ] Playwright-Test je Akzeptanzkriterium, grün
- [ ] Offline-Pfad getestet (Mutation offline → online → serverseitig angekommen)
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm e2e` grün
- [ ] Mobile (iPhone 12 mini hochkant, 375 × 812) geprüft — Desktop läuft seit
      #564 nicht mehr in CI
- [ ] Keine neuen Dependencies ohne ADR
- [ ] Dark Mode funktioniert
- [ ] `prefers-reduced-motion` respektiert
