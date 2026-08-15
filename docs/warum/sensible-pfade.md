# Warum es an den sensiblen Pfaden keinen Wächter mehr gibt

Die Regel steht in `CLAUDE.md`, Abschnitt „Sensible Pfade". Hier steht, warum
sie so aussieht, wie sie aussieht.

## Es gab einen Check, und er war schlimmer als keiner

`protected-paths` war ein CI-Check, der anschlagen sollte, sobald ein Diff
`src/db/`, `src/crypto/`, `src/local/`, `src/app/api/sync/`, `auth`-Dateien,
`.github/` oder `scripts/` berührte.

Seit **#276** blockierte er nicht mehr — er lief, wurde grün, und niemand
merkte, dass er nichts mehr prüfte. Seit **#283** ist er ganz entfernt.

Die Entfernung war eine bewusste Entscheidung, keine Nachlässigkeit: Ein Check,
der nie fehlschlägt, bringt niemandem etwas bei. Schlimmer noch, er erzeugt
Sicherheit, die es nicht gibt — ein grüner Lauf liest sich wie eine Freigabe.
Der Mensch gibt die PRs in diesem Projekt ohnehin direkt frei. Begründung und
der bewusst akzeptierte Preis stehen in `docs/workflow/merge.md`, Abschnitt
„Ein Wächter".

## Was an seine Stelle getreten ist

Bis #283 lautete die Vorschrift: Berührt dein Diff einen sensiblen Pfad, setze
`needs-answer` und warte. Das hielt Tickets an, ohne dass es etwas zu
entscheiden gab — der Mensch fand eine Frage vor, die keine war, und antwortete
„ja, mach".

Ersetzt wurde das durch einen **Kommentar ans Issue beim Öffnen des PR**: was
geändert wurde, warum, was schiefgehen könnte, wie der Rückweg aussieht. Kein
Warten, kein Label — aber eine Spur, die ein Mensch später findet.

`needs-answer` ist an sensiblen Pfaden nur noch dann richtig, wenn wirklich eine
Entscheidung offen ist: eine unsichere Krypto-Änderung, ein Migrationspfad, bei
dem der Down-Weg nicht klar ist, ein Sync-Konflikt ohne offensichtliche
Auflösung. Nicht, weil ein Pfad in einer Liste steht.

## Warum das die Sorgfalt wichtiger macht, nicht unwichtiger

Ein Fehler in diesen Pfaden ist kein Bug, sondern **Datenverlust** — bei
`src/crypto/` und `src/local/` potenziell unwiederbringlich, weil die
Klartextdaten nur auf dem Gerät liegen.

Dass hier kein automatischer Wächter mehr steht, ist eine Entscheidung des
Menschen über **einen** Check. Es ist keine Einladung, es bei den übrigen Toren
genauso zu halten: Einen Wächter abzuschalten oder eine Änderung so
umzuschneiden, dass sie an einer Prüfung vorbeirutscht, bleibt in jedem Fall
ausgeschlossen.
