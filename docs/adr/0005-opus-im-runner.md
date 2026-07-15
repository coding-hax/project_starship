# ADR-0005: Opus im Runner — erlaubte Ausnahmen und Grenzen

Status: **angenommen** · Datum: 2026-07-16

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
3. **Eskalation** nach drei erfolglosen Bau-Versuchen (#34).

**Bauen bleibt immer Sonnet/Haiku.** Opus schreibt in keiner dieser Rollen
Produktionscode.

## Grenzen

- **Budget-Deckel:** maximal 2 Opus-Läufe pro Denk-Ticket pro Kalendertag. Wird der
  Deckel erreicht, bevor der Plan fertig ist, kommentiert der Runner den Stand und
  setzt `needs-input` statt eines weiteren Opus-Laufs.
- **Kill-Switch:** Label `no-opus` am Ticket unterbindet jede Opus-Nutzung —
  der Planer überspringt das Ticket vollständig, weder Planung noch Bau durch Opus.
- **Strikt nur-lesend:** Opus läuft mit `--allowedTools "Read,Grep,Glob,Bash"`, ohne
  `Edit`/`Write`. Bash ausschließlich für `gh` und lesende Inspektion.
- **Kein Branch, kein Commit:** Der Planer legt keinen Branch an und committet nicht.
- **Read-only-Netz:** Bleibt der Arbeitsbaum nach einem Planer-Lauf trotzdem
  schmutzig (`git status --porcelain` nicht leer), verwirft der Runner die Änderungen
  und behandelt den Lauf als Fehler — das darf nie unbemerkt durchrutschen.

## Konsequenzen

- `CLAUDE.md` (Abschnitt „Autonomer Betrieb") und `docs/TOKEN-BUDGET.md` verweisen
  auf diese ADR. Die harte Regel „Opus tabu im Runner" wird zu „Opus tabu im Runner
  **außer** in den drei hier genannten Denk-Rollen, siehe ADR-0005".
- `docs/WORKFLOW.md` beschreibt die Automatik: ein `needs-plan`-Ticket wird vom
  Runner mit Opus (nur lesend) geplant und danach auf `ready` geflippt; bricht der
  Planer-Lauf ab, bleiben Label, Teilplan und Wiederaufnahme-Marker stehen — der
  nächste Lauf setzt am Marker fort, nie von vorne.
- `scripts/claude-runner.sh` bekommt eine zweite Rolle (`RUN_ROLE=plan` neben
  `RUN_ROLE=build`) mit eigenem Prompt, eigenen `--allowedTools` und dem
  Budget-Zähler unter `.runner/opus-<datum>-<issue>`.
