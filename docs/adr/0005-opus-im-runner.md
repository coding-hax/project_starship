# ADR-0005: Opus im Runner — erlaubte Ausnahmen und Grenzen

Status: **angenommen**, Eskalations-Rolle teilweise ersetzt durch ADR-0007 · Datum: 2026-07-16

Ergänzt um [ADR-0024](0024-denk-laeufe-artifact.md): beide Denk-Rollen dürfen
seit #767 zusätzlich `Artifact` benutzen, ohne dass die Read-only-Zusage unten
fällt — `Artifact` publiziert direkt nach außen, ohne vorher lokal zu
schreiben.

## Kontext

`CLAUDE.md` und `docs/TOKEN-BUDGET.md` verbieten Opus im Runner als harte Regel:
„Niemals für Implementierung, niemals für Suchen, niemals im Runner." Der Grund ist
Token-Disziplin — Opus mit Effort „high" ist die teuerste Kombination, die es gibt.

Reines **Bauen** bleibt davon unberührt: Sonnet/Haiku erledigen das ohne spürbaren
Qualitätsverlust. Aber **Denken** — Planung komplexer, architektonischer Tickets
(mehrdeutig, geschützte Pfade, Migrationen, Krypto, Sync) — braucht Opus-Qualität.
Sonst plant ein schwächeres Modell die Arbeit für ein schwächeres Modell, und
Architektur-Entscheidungen an geschützten Pfaden (`src/db/`, `src/crypto/`,
`src/local/`, `src/app/api/sync/`, Auth, `.github/`, `scripts/`) entstehen ungeplant.

## Entscheidung

Opus ist im Runner ausschließlich in **drei nur-lesenden Denk-Rollen** erlaubt:

1. **Planung** (`plan` → `ready`, dieses Ticket, #42).
2. **Feature-Recherche** (`research`, Folge-Ticket #43).
3. **Eskalation** nach drei erfolglosen Bau-Versuchen (#34) — **teilweise
   ersetzt durch ADR-0007**: dort baut Opus als letzte Eskalationsstufe
   tatsächlich, mit eigenem Deckel und eigenen Grenzen. Die Details stehen in
   ADR-0007, nicht hier.

**Bauen bleibt immer Sonnet/Haiku** — außer in der Eskalations-Rolle aus
ADR-0007. Opus schreibt in Planung und Feature-Recherche keinen
Produktionscode.

## Grenzen

- **Kein künstlicher Tages-Deckel fürs Denken:** Planung und Recherche laufen so oft,
  wie sie brauchen. Ein komplexer Plan kann mehrere Opus-Läufe kosten, und ihn nach
  einer festen Zahl für einen Tag zu parken widerspräche dem Ziel unbeaufsichtigten
  Fortschritts. Die Obergrenze ist das echte Nutzungs-/Session-Limit des Plans
  (429 → geteiltes `limit-until`, **kein** Label, automatische Fortsetzung; der
  Flotten-Header trägt die Pause `Kontingent leer bis HH:MM`, #891), nicht ein
  fester Zähler. `blocked-limit` bleibt allein dem Opus-Tagesdeckel.
- **Kill-Switch:** Label `hands-off` am Ticket unterbindet jede Opus-Nutzung —
  der Planer überspringt das Ticket vollständig, weder Planung noch Bau durch Opus.
- **Strikt nur-lesend, präventiv erzwungen (#63):** Opus läuft mit
  `--allowedTools "Read,Grep,Glob,Bash(gh:*),Bash(git log:*),Bash(git diff:*),Bash(git show:*)"`
  (Recherche zusätzlich `WebSearch`), ohne `Edit`/`Write` und **ohne pauschales
  `Bash`**. Erlaubt ist nur, was der Auftrag braucht: `gh` für Issue lesen,
  Kommentar posten, Label setzen — sowie lesende `git`-Inspektion. Alles andere
  (`git commit`, `git push`, beliebige Shell-Befehle, …) weist Claude Code selbst
  ab, bevor es läuft — nicht erst hinterher per Kontrolle.
- **Kein Branch, kein Commit:** Der Planer legt keinen Branch an und committet nicht.
- **Read-only-Netz als zweite Absicherung, nicht als einzige:** Bleibt der
  Arbeitsbaum nach einem Planer-Lauf trotzdem schmutzig (`git status --porcelain`
  nicht leer), verwirft der Runner die Änderungen und behandelt den Lauf als
  Fehler — das darf nie unbemerkt durchrutschen. Vor #63 war das die einzige
  Absicherung (detektivisch, nach dem Lauf); jetzt ist es Netz und doppelter
  Boden hinter der präventiven Allowlist.

## Konsequenzen

- `CLAUDE.md` (Abschnitt „Autonomer Betrieb") und `docs/TOKEN-BUDGET.md` verweisen
  auf diese ADR. Die harte Regel „Opus tabu im Runner" wird zu „Opus tabu im Runner
  **außer** in den drei hier genannten Denk-Rollen, siehe ADR-0005".
- `docs/WORKFLOW.md` beschreibt die Automatik: ein `plan`-Ticket wird vom
  Runner mit Opus (nur lesend) geplant und danach auf `ready` geflippt; bricht der
  Planer-Lauf ab, bleiben Label, Teilplan und Wiederaufnahme-Marker stehen — der
  nächste Lauf setzt am Marker fort, nie von vorne.
- `scripts/claude-runner.sh` bekommt eine zweite Rolle (`RUN_ROLE=plan` neben
  `RUN_ROLE=build`) mit eigenem Prompt und eigenen `--allowedTools`. Einen festen
  Budget-Zähler gibt es bewusst nicht (siehe „Grenzen").
- `scripts/tests/` prüft, dass `RUN_ROLE=plan`/`RUN_ROLE=research` nicht mit
  einem pauschalen `Bash` starten (#63).

---

## Nachtrag 27.07.2026 — nur Bezeichner, keine Entscheidung

Im Zuge von #225 (S2a von #264) wurden drei Labels umbenannt. Die
Entscheidungen dieses ADR bleiben unverändert; es ändert sich ausschließlich,
wie die Schalter heißen:

| bis 27.07.2026 | ab jetzt | warum |
| --- | --- | --- |
| `no-opus` | `hands-off` | der Name klang nach Modellwahl, ist aber der Finger-weg-Schalter: der Runner fasst das Ticket auf keinem Zweig an |
| `needs-plan` | `plan` | eine Rolle für den Runner, keine Bitte an den Menschen. `needs-` trägt ab jetzt nur noch ein Label, das etwas von einem Menschen will |
| `needs-research` | `research` | dito |

Ältere Kommentare, Tickets und Läufe nennen weiterhin die alten Namen.

## Nachtrag 27.07.2026 — die Stufe ist am Ticket wählbar

[ADR-0013](0013-modellstufe-am-ticket.md) ergänzt die Labels `model:haiku`,
`model:sonnet` und `model:opus` als **Startstufe**. Damit kann ein Mensch ein
Ticket bewusst auf Opus setzen, ohne die drei erfolglosen Läufe aus ADR-0007
abzuwarten — und eine Denk-Rolle umgekehrt auf Sonnet herunterziehen.

Der Kern dieses ADR bleibt: der **Runner** schaltet nie von sich aus auf Opus
hoch, außer über die Eskalation. Was sich ändert, ist nur, dass der Mensch die
Stufe vorgeben darf.

## Nachtrag 29.07.2026 — Read-only-Netz wird Tripwire, Isolation über Wegwerf-Worktree (#325)

Der Abschnitt „Read-only-Netz als zweite Absicherung" oben beschrieb ein
detektivisches Netz, das den Arbeitsbaum nach dem Lauf gegen *leer* verglich
und bei jedem Fund den gesamten Haupt-Checkout mit `git checkout -- .` +
`git clean -fd` zurücksetzte. Zwei Mängel zeigten sich in der Praxis
(#301, #322, #326-Umfeld):

- **Der Vergleich gegen leer trifft auch fremden, schon vorher vorhandenen
  Dirt** (z. B. gestagte Arbeit eines parallelen Bau-Laufs im selben Slot-
  Checkout) — jeder Lese-Lauf in einem ohnehin schmutzigen Slot war verurteilt,
  fälschlich als Regelverstoß zu enden.
- **Der Index wurde vom Aufräumen nie erreicht:** `checkout -- .` stellt den
  Arbeitsbaum aus dem Index wieder her, `clean -fd` fasst nur unversionierte
  Dateien an — gestagte Änderungen (`git status --porcelain`, Spalte 1)
  überleben beide unangetastet. Ein Slot mit schmutzigem Index konnte das Netz
  damit *nie* auflösen, ein selbsterhaltender Fehlalarm-Kreislauf.

**Entscheidung:** Lese-Rollen (`plan`/`research`) laufen jetzt wie Bau-Läufe
in einem eigenen Worktree — einem **Wegwerf**-Worktree (`readonly_worktree()`
in `scripts/claude-runner.sh`), frisch ab `origin/main` angelegt und direkt
nach dem Lauf wieder entfernt, nie wiederverwendet. Das löst nebenbei auch
einen veralteten oder auf der falschen Branch stehenden Haupt-Checkout, den
ein Lese-Lauf sonst gelesen hätte. Der geteilte Haupt-Checkout wird damit von
**keiner** Rolle mehr verändert — AK1 gilt *by construction*, nicht mehr nur
über ein Aufräum-Netz danach.

Das alte pauschale `checkout -- .` + `clean -fd` entfällt. An seine Stelle
tritt ein reiner **Tripwire**: `roundPlan()` merkt sich vor dem Lauf einen
`git status --porcelain`-Schnappschuss (`beforeDirty`, enthält den Index),
`roundEval()` vergleicht danach nur die **neuen** Zeilen gegen diesen
Schnappschuss. Nur bei neuen Zeilen wird der Lauf angeklagt (Kommentar,
`needs-answer`) — **ohne** etwas zurückzusetzen, weder Arbeitsbaum noch Index.
Das Wegwerfen des Worktrees ist die Bereinigung; das Netz meldet nur noch.

Zusätzlich (O3): Lese-Rollen bekommen `--disallowedTools "Edit,Write"` als
harte Zusatzgrenze neben der bestehenden Allowlist (`READONLY_DENY` in
`scripts/runner/prompts.ts`).

## Nachtrag 04.08.2026 — doch ein Tages-Deckel, aber nur für die Summe (#492)

Der Abschnitt „Grenzen" oben sagte bewusst „Kein künstlicher Tages-Deckel
fürs Denken" — Planung und Recherche sollten so oft laufen, wie sie brauchen.
Der Deep Review vom 02.08.26 (Finding F18, #492) zeigte die Lücke, die das
offen ließ: kein bestehender Deckel begrenzt die **Summe** der Denk-Rollen-
Läufe über alle Tickets hinweg. Drei Slots, 120-Sekunden-Takt, ein einzelnes
versehentlich `plan`-markiertes Ticket, das nach jedem Lauf wieder eingeplant
wird — das verbrennt ein ganzes Tageskontingent, ohne dass der (ticket- und
opus-spezifische) Bau-Deckel aus ADR-0007 je greift, weil der für die
Denk-Rollen gar nicht zuständig ist.

**Owner-Entscheidung 03.08.26 (Option C von dreien):** nur die Denk-Rollen
deckeln, Bau-Läufe bleiben unbegrenzt — die hängen an Tickets und begrenzen
sich dadurch schon selbst (ADR-0007). Verworfen wurden „so lassen" (die
Lücke bleibt offen) und „alle Läufe je Tag deckeln" (träfe auch das Bauen,
das gar nicht die Quelle des Problems ist).

**Umsetzung:** ein flottenweiter, ticketübergreifender Zähler unter
`SHARED_DIR` (`thinking-cap-<datum>` in `scripts/runner/cap.ts`,
`thinkingCapReached`/`thinkingCapReserve`) — bewusst **ein** gemeinsamer
Zähler für `plan` **und** `research`, kein `-${issue}`-Suffix wie beim
Opus-Bau-Deckel, weil genau die Summe über alle Tickets die Lücke war. Der
Deckel greift unabhängig vom aufgelösten Modell (auch bei `model:sonnet` auf
einem `plan`-Ticket) — die Rolle selbst ist die Kostenquelle, nicht nur
Opus darin. Voraussetzung war #484 (Zähler flottenweit statt slot-lokal),
sonst hätte der Deckel dieselbe Lücke gehabt wie der Opus-Bau-Deckel vor
#484. Schwelle: 20 Läufe/Tag, gewählt als grober, aber wirksamer Rundwert
weit über dem normalen Planungs-/Recherche-Durchsatz — reine Kostenbremse,
bei Bedarf per Folge-Ticket nachjustierbar. Ist der Deckel erreicht, endet
die Runde für dieses Ticket mit 🟡 und dem Hinweis, dass morgen automatisch
weiterläuft — kein `needs-answer`, analog zum Opus-Bau-Deckel aus ADR-0007
(#272: Wartend auf Zeit ist kein Wartelabel).
