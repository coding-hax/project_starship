# ADR-0005: Opus im Runner — erlaubte Ausnahmen und Grenzen

Status: **angenommen**, Eskalations-Rolle teilweise ersetzt durch ADR-0007 · Datum: 2026-07-16

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

1. **Planung** (`needs-plan` → `ready`, dieses Ticket, #42).
2. **Feature-Recherche** (`needs-research`, Folge-Ticket #43).
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
  (429 → `blocked-limit`, automatische Fortsetzung), nicht ein fester Zähler.
- **Kill-Switch:** Label `no-opus` am Ticket unterbindet jede Opus-Nutzung —
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
- `docs/WORKFLOW.md` beschreibt die Automatik: ein `needs-plan`-Ticket wird vom
  Runner mit Opus (nur lesend) geplant und danach auf `ready` geflippt; bricht der
  Planer-Lauf ab, bleiben Label, Teilplan und Wiederaufnahme-Marker stehen — der
  nächste Lauf setzt am Marker fort, nie von vorne.
- `scripts/claude-runner.sh` bekommt eine zweite Rolle (`RUN_ROLE=plan` neben
  `RUN_ROLE=build`) mit eigenem Prompt und eigenen `--allowedTools`. Einen festen
  Budget-Zähler gibt es bewusst nicht (siehe „Grenzen").
- `scripts/tests/` prüft, dass `RUN_ROLE=plan`/`RUN_ROLE=research` nicht mit
  einem pauschalen `Bash` starten (#63).
