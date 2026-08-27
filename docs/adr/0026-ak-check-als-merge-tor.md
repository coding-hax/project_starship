# ADR-0026: Der AK-Check ist das Tor vor dem Merge

Status: angenommen
Datum: 2026-08-26
Bezug: [ADR-0005](0005-opus-im-runner.md), [ADR-0007](0007-opus-eskalation-baut.md),
[ADR-0013](0013-modellstufe-am-ticket.md), Issue #839

## Kontext

Bis hierher war der Bau-Lauf sein eigener Prüfer. Sein letzter Schritt lautete
`gh pr ready` + `gh pr merge --squash --auto` — derselbe Agent, der den Code
geschrieben hat, stellte damit auch fest, dass er fertig ist.

Dagegen standen zwei Netze, und beide prüfen etwas anderes:

- **CI** prüft Lint, Typen und die Tests, die im PR liegen. Also die Fragen,
  die der Bau-Lauf selbst formuliert hat.
- **`check-test-integrity.sh`** prüft, dass kein Test aufgeweicht wurde und die
  Testanzahl nicht sinkt. Also die Form der Tests, nicht ihren Gegenstand.

Niemand prüfte die Frage, um die es im Ticket geht: **steht im Diff, was in den
Akzeptanzkriterien steht?** Ein Bau-Lauf, der AK 4 übersieht, hinterlässt einen
grünen PR — sein eigener Fortschrittskommentar trägt den Haken, und der Haken
ist eine Selbstauskunft.

CLAUDE.md benennt diesen Interessenkonflikt für Tests schon ausdrücklich („Du
schreibst Code **und** Tests — der Interessenkonflikt ist dir bewusst"). Für die
Fertig-Feststellung stand er nur nicht dort.

Zweite Beobachtung aus demselben Ticket: **Kriterien sind nicht garantiert
vorhanden.** Das Issue-Template hat einen AK-Abschnitt, aber nichts erzwingt
ihn. Ein Ticket ohne Kriterien lässt sich weder prüfen noch abschließen — es
kann nur die Meinung des Bau-Laufs geben.

## Entscheidung

**1. Eine vierte Rolle: `check`.** Nur lesend, wie `plan` und `research`. Sie
denkt aber nicht über ein offenes Problem nach, sondern hält einen fertigen
Diff gegen eine bestehende Liste. Ihr Arbeitsverzeichnis ist ein
Wegwerf-Worktree **auf dem PR-Branch** (die anderen Lese-Rollen bleiben auf
`origin/main`), damit `git diff origin/main...HEAD` genau den Diff des Tickets
zeigt.

**2. Der Bau-Lauf mergt nicht mehr.** Er endet mit `--add-label check` und
lässt den PR im Entwurf. `gh pr ready` und `gh pr merge` stehen nur noch im
Prüf-Prompt, samt der `--subject`-Pflicht aus #292. Dasselbe gilt für den
CI-Fix-Lauf.

Das genügt allein nicht: **auch der Runner-Takt mergt nicht am Tor vorbei.**
Die CI-Wache (#147) hebt einen grünen PR bisher selbst aus dem Entwurf — sie
käme dem Prüfer jedes Mal zuvor, denn der Bau-Lauf endet grün und setzt `check`
erst als letzten Schritt. Trägt ein Ticket `check`, hält die Wache bei grüner
CI still und überlässt den Merge dem Prüf-Lauf. Umgekehrt schlägt **rote CI das
Tor**: der Takt nimmt `check` zurück und lässt erst reparieren — über einen
Stand, dessen Checks rot sind, ist nicht zu urteilen, und der nur lesende
Prüfer könnte daran ohnehin nichts ändern. Der Fix-Lauf setzt `check` an seinem
sauberen Ende selbst wieder.

**3. Ein Befund je Kriterium, mit Beleg.** `erfüllt` verlangt eine Stelle im
Code *und* einen Test (außer bei `tests-exempt`). `nicht prüfbar` ist ein
eigener Befund und zählt fürs Tor wie `nicht erfüllt` — er sagt dem nächsten
Bau-Lauf, dass ein Beleg fehlt, nicht Code.

**4. Bei einer Lücke geht das Ticket zurück in den Bau,** nicht an den
Menschen: `check` fällt weg, `in-progress` bleibt, die offenen Punkte stehen im
Fortschrittskommentar. Erst der **zweite** vergebliche Check endet mit
`needs-answer` — zwei Runden am selben Kriterium heißen, dass das Kriterium
unklar ist, und das entscheidet kein dritter Lauf.

**5. Akzeptanzkriterien sind Pflicht.** `scripts/runner/ak.ts` liest sie
mechanisch aus dem Ticket-Body. Findet es keine, startet kein Bau-Lauf: ein
Kommentar ans Ticket, `needs-answer`, Ende. Denselben Parser benutzt der
Prüf-Lauf — die Nummerierung im Befund ist damit garantiert die des Tickets.

## Konsequenzen

**Ein Ticket kostet ab jetzt mindestens einen Lauf mehr.** Bewusst: der Prüfer
läuft auf Sonnet, liest nur, und der Lauf ist kurz gegen einen Bau-Lauf.

**Der Prüfer zählt nicht in den Denk-Rollen-Tagesdeckel** (#492) und erbt auch
nicht die Eskalationsstufe des Bau-Tickets (ADR-0007). Beides würde Merges
anhalten — die Eskalation gilt dem Bauen, nicht dem Nachsehen.

**Das AK-Tor lässt im Zweifel laufen.** Es greift nur, wenn der Ticket-Body
wirklich bekannt ist: leerer Body → Tor. Kein `body`-Feld im Schnappschuss oder
Ticket gar nicht im Schnappschuss (z. B. `gh issue list` gescheitert) → kein
Tor. Ein Tor, das auf fehlende Information hin parkt, legt die Flotte still,
und niemand fände den Grund.

**Bestehende Tickets ohne AK fallen einmalig in `needs-answer`.** Das ist der
Preis und zugleich der Zweck.

**Ohne Kriterien wird auch nicht freigegeben.** Bei einer leeren Liste wäre
„alle erfüllt" trivial wahr — ausgerechnet der einzige Lauf, der mergen darf,
würde ohne Maßstab durchwinken. Trägt ein Ticket `check`, hat aber keine
Kriterien, gibt der Takt das Label zurück, statt zu prüfen; der nächste Takt
ist ein Bau-Lauf und läuft dann selbst ins AK-Tor.

**Was das nicht ist:** kein Ersatz für CI und keine Korrektheitsprüfung. Der
Prüfer beantwortet genau eine Frage — steht im Diff, was im Ticket steht.

## Verworfene Alternativen

- **Ein GitHub-Actions-Job als Required Check.** Das Repo hat null Secrets und
  ist öffentlich; ein `claude -p` in CI bräuchte einen API-Key im Repo.
- **Ein Prüf-Schritt im selben Lauf** („prüfe dich am Ende selbst"). Genau der
  Interessenkonflikt, um den es geht.
- **Ein Mensch als Tor.** Der Nutzer ist unterwegs und sieht nur GitHub auf dem
  Handy — ein Pflicht-Review von Hand hielte jede Nacht an.
