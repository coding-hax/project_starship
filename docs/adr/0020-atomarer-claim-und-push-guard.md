# ADR-0020: Atomarer Claim und Push-Guard

Status: angenommen
Datum: 2026-08-02
Bezug: #449, #430 (Vorfall), ADR-0014

## Kontext

Zwei Slots haben #430 gleichzeitig gebaut, obwohl der `mkdir`-Claim aus
ADR-0014 genau das verhindern soll. Die Mechanik war da (`claim.ts`,
`claimedElsewhere()` in `select.ts`/`round.ts`) — getroffen wurde ein Fenster,
das ADR-0014 selbst als bewusst gekauften Preis benennt: „im Zweifel frei".

`claimTake()` legte einen Claim bislang in **zwei** Schritten an: `mkdir`
(leeres Verzeichnis) + `writeSlot` (Inhalt). Fiel eine gleichzeitige
`readSlot()` eines anderen Slots zwischen beide, sah sie ein leeres
Verzeichnis → galt als frei → ein zweiter Slot schrieb seine eigene ID hinein,
und `claimTake()` gab bei **beiden** Aufrufen `true` zurück.

## Entscheidung

### Atomarer Claim-mit-Besitzer statt `mkdir` + `writeFile`

`claimAtomic(issue, slotId)` legt ein Temp-Verzeichnis mit bereits befüllter
`slot`-Datei an und hebt es per `renameSync` in einem Schritt an den finalen
Pfad. `rename` auf ein **nicht-leeres** Zielverzeichnis scheitert atomar
(POSIX `ENOTEMPTY`) → genau ein Gewinner, nie ein leerer Zwischenzustand. Ein
**leeres** Altverzeichnis (Legacy-`mkdir` oder ein zwischen Anlage und
`rename` abgebrochener Lauf) wird ersetzt → bleibt wiedergewinnbar,
**Verklemmungsfreiheit aus ADR-0014 bleibt erhalten**.

`claimTake()` versucht zuerst `claimAtomic()`; scheitert das, prüft es nur
noch, ob der bestehende Claim bereits diesem Slot gehört (Fortsetzung).
`take()`/`writeSlot()` entfallen ersatzlos — nichts außerhalb von `claim.ts`
nutzte sie direkt.

**Verhaltensänderung, kein Rückschritt:** ein Claim-Verzeichnis, das bereits
Inhalt trägt (auch eine leere `slot`-Datei), ist für `rename` nicht-leer und
damit nicht mehr stehlbar — das war exakt das Mikro-Loch. Ein komplett
**leeres** Verzeichnis (Absturz zwischen `mkdir` und dem Schreiben) bleibt wie
zuvor übernehmbar; sonst wäre ein Ticket nach einem Absturz für immer tot.

**Kein Reorder in `round.ts`/`select.ts`.** Erwogen wurde, `claimTake()` vor
die `in-progress`-Label-Mutation in `pickTicket()` zu ziehen. Verworfen: der
atomare Claim macht `claimTake()` bereits zum alleinigen verlässlichen Tor —
verliert ein Slot dort, startet er gar keinen Bau-Lauf, unabhängig davon, ob
er vorher das Label gesetzt hat. Der Reorder hätte keinen
Korrektheitsgewinn gebracht, aber `pickTicket()` in sensiblem Code
zerschnitten.

### Push-Guard als zweite Verteidigungslinie

`scripts/git-hooks/pre-push` (POSIX `sh`, fail-open): bricht einen Push nur
ab, wenn der Claim des Tickets aus dem Branchnamen (`feat/<n>-…` etc.)
nachweislich einem **anderen** Slot gehört. Fehlt Branch, Ticketnummer,
`SHARED_DIR`/`SLOT_ID` oder die Claim-Datei, geht der Push durch — legitime
Runner-Catch-up-Pushes und Menschen-Pushes scheitern nie fälschlich.

Verdrahtet über `git config core.hooksPath` in `bootstrap_worktree()`
(`claude-runner.sh`), absoluter Pfad **in den Worktree** — die eingecheckte
Hook-Datei ist damit auf jedem Branch vorhanden, unabhängig vom
Haupt-Checkout. Nur für Bau-Worktrees (`ensure_worktree()`), nicht für
`readonly_worktree()` — Lese-Rollen pushen nie.

### `.tmp-*`-Reste

Ein zwischen Temp-Anlage und `rename` abgebrochener Lauf hinterlässt ein
`.tmp-*`-Verzeichnis unter `SHARED_DIR/claims/` — harmlos (kein Integer-Name,
für `list()`/Auswahl unsichtbar), aber ein Ansammlungsrisiko über viele
Abstürze. `claimSweep()` räumt `.tmp-*`-Reste älter als die bestehende
Schonfrist (`SWEEP_GRACE_MS`) mit weg.

## Verworfen — bitte nicht erneut vorschlagen

- **Zweistufiger `mkdir` mit Zeit-Schonfrist** (leeres Claim-Verzeichnis
  jünger als N Sekunden gilt als belegt statt frei). Dreht ADR-0014s
  Kernabwägung „im Zweifel frei" tatsächlich um — ein Absturz zwischen
  `mkdir` und dem Schreiben blockiert das Ticket dann für N Sekunden. Der
  atomare Claim schließt dasselbe Loch, ohne die Abwägung neu zu verhandeln:
  sie bleibt gegenstandslos, weil nie ein leerer, aber schon „reservierter"
  Zwischenzustand existiert.
- **Reorder: `claimTake()` vor die Label-Mutation in `pickTicket()`.** Kein
  Korrektheitsgewinn (Begründung oben), aber Risiko in `round.ts`/`select.ts`.
- **Nachgelagerter (weicher) Push-Guard in `roundEval`.** Der Push wäre dann
  schon passiert — man könnte nur noch Auto-Merge verweigern. Erfüllt die
  Anforderung „bricht ab, statt zu pushen" nicht wörtlich; der Pre-push-Hook
  kostet dafür etwas mehr Infrastruktur (`core.hooksPath`-Verdrahtung), bleibt
  aber die einzige Stelle, die tatsächlich abbricht.

## Nicht-Ziele

Keine Rekonstruktion der genauen Fenstergröße beim #430-Vorfall (der
Laufzeitzustand lag außerhalb des Repos, dafür fehlt eine Quelle). Keine
Änderung an `readSlot`/`ageMs`/`list`/`release`/`claimFilter`/
`claimedElsewhere`/`claimSweep`s Kernlogik — das Claim-Verzeichnis-Layout
bleibt identisch, `cleanup.ts` und `round.ts` bleiben unverändert.
