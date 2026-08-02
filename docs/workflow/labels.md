# Labels — sie steuern den Runner

Der Runner (`scripts/claude-runner.sh`) liest ausschließlich Labels. Sie sind die
Zustandsmaschine des ganzen Setups:

| Label            | Bedeutung                                                      | Wer setzt es |
| ---------------- | -------------------------------------------------------------- | ------------ |
| `research` | Grobe Idee, noch kein Ticket — Opus recherchiert den Fit, dann `needs-answer`. | **Du**       |
| `plan`     | Ticket erfasst, aber noch nicht baubereit — Opus plant im Chat. | **Du** oder Runner (beim Auslagern eines Fund-Tickets) |
| `ready`          | Von dir freigegeben. Claude darf das Ticket nehmen.            | **Du**; der Planer-Lauf am Ende eines Fund-Ticket-Durchlaufs (#397) |
| `in-progress`    | Claude arbeitet daran. Es gibt immer höchstens eins.           | Runner       |
| `needs-answer`    | **Wartet auf dich: Antwort oder Freigabe.** Das mechanische Tor — schließt das Ticket aus der Queue aus und parkt es. | Claude / Runner |
| `hands-off`      | **Der Runner fasst das Ticket nicht an — auf keinem Zweig.** Auch nicht, wenn es in der Queue steht oder `ready` trägt. Für alles, woran gerade von Hand gearbeitet wird. | **Du**       |
| `blocked-limit`  | Usage-Limit erreicht. Wird automatisch fortgesetzt.            | Runner       |
| `blocked-by`     | Wartet auf ein anderes Ticket — die Abhängigkeit steht in der Queue (`- #266 nach #227`). Setzt und entfernt der **Runner** selbst; von Hand angefasst richtest du nur Schaden an. | Runner       |
| `model:haiku` `model:sonnet` `model:opus` | **Startstufe** für dieses Ticket (ADR-0013). Höchstens eins setzen. `model:opus` baut sofort auf Opus, ohne die drei erfolglosen Läufe. Bei `plan`/`research` schlägt das Label die Rolle. | **Du**       |
| `no-escalation`  | Kill-Switch: der Runner schaltet nie selbst hoch. Es gilt die Startstufe aus dem Label (ohne Label: Sonnet). | **Du**       |
| `opus-boost`     | Hebt den Opus-Tagesdeckel für dieses eine Ticket auf (Zähler läuft weiter), Kill-Switch `no-escalation` gewinnt. Wird von einem Opus-Bau-Lauf ohne Fortschritt wieder abgezogen. | **Du**       |
| `tests-exempt`   | Testlose Änderung (Refactor/Typen) nachweislich gerechtfertigt oder ein toter Zweig samt Tests wird bewusst entfernt — hebt Anwesenheits-Gate **und** Testanzahl-Gate in `check-test-integrity.sh` für diesen PR auf (issue #303). | **Du**       |
| `bug` `epic`     | Reine Sortier-Labels — sie steuern den Runner nicht. `epic` markiert zusammenhängende Tickets und hat **keine** Wirkung auf die Auswahl. | **Du**       |

Der Bau fordert `tests-exempt` per Kommentar an (Selbst-Ausnahme wäre derselbe
Interessenkonflikt wie bei Tests); der Planer benennt im Plan, welche Änderung
testlos gerechtfertigt ist, du setzt das Label.

**Ein beim Auslagern eines Fund-Tickets angelegtes Ticket** (z. B. #349/#351,
während #325 gefunden) trägt seit #397 im selben Schritt **`plan`** — nie
`ready`. Das Fund-Ticket läuft damit ohne menschliches Zutun durch: Fund →
`plan` → Opus plant → `ready` (gesetzt vom Planer-Lauf am Ende) → gebaut. Das
`ready`-Gate greift für diesen Weg nicht mehr — Selbstheilung bei roten Tests
schlägt hier bewusst die Freigabekontrolle (Owner-Entscheidung, 30.07.26).
Weil `plan` ein Steuerlabel ist, taucht das Ticket **nicht** im aggregierten
Status-Issue unter „🏷️ Untriagiert" (#357) auf. Weiterhin gesperrt: fremde
Tickets labeln, die Queue #92 umschreiben (#265) oder untriagierte
Fremdtickets automatisch labeln. Titelform und Pflichtsuche vor dem Anlegen:
„Fundschlüssel & Pflichtsuche" in `docs/workflow/fundschluessel.md`.

Seit #439 gilt dieselbe Regel für **vom Planer beim Aufteilen eines Tickets
angelegte Kinder-Tickets** (z. B. wenn der Plan das Ticket in T1/T2/T3
zerlegt): auch sie tragen im selben Schritt `plan` und laufen denselben Weg
`plan` → Opus plant → `ready` → gebaut, statt labellos im untriagierten
Eingang liegenzubleiben (Owner-Entscheidung „Option A", 02.08.26).

**Im Fallback** (leeres/fehlendes Queue-Issue oder Ticket nicht gelistet) nimmt
der Runner nur Tickets mit `ready`, die **nicht** `needs-answer` tragen — ein
`plan`-Ticket trägt per Definition kein `ready`, solange der Plan fehlt,
und bleibt automatisch liegen. **Ist das Ticket gelistet**, ersetzt das die
`ready`-Freigabe (siehe „Die Prioritäts-Queue" in `docs/workflow/queue.md`). So
entscheidest **du** in
jedem Fall, was gebaut wird, auch wenn zwanzig Tickets im Backlog liegen —
per Queue-Editor oder per Label.

**Zwei Arten des Wartens (#145).** Nicht jedes „warten" ist gleich:

- **Wartet auf einen Menschen** (`needs-answer`): kann Minuten bis Tage dauern.
  Es steht eine echte Frage im Ticket, die eine geschriebene Antwort braucht.
  Das Ticket **behält** `in-progress`, wird von der Auswahl aber übersprungen —
  der Runner baut in der Zwischenzeit etwas anderes. Nimmst du das Label ab,
  läuft es weiter, ohne dass irgendetwas umgelabelt werden muss.
- **Wartet auf die Zeit** (`blocked-limit`, und — sobald gebaut — CI-Wartezeit):
  löst sich von selbst in Minuten. Das Ticket bleibt `in-progress` **ohne**
  Wartelabel, der Runner fängt nichts Neues an, weil es ohnehin gleich
  weitergeht.

Beide behalten `in-progress`; der Unterschied liegt allein im Wartelabel. Genau
das ist seit #272 der Punkt: nicht ein zweites Zustandslabel entscheidet, ob ein
Bauplatz belegt ist, sondern die Frage, ob jemand auf einen Menschen wartet.
