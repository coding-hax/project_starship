# ADR-0007: Opus-Eskalation — Opus baut, wenn Sonnet/Haiku dreimal steckenbleiben

Status: **angenommen** · Datum: 2026-07-16

## Kontext

ADR-0005 erlaubt Opus im Runner in drei nur-lesenden Denk-Rollen, darunter
„Eskalation nach drei erfolglosen Bau-Versuchen" (#34) — dort noch als reine
Denkrolle skizziert, analog zu Planung und Feature-Recherche. Bei der Umsetzung
von #34 hat sich der Mensch (nicht Sonnet) bewusst für mehr entschieden:
Bleibt ein Ticket auf `sonnet` dreimal ohne Fortschritt stecken, soll Opus als
letzte Stufe nicht nur mitdenken, sondern selbst **bauen** dürfen — Code
schreiben, committen, einen PR öffnen. Das ist die einzige Stelle im Repo, an
der Opus produktiv schreibt.

Diese ADR ersetzt damit für die Eskalations-Rolle explizit die Aussage aus
ADR-0005 „Bauen bleibt immer Sonnet/Haiku" und die Einordnung der Eskalation
als „nur-lesende Denk-Rolle". Planung und Feature-Recherche aus ADR-0005
bleiben unverändert strikt nur-lesend.

## Entscheidung

Modell-Stufen für die Bau-Rolle (`RUN_ROLE=build`): `sonnet` (Standard-Start,
bzw. `haiku` bei Label `model:haiku`) → `opus` (letzte Stufe, baut).

- **Hochstufen:** Drei aufeinanderfolgende Läufe „kein Fortschritt" auf der
  aktuellen Stufe schalten eine Stufe hoch. Steckt Opus als höchste Stufe
  ebenfalls dreimal ohne Fortschritt fest: Stop, Label `needs-input`,
  Blocker-Kommentar am Ticket.
- **„Kein Fortschritt"** = kein neuer Commit auf dem Feature-Branch (Vergleich
  der Branch-Spitze auf `origin` vor/nach dem Lauf) **und** dieselbe
  Blocker-Signatur wie im Vorlauf (siehe #33: Endgrund + Testname/Kernursache
  aus dem Fortschrittskommentar). Ein durch Limit oder die Notbremse
  unterbrochener Lauf zählt **nicht** als Fehlversuch — die Wand hat sich dort
  nicht bewegt, weil gar nicht zu Ende gearbeitet wurde.
- **Erfolg setzt zurück:** Bewegt sich die Branch-Spitze (oder gibt es
  Fortschritt am PR), fällt die Stufe wieder auf den Standard, Fehlversuchs-
  und Opus-Zähler werden gelöscht.
- **Opus-Deckel:** höchstens **2** Opus-Bau-Läufe pro Ticket und Kalendertag
  (eigener Zähler, unabhängig vom Planer-Zähler — für die Bau-Rolle gibt es
  bewusst **keine** Ausnahme wie in ADR-0005/PR #46 für Planung/Recherche,
  weil Opus hier tatsächlich schreibt statt nur zu lesen). Überschreitung:
  sofort `needs-input`, kein weiterer Opus-Bau-Versuch an diesem Tag.
- **Kill-Switch:** Label `no-escalation` friert ein Ticket auf der
  Standard-Stufe ein — es wird nie hochgeschaltet, unabhängig vom
  Fehlversuchs-Zähler.

## Grenzen

- Opus läuft in der Eskalations-Rolle mit `RUN_ROLE=build` und den vollen
  Bau-`--allowedTools` (`Read,Edit,Write,Glob,Grep,Bash`) — **ohne** das
  Read-only-Netz aus ADR-0005, das ausschließlich für `RUN_ROLE=plan` greift.
  Opus darf hier also tatsächlich Dateien ändern, committen und pushen.
- Damit ein unbeaufsichtigt schreibender Opus-Lauf trotzdem nie ungeprüft in
  `main` landet, bleiben die bestehenden Wächter unverändert scharf:
  `protected-paths` (hält jeden PR an `scripts/`, `.github/`, `src/db/` etc.
  offen, bis der Mensch `human-approved` setzt) und `test-integrity`
  (verhindert abgeschwächte Tests). Opus-Code entsteht ungeprüft, wird aber
  nie ungeprüft gemerged.
- Der Opus-Deckel ist eine reine Kostenbremse, keine Sicherheitsgrenze — die
  Sicherheitsgrenze sind die beiden Wächter oben.

## Konsequenzen

- ADR-0005: Eskalations-Bullet verweist auf diese ADR statt sie selbst zu
  beschreiben; die Aussage „Bauen bleibt immer Sonnet/Haiku" gilt nur noch
  außerhalb der Eskalations-Rolle.
- `CLAUDE.md` und `docs/TOKEN-BUDGET.md`: Wortlaut „Opus tabu im Runner"
  bekommt die Bau-Ausnahme der Eskalations-Rolle (max. 2 Läufe/Ticket/Tag,
  Kill-Switch `no-escalation`) ergänzt.
- `docs/WORKFLOW.md`: Label-Tabelle bekommt `no-escalation`; die
  Eskalations-Zustandsmaschine (Stufen, Zähler, Deckel) wird kurz beschrieben.
- `scripts/claude-runner.sh` bekommt Tier-Zustand (`tier-<nr>`,
  `failcount-<nr>`), Fortschritts-/Fehlschlag-Erkennung und den Opus-Bau-Deckel
  (`opus-<datum>-<nr>`), alles dateibasiert unter `.runner/`.
