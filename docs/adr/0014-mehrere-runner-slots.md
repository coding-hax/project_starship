# ADR-0014: Mehrere Runner-Slots

Status: angenommen
Datum: 2026-07-28
Bezug: #204

## Kontext

Seit dem höheren Claude-Tarif ist das Kontingent nicht mehr der Engpass — der
**serielle Runner** ist es. Ein Lauf arbeitet genau ein Ticket zur Zeit
(WIP-Limit = 1, `docs/WORKFLOW.md`); bei 16 offenen Tickets, von denen real
3–4 gleichzeitig und unabhängig baubar sind, verschenkt das ungenutzte
Kapazität, die längst da ist.

Sechs Dinge im bestehenden Runner sind heute global genau einmal vorhanden,
und jedes davon reicht aus, um einen zweiten parallelen Lauf zu zerstören:
der Lauf-Lock, der eine Arbeitsbaum, die Ticketauswahl (kennt kein „wem gehört
das"), das eine Status-Issue, die globalen Wächter (würden mehrfach laufen)
und die Test-Infrastruktur (eine DB, feste Ports, ein Lock unter
`process.cwd()`). Details und Zeilenreferenzen: die Recherche in #204 selbst.

## Entscheidung

**Ein Slot = eine launchd-/systemd-Instanz + ein eigener vollständiger Clone +
ein eigenes `.runner/`.** `SLOT_ID` (1…`SLOT_COUNT`) ist die einzige
slotspezifische Variable — Ports und der Zustandsordner leiten sich
rechnerisch daraus ab. `SLOT_ID=1` (bzw. `SLOT_COUNT=1`) verhält sich exakt
wie vor diesem Ticket (AK9) — das ist der Rückweg für den Vollausbau:
zusätzliche plists entladen, zusätzliche Clones löschen.

`SLOT_COUNT` ist ein echter Parameter, harter Deckel **10** im Code
(Vertipper-Schutz, AK8), **Betriebswert 3**. Die Messung dieser Maschine (16
GB RAM, 6 Kerne, 93 % volle Platte) trägt 3–4 aktive Slots; wichtiger als die
Hardware ist aber, dass ein Merge nach `main` bei N Slots N−1 Nachzieh-Merges
plus N−1 volle CI-Läufe auslöst — bei N=10 verbringt die Flotte mehr Zeit mit
sich selbst als mit Arbeit. Real unabhängig baubar sind ohnehin nur 3–4
Tickets gleichzeitig (mehrere Ketten wie Garmin oder #184 sind sequenziell).

### Isolation: ein vollständiger Clone je Slot

Slot 1 bleibt der vorhandene Checkout. Slot 2…N: eigener Clone unter
`~/dev/starship-slot-<n>`, eigene `.env.local`, eigene Postgres-DB. Kein
geteiltes `.git`, kein Docker. Begründung: maximale Isolation, kein
gemeinsamer Ref-Zustand zwischen gleichzeitigen `fetch`/`merge`-Operationen,
Rückweg ist `rm -rf`. `git worktree` hätte Platz gespart, aber `.git` geteilt
— zwei Slots mit gleichzeitigen `fetch`/`merge` auf denselben Refs sind genau
das Risiko, das dieses Ticket beseitigen soll, nicht vermehren.

### Ticket-Anspruch: atomarer `mkdir`-Claim

_Verfeinert durch ADR-0020 (#449): der zweistufige `mkdir` + `writeFile` unten
öffnete ein Fenster, in dem ein Claim kurz leer und damit für einen zweiten
Slot als frei sichtbar war (Vorfall #430). ADR-0020 ersetzt beide Schritte
durch eine einzige atomare `rename`-Operation mit Besitzer-Inhalt; diese
Sektion beschreibt weiterhin den historischen Stand._

`SHARED_DIR/claims/<issue>/` (`SHARED_DIR` liegt außerhalb jedes
Arbeitsbaums, Default `~/.starship-runner`) — dieselbe Technik wie der
bestehende Lauf-Lock, `mkdir` ist auf POSIX atomar. Ein Slot-Label am Issue
wäre nur Anzeige gewesen, nie die Entscheidung: GitHub-Labels kennen kein
Compare-and-Swap, bei 5-Minuten- oder gar 60-Sekunden-Takt ist das Rennen
real.

Der Claim verfällt am **Label** (`in-progress`), nie an einer PID — der
Runner-Prozess stirbt planmäßig nach jedem Tick, ein `in-progress`-Ticket
überlebt viele Ticks (wartet z. B. 20 Minuten auf CI). PID-Liveness gäbe
jeden Claim nach Minuten frei.

Umgesetzt in `scripts/runner/claim.ts`. Eine leere/fehlende `slot`-Datei gilt
als **frei**, nicht als fremd — sonst blockiert ein zwischen `mkdir` und dem
Schreiben abgebrochener Claim das Ticket für immer, ohne dass irgendwo etwas
rot wird. `claimSweep()` (nur Leitslot) räumt verwaiste Claims weg, überspringt
aber Claims unter der Schonfrist (`SWEEP_GRACE_MS`, abgeleitet von und bewusst
**über** der maximalen Laufzeit `MAX_RUNTIME_MS`, 50 statt 45 min) — so gerät
ein noch laufender Bau strukturell nie in den Sweep, selbst am oberen Ende
seiner Laufzeit. Freigegeben wird ein Claim außerdem nur bei einem **positiv
bestätigten** „geschlossen oder ohne Rollen-Label"; scheitert `gh` (Netz,
Rate-Limit), bleibt der Claim bestehen statt freigegeben zu werden — ein
Fehlschlag ist kein Beweis, dass das Ticket erledigt ist (#482).

**Ein Filter statt sechs Umbauten.** Die Ticketauswahl trifft in
`scripts/runner/select.ts` an sechs Stellen eine Entscheidung (laufendes
Ticket fortsetzen, Queue, Fallback plan/research/ready). Statt jede einzeln um
eine Claim-Prüfung zu erweitern, filtert `claimedElsewhere()` einmal, bevor
die Auswahl den Schnappschuss sieht — fremd beanspruchte Tickets sind für
diesen Slot dann schlicht nicht vorhanden, alle sechs Stellen bleiben
unangetastet.

**Fund während der Umsetzung, der beim Planen nicht auffiel:** ein simples
„fremde Tickets aus dem Snapshot werfen" hätte die Abhängigkeitsauflösung
verfälscht. `queueBlocked()` (Prioritäts-Queue, #265) bestimmt, ob ein
Blocker-Ticket noch offen ist, indem es prüft, ob dessen Nummer noch im
Snapshot der offenen Issues steht. Entfernte man ein von einem ANDEREN Slot
beanspruchtes Ticket komplett aus dem Snapshot, sähe ein davon abhängiges
Ticket seinen Blocker fälschlich als „nicht mehr offen — also erledigt" an
und würde vom falschen Slot verfrüht angefasst, während der andere Slot noch
daran baut. Deshalb bekommt `selectTicket()`/`pickTicket()` die
Ausschlussmenge als **zusätzlichen** Parameter, der `snapshot` selbst bleibt
für die Abhängigkeitsprüfung vollständig. Test dafür:
`select.test.ts`, „claimedElsewhere … ohne den Snapshot für Abhängigkeiten zu
verfälschen".

### Globale Wächter: nur der Leitslot

`reopenFalselyClosedIssues`, die CI-Wache für wartende Tickets
(`needs-answer`) und `claimSweep` laufen nur, wenn dieser Slot der
**effektive** Leitslot ist — sonst schreiben mehrere Slots denselben
Issue-Kommentar oder dieselbe Label-Mutation mehrfach. **Nicht** betroffen:
die CI-Wache für das **eigene** laufende Ticket — die gehört in jeden Slot,
sie betrifft ausschließlich das Ticket, das dieser Slot beansprucht hat. Diese
Unterscheidung ist der Kern des Umbaus; sie zu verwechseln bedeutet entweder
einen blinden Slot oder doppelte Merge-Versuche.

`cleanupStateDir()` (räumt alte `tier-`/`session-`-Dateien) schont normalerweise
die Session-Datei des gerade laufenden Tickets — das bestimmte bisher eine
**globale** Abfrage (`--label in-progress`, erstes Treffer). Bei mehreren
Slots hätte das die Session eines FREMDEN Slots verschont und die eigene
gelöscht, sobald zwei Tickets gleichzeitig `in-progress` sind. Die Schonung
kommt jetzt aus dem **eigenen Claim** (`scripts/runner/cleanup.ts`).

### Status: ein aggregiertes Issue, Leitslot mit Übernahme

**Ein** Status-Issue für die ganze Flotte, geschrieben vom effektiven
Leitslot — kein Status-Issue je Slot (das wäre ab N>2 auf dem Handy kein
Statusbild mehr, und zwei Slots, die abwechselnd Titel/Body überschreiben,
sind wertlos). Jeder Slot schreibt seinen Zustand nach
`SHARED_DIR/slots/<id>/state.json` (Inhalt + Herzschlag in einer Datei); der
Leitslot aggregiert daraus (`scripts/runner/fleet.ts`). Bei genau einem
bekannten Zustand wird er unverändert durchgereicht, ohne
„Runner-Flotte"-Rahmen — das ist AK9 in Code: die Statustexte bleiben für
`SLOT_ID=1` byte-identisch zu vor diesem Ticket.

Fällt der konfigurierte `LEAD_SLOT` aus (kein frischer Herzschlag mehr,
Schwelle 90 Minuten — deutlich über `MAX_RUNTIME`, damit ein legitim
arbeitender Leitslot mitten in einem langen Bau-Lauf nicht als tot gilt),
übernimmt automatisch der niedrigste lebende Slot Status **und** Wächter,
sichtbar als Hinweis im aggregierten Text (AK5). Ohne einen frischen
Herzschlag irgendwo bleibt `LEAD_SLOT` die Antwort — ein ruhender Leitslot ist
besser als gar keiner.

`IS_LEAD` wird deshalb **jede Runde neu** bestimmt (`fleet-effective-lead` in
`claude-runner.sh`, vor `round-plan`), nicht einmal beim Skriptstart — sonst
bliebe ein ausgefallener Leitslot bis zum nächsten Prozessstart „lead", ohne
dass je ein anderer Slot übernimmt.

### `limit-until` ist geteilt

Das Kontingent ist EINS, nicht pro Slot. `limit-until` wandert von
`STATE_DIR` (slot-lokal) nach `SHARED_DIR` — sonst rennt Slot 2 weiter in
429er, während Slot 1 korrekt pausiert hat. Geschrieben wird es über einen
zweiten State-Adapter (`ctx.sharedState`, einzige Schreibstelle: der
429-Zweig in `roundEval()`), gelesen vom Bash-Limit-Gate aus derselben
`SHARED_DIR`-Datei.

### Tests: Ports und Lock aus `SLOT_ID`

`tests/run-lock.ts`: `PORT = 3100 + 10 * (SLOT_ID - 1)`, `PORT_PROD = PORT +
1` — `SLOT_ID=1` ergibt weiterhin 3100/3101, CI setzt `SLOT_ID` nicht (AK9).
`LOCK_FILE` zieht von `process.cwd()` nach `SHARED_DIR` um: bei mehreren
Arbeitsbäumen wären `cwd`-Locks mehrere Dateien und schützten nichts mehr —
zwei lokale E2E-Läufe in verschiedenen Slots teilten sich sonst eine
Datenbank und löschten sich gegenseitig Credentials/Sessions (sieht wie ein
Auth-Bug aus, ist keiner).

## Verworfen — bitte nicht erneut vorschlagen

- **Labels allein als Anspruch** (`slot:a`/`slot:b`). Kein
  Compare-and-Swap in der GitHub-API; bei kurzem Takt plus Ticket-Chaining ist
  das Rennen real, nicht theoretisch.
- **PID-Liveness als Verfall eines Claims.** Der Runner-Prozess stirbt nach
  jedem Tick, das Ticket lebt oft viele Ticks weiter (wartet z. B. auf CI).
  Gäbe jeden Claim nach Minuten frei.
- **`git worktree` statt eines zweiten Clones.** Geteiltes `.git`,
  gleichzeitige `fetch`/`merge` auf gemeinsamen Refs, plus der bekannte
  Pfad-Fallstrick (relativer Pfad legt den Baum *im* Repo an,
  `pr_catch_up_behind` bricht dann stumm ab). Spart Platte, kostet Robustheit
  an der teuersten Stelle.
- **Ein Status-Issue mit einem Abschnitt je Slot.** Der letzte Schreiber
  gewinnt — derselbe Konflikt wie mit mehreren Issues, nur eine Ebene tiefer.
- **Alle Slots fahren die globalen Wächter.** Die `gh`-Aufrufe sind
  weitgehend idempotent, die daraus entstehenden Issue-Kommentare und
  Status-Schreibvorgänge nicht.
- **Sechs einzelne Claim-Prüfungen in `select.ts`.** Mehr Code an heiklen
  Stellen, mehr Gelegenheit, eine der sechs zu vergessen (siehe die Analogie
  zu #266/#227 — ein Filterkriterium, das nicht zentral sitzt, wird
  irgendwann vergessen).

## Nicht-Ziele

Keine dynamische Autoskalierung nach Last — `SLOT_COUNT` ist eine Zahl, die
ein Mensch setzt. Kein zweiter Rechner, kein Remote-Runner. Keine Änderung an
Modell-Eskalation (ADR-0007), Queue-Format (#92) oder Merge-Automatik (#167).
