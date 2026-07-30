# Rückblick: erste Fund-Tickets (vor den #410-Regeln)

## Warum

#410 deckte auf, dass eine ganze Vierer-Charge (#404–#407) aus einem
Runner-Testlauf kein echter Fund war, sondern eine Umgebungsfalle im
Extra-Worktree (fehlendes `pnpm install` / nicht gepinnte `STATE_DIR`/
`REPO_DIR`). Daraufhin bekam der Fund-Prozess in #410 vier feste Regeln,
darunter „kein Fund ohne Reproduktion".

Dieses Ticket (#412) ist die einmalige Rückschau auf die Fund-Tickets, die
**vor** diesen Regeln angelegt wurden: hat der jeweils gemergte Fix/Test
wirklich gebraucht, was er behauptet hat? Es ist kein laufender Prozess —
der Wiederholungs-Leak ist bereits über #410 R2 gestopft. Die hier
katalogisierte Population ist abgeschlossen und wird nicht fortgeschrieben.

## Urteilstabelle

| Nr | Testort-Anspruch | Gemergt (Commit) | Art | Urteil | Empfohlene Folge |
|----|---|---|---|---|---|
| [#391](https://github.com/coding-hax/project_starship/issues/391) | `journal-settings-panel.tsx:8` — Recovery-Key nach Setup nirgends erneut abrufbar | `467e035` fix(journal) | code-fix | nötig | keine |
| [#392](https://github.com/coding-hax/project_starship/issues/392) | `journal-gate.tsx:145` — Passphrase-Felder ohne name/autocomplete | `554487e` fix(journal) | code-fix | nötig | keine |
| [#393](https://github.com/coding-hax/project_starship/issues/393) | `use-journal-entries.ts:30` — console.error in Live-Query-Hooks, Klartext-Leck | `37e04f4` fix(journal) | code-fix (sensibel: Journal-Leak-Härtung) | nötig | keine |
| [#394](https://github.com/coding-hax/project_starship/issues/394) | `e2e-bridge.tsx:50` — Klartext-Beweis fehlt für Konflikt-Kopien/Tagesliste | `7758666` test(journal) | test-only | nötig | keine |
| [#395](https://github.com/coding-hax/project_starship/issues/395) | `sync.ts:14` — `PRESERVE_DISPLACED` + Konflikt-Kopien-Pfad nach #376 evtl. tot | `1a1d82e` fix(local) | code-fix (sensibel: `src/local/sync.ts`) | nötig | keine |
| [#396](https://github.com/coding-hax/project_starship/issues/396) | `lock-store.ts:31` — Auto-Lock/BroadcastChannel-Randfälle unbelegt | `e99d4f2` test(journal) | test-only | nötig | keine |
| [#404](https://github.com/coding-hax/project_starship/issues/404) | `ci-watch.test.sh:260` — Status-Titel meldet „CI läuft" nicht mehr | `7604c89` fix(runner) | code-fix (runner) | **Anomalie**, siehe unten | keine |
| [#405](https://github.com/coding-hax/project_starship/issues/405) | `limit-until.test.sh:160` | kein Closes-Commit | kein Code | Phantom (#410-Charge) | keine |
| [#406](https://github.com/coding-hax/project_starship/issues/406) | `waiting-ci-watch.test.sh:264` | kein Closes-Commit | kein Code | Phantom (#410-Charge) | keine |
| [#407](https://github.com/coding-hax/project_starship/issues/407) | `waiting-label.test.sh:285` | kein Closes-Commit | kein Code | Phantom (#410-Charge) | keine |
| [#363](https://github.com/coding-hax/project_starship/issues/363) | Übersicht: zwei Links mit Namen „Journal" (a11y, Fund aus #342) | `ada035b` fix(uebersicht) | code-fix (pre-366) | nötig | keine |
| [#364](https://github.com/coding-hax/project_starship/issues/364) | `aktivitaeten.spec.ts` AC6 — horizontaler Overflow bei 375px | `35b7ab4` fix(ui) | code-fix (pre-366) | nötig | keine |
| [#349](https://github.com/coding-hax/project_starship/issues/349) | mobile Nav überschreitet Viewport-Breite intermittierend | kein eigener Closes-Commit | kein Code | verzichtbar (Duplikat/anderswo erledigt) | keine — Ticket bereits geschlossen |
| [#351](https://github.com/coding-hax/project_starship/issues/351) | Stand-Hinweis-Test überläuft horizontal bei 1280px | kein eigener Closes-Commit | kein Code | verzichtbar (Duplikat/anderswo erledigt) | keine — Ticket bereits geschlossen |

### Anomalie #404

#410 erklärt den *Titel-Verdacht* der ganzen #404–#407-Charge für falsch
(alle vier Symptome kamen aus der Umgebungsfalle, nicht aus echten
Runner-Bugs). Unter der Nummer #404 wurde aber tatsächlich ein realer
Env-Bug korrekt behoben: `7604c89` pinnt in `ci-watch.test.sh` genau die
`STATE_DIR`/`REPO_DIR`-Falle, die #410 als Ursache für die ganze Charge
benennt. Der Fix ist also kein Netto-Negativ — er beseitigt eine reale
Fehlerquelle, nur die ursprüngliche Diagnose (ein "CI läuft"-Status-Bug)
war falsch benannt. Kein Folge-Ticket, kein Revert.

## Was bewusst NICHT getan wird

Kein autonomer Revert von Test-, Krypto- oder Sync-Code. #393, #394, #395
und #396 fassen Journal/Krypto/`src/local/`-Sync an — Regel 5
(„Testanzahl darf nie sinken; obsolete Tests nur mit Begründung +
`needs-answer`") und die sensiblen Pfade verbieten es, hier aus eigenem
Urteil zurückzubauen. Nach der Verifikation oben gibt es ohnehin kein
bestätigtes Netto-Negativ, das einen Rückbau nahelegen würde — alle
gemergten Fixes/Tests waren nötig. Ein zukünftiges Netto-Negativ würde ein
eigenes Folge-Ticket zur menschlichen Entscheidung bekommen, nie einen
autonomen Rückbau.

## Ergebnis

0 Folge-Tickets. Alle katalogisierten Fund-Tickets vor #410 waren
begründet (nötig) oder korrekt ohne Code geschlossen (Phantom/kein Code).
Die einzige Auffälligkeit (#404) ist ein falsch benannter, aber real
gültiger Fix — keine Handlung nötig.
