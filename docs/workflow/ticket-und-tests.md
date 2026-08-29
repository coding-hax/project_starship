# Ticket & Tests

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
| 🔵 `Runner · Kontingent leer bis HH:MM · #42` | Token-Kontingent aufgebraucht, alle Slots warten bis HH:MM, macht von selbst weiter (#891) | nein |
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
```

Kein Milestone-Feld: das Repo führt keine GitHub-Milestones. Wo ein Ticket in
der Roadmap steht, sagt `docs/VISION.md` — und nur die.

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
4. E2E-Tests in CI (Playwright in `ci.yml`, lokal laufen Tests gegen eine lokale
   Postgres-Instanz und einen lokalen Dev-Server)
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
   den Merge nicht mehr — der Kommentar am Ticket bleibt trotzdem Pflicht (siehe
   „Der ausgesprochene Preis" in `docs/workflow/merge.md`).

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
- Jeder Feature-Test läuft in **einem** Viewport: 375 × 812 (iPhone). Bis #564 lief
  jeder Test zusätzlich in 1280 × 800 — das war exakt die Hälfte der Suite (573 von
  1171 Tests, 48,8 von 98 Minuten Testzeit) und hat `e2e-main` von ~6 auf ~13 Minuten
  gebracht. 568 dieser 573 Tests waren dieselben Assertions in breiter. Schreibe
  **keine** Desktop-Akzeptanzkriterien mehr: sie würden nirgends ausgeführt und sähen
  trotzdem nach Abdeckung aus. Desktop-only-Layout (Sidebar, Nav-Reihenfolge) ist
  damit ungeprüft — das ist der bewusst bezahlte Preis, siehe #564.
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
gh issue list --label ready --state open
gh issue view 42
gh pr create --fill --title "feat(tasks): quick add — Closes #42"
gh pr checks           # CI-Status
gh run view --log-failed
```
