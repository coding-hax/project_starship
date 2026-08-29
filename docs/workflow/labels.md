# Labels — sie steuern den Runner

Der Runner (`scripts/claude-runner.sh`) liest ausschließlich Labels. Sie sind die
Zustandsmaschine des ganzen Setups:

| Label            | Bedeutung                                                      | Wer setzt es |
| ---------------- | -------------------------------------------------------------- | ------------ |
| `research` | Grobe Idee, noch kein Ticket — Opus recherchiert den Fit, dann `needs-answer`. | **Du**       |
| `plan`     | Ticket erfasst, aber noch nicht baubereit — Opus plant im Chat. | **Du** oder Runner (beim Aufteilen in Kind-Tickets) |
| `check`    | **Rolle: das Tor vor dem Merge** (#839). Ein eigener, nur lesender Lauf hält den fertigen Diff gegen die Akzeptanzkriterien des Tickets und hebt den PR erst dann aus dem Entwurf. Setzt der Bau-Lauf am Ende selbst; der Prüf-Lauf nimmt es wieder ab — bei einer Lücke bleibt der PR Entwurf und das Ticket geht zurück in den Bau. | Runner |
| `ready`          | Von dir freigegeben. Claude darf das Ticket nehmen.            | **Du**; der Planer-Lauf am Ende eines Kind-Ticket-Durchlaufs (#439) |
| `next`           | **Vor allem anderen — die Queue** (#725, ADR-0023). Schlägt die Label-Kaskade komplett, je ältestes `createdAt`; das Rollenlabel bestimmt weiter `plan`/`research`/Bau. Bleibt am Ticket stehen, bis es schließt — nicht nur bis zum Start des Bau-Laufs. | **Du**; der Planer beim Aufteilen in Kind-Tickets |
| `in-progress`    | Claude arbeitet daran. Es gibt immer höchstens eins **je Slot** (#204). Wird geschlossen (Auto-Merge oder von Hand), nimmt der nächste `claimSweep` das Label wieder ab (#498). | Runner       |
| `needs-answer`    | **Wartet auf dich: Antwort oder Freigabe.** Das mechanische Tor — schließt das Ticket aus der Auswahl aus und parkt es. | Claude / Runner |
| `hands-off`      | **Der Runner fasst das Ticket nicht an — auf keinem Zweig.** Auch nicht, wenn es `next` oder `ready` trägt. Für alles, woran gerade von Hand gearbeitet wird. | **Du**       |
| `blocked-limit`  | Opus-Tagesbudget für dieses Ticket erschöpft. Läuft morgen von selbst weiter. (Nur noch der Opus-Tagesdeckel — das Session-/Token-Kontingent trägt seit #891 kein Label mehr.) | Runner       |
| `blocked-by`     | Wartet auf ein anderes Ticket — die Abhängigkeit steht als `Nach: #227` im Body des wartenden Tickets. Setzt und entfernt der **Runner** selbst; von Hand angefasst richtest du nur Schaden an. | Runner       |
| `model:haiku` `model:sonnet` `model:opus` | **Startstufe** für dieses Ticket (ADR-0013). Höchstens eins setzen. `model:opus` baut sofort auf Opus, ohne die drei erfolglosen Läufe. Bei `plan`/`research` schlägt das Label die Rolle. | **Du**       |
| `no-escalation`  | Kill-Switch: der Runner schaltet nie selbst hoch. Es gilt die Startstufe aus dem Label (ohne Label: Sonnet). | **Du**       |
| `opus-boost`     | Hebt den Opus-Tagesdeckel für dieses eine Ticket auf (Zähler läuft weiter), Kill-Switch `no-escalation` gewinnt. Wird von einem Opus-Bau-Lauf ohne Fortschritt wieder abgezogen. | **Du**       |
| `tests-exempt`   | Testlose Änderung (Refactor/Typen) nachweislich gerechtfertigt oder ein toter Zweig samt Tests wird bewusst entfernt — hebt Anwesenheits-Gate **und** Testanzahl-Gate in `check-test-integrity.sh` für diesen PR auf (issue #303). | **Du**       |
| `bug` `epic`     | Reine Sortier-Labels — sie steuern den Runner nicht. `epic` markiert zusammenhängende Tickets und hat **keine** Wirkung auf die Auswahl. | **Du**       |

Der Bau fordert `tests-exempt` per Kommentar an (Selbst-Ausnahme wäre derselbe
Interessenkonflikt wie bei Tests); der Planer benennt im Plan, welche Änderung
testlos gerechtfertigt ist, du setzt das Label.

**Der Runner legt keine Fund-Tickets mehr an (#588).** Bis dahin lagerte ein
Lauf einen Fund neben der Spur (roter Test, Auffälligkeit) in ein eigenes
Ticket aus, das über einen Fundschlüssel `Fund: <pfad>:<zeile>` dedupliziert
und mit `plan` sofort in die Selbstheilung geschickt wurde (#397). Der Apparat
hat die Duplikate nicht verhindert — zum selben Fund entstanden trotzdem
mehrere Tickets, und die Triage musste sie hinterher von Hand gruppieren.
Ein Fund landet jetzt als Zeile unter „## Funde nebenbei" im
Fortschrittskommentar des laufenden Tickets. Bestehende Tickets mit einer
`Fund:`-Zeile bleiben ganz normale Tickets; die Zeile ist nur noch Text.

**Vom Planer beim Aufteilen eines Tickets angelegte Kinder-Tickets** (z. B.
wenn der Plan das Ticket in T1/T2/T3 zerlegt) tragen seit #439 im selben
Schritt **`plan`** — nie `ready`. Sie laufen damit den Weg `plan` → Opus
plant → `ready` (gesetzt vom Planer-Lauf am Ende) → gebaut, statt labellos im
untriagierten Eingang liegenzubleiben (Owner-Entscheidung „Option A",
02.08.26). Weil `plan` ein Steuerlabel ist, taucht so ein Ticket **nicht** im
aggregierten Status-Issue unter „🏷️ Untriagiert" (#357) auf. Das ist seit
#588 die einzige Stelle, an der ein Lauf überhaupt noch ein Ticket anlegt.
Weiterhin gesperrt: fremde Tickets labeln oder untriagierte Fremdtickets
automatisch labeln.

**Im Fallback** (kein Ticket trägt `next`) nimmt der Runner nur Tickets mit
`ready`, die **nicht** `needs-answer` tragen — ein `plan`-Ticket trägt per
Definition kein `ready`, solange der Plan fehlt, und bleibt automatisch
liegen. **Trägt ein Ticket `next`**, ersetzt das die `ready`-Freigabe (siehe
„Die Queue: das Label `next`" in `docs/workflow/queue.md`). So entscheidest
**du** in jedem Fall, was gebaut wird, auch wenn zwanzig Tickets im Backlog
liegen — per Label.

**Zwei Arten des Wartens (#145).** Nicht jedes „warten" ist gleich:

- **Wartet auf einen Menschen** (`needs-answer`): kann Minuten bis Tage dauern.
  Es steht eine echte Frage im Ticket, die eine geschriebene Antwort braucht.
  Das Ticket **behält** `in-progress`, wird von der Auswahl aber übersprungen —
  der Runner baut in der Zwischenzeit etwas anderes. Nimmst du das Label ab,
  läuft es weiter, ohne dass irgendetwas umgelabelt werden muss.
- **Wartet auf die Zeit** (`blocked-limit` = Opus-Tagesdeckel, läuft morgen
  weiter; sowie — sobald gebaut — CI-Wartezeit, Minuten): löst sich von selbst.
  Das Ticket bleibt `in-progress`, der Runner fängt nichts Neues an, weil es
  ohnehin gleich weitergeht. Das **Session-/Token-Kontingent** (429) gehört seit
  #891 **nicht** mehr hierher: es ist ein Zustand der Flotte, nicht des Tickets,
  trägt **kein** Label und wird allein über das geteilte `limit-until` gesteuert
  — der Flotten-Header trägt die Pause (`Kontingent leer bis HH:MM`).

Beide behalten `in-progress`; der Unterschied liegt allein im Wartelabel. Genau
das ist seit #272 der Punkt: nicht ein zweites Zustandslabel entscheidet, ob ein
Bauplatz belegt ist, sondern die Frage, ob jemand auf einen Menschen wartet.
