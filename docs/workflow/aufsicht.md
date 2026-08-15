# Aufsicht — wer den Runner heilt, wenn niemand da ist

Der Runner heilt Tickets. Diese Seite beschreibt, wer den Runner heilt.

Sie ist für den Fall geschrieben, dass der Mensch **länger als einen Tag**
nicht an den Rechner kommt. Für den Normalbetrieb braucht es sie nicht: Dort
fällt eine stehende Flotte beim nächsten Blick aufs Handy auf, und ein
`fleet.sh start` dauert zehn Sekunden.

## Die zwei Wächter und ihr blinder Fleck

| Wächter | läuft auf | sieht | sieht **nicht** |
| --- | --- | --- | --- |
| `scripts/runner-supervisor.sh` | dem Mac | tote Sperren, Waisen, kaputte Links, dreckige Indizes, nicht geladene Slots | den Ausfall des Macs selbst |
| `.github/workflows/fleet-watchdog.yml` | GitHub | dass der Herzschlag steht | warum |

Das ist Absicht und der ganze Witz an der Aufteilung. Jede Aufsicht, die auf
dem Mac läuft, schweigt bei einem Stromausfall **exakt so** wie eine Flotte,
die gerade nichts zu tun hat — beide Zustände sind von außen ununterscheidbar.
Deshalb muss der letzte Wächter woanders stehen.

## Die Aufsicht auf dem Mac

```bash
scripts/runner-supervisor.sh [--dry-run] [--quiet] [--status]
```

`--status` gibt ein Lagebild aus und fasst nichts an — Reise-Modus, Zustand des
Runner-Kerns, je Slot launchd/Puls/Agenten, dazu die letzten Log-Zeilen.

Ihr Repertoire ist eine **feste, endliche Liste** bekannter Störungen mit je
einem bekannten Handgriff — jede davon hat die Flotte schon einmal stillgelegt:

1. **Slot nicht geladen** (Neustart) → `fleet.sh start <n>`, nur im Reise-Modus
2. **Agent an PID 1** (`bootout` beendet die Shell, nicht den `claude -p`) → beenden
3. **Agent älter als 95 Minuten** (Bau-Fenster ist 45) → beenden
4. **Sperre mit toter PID** → entfernen; eine lebende Sperre bleibt liegen
5. **Tote `node_modules`-Links** (#606) → `pnpm install --dir <repo>`
6. **Gestagte Änderungen** → aus dem Index nehmen, Arbeitsbaum nicht anfassen
7. **Verwaiste Worktree-Einträge** → `git worktree prune`
8. **Slot steht** (kein Zustand seit 30 Min. **und** kein Agent) → neu starten
9. **Runner-Kern unbenutzbar** → nach dem dritten Lauf die Flotte **anhalten**
10. **Platte voll, Postgres tot, Mac schläft am Netzteil** → melden

Sie ruft **kein `claude`**, schreibt keinen Code und fasst nichts unter `src/`
an. Genau deshalb darf sie das, was der Flotte verwehrt ist: beim Login
automatisch starten.

### Sehen, dass sie arbeitet

Jeder Lauf schreibt eine Zeile nach `~/.starship-runner/supervisor.log` —
**auch wenn nichts zu tun war**:

```
2026-08-14 15:18:28  TAKT slots=3/3 agenten=2 alter=[1:0m,2:0m,3:11m] reise=ja geheilt=0 alarme=0
```

Der Bericht ans Status-Issue wird bis zu dreimal versucht. Grund: Der
wichtigste Lauf ist der direkt nach einem Boot — und genau dort ist das Netz
oft noch nicht oben. Am 15.08. ging der erste Bericht 20 Sekunden nach dem
Start verloren.

Ohne sie sieht ein gesunder Lauf exakt aus wie eine tote Aufsicht: kein
Eintrag, keine Meldung. Genau dieser blinde Fleck ist der Grund, warum es den
Totmann-Schalter gibt — die Aufsicht darf ihn nicht selbst wieder aufmachen.
`tail -f ~/.starship-runner/supervisor.log` ist der Blick über die Schulter,
`--status` das Lagebild auf Zuruf. Das Log wird bei 5000 Zeilen gekürzt.

### Warum Punkt 8 zwei Bedingungen braucht

Ein Bau-Lauf darf 45 Minuten dauern und schreibt in dieser Zeit keinen
Slot-Zustand. „Lange still" allein heißt also gar nichts — wer darauf neu
startet, schießt laufende Arbeit ab. Erst **still UND kein Agent in diesem
Repo** heißt stehengeblieben. Der Neustart ist dann verlustfrei: Der nächste
Lauf liest Branch, `git log` und Fortschrittskommentar und macht dort weiter.

Und eine dritte Bedingung, die erst der Betrieb gezeigt hat: **kurz nach einem
Systemstart wird gar nicht geprüft.** War die Maschine aus, ist jeder
Slot-Zustand alt — die Slots haben nicht geschwiegen, es lief nur nichts. Ohne
diese Sperre deutete die Aufsicht die Ausschaltzeit als Stillstand und startete
nach jedem Boot alle Slots ein zweites Mal, Sekunden nachdem sie sie gestartet
hatte (15.08., 02:50: sechs Heilungsmeldungen für ein Ereignis).

Was hier ausdrücklich **nicht** passiert: einem offenen Ticket sein
`in-progress` oder seinen Claim wegnehmen. `claimSweep()` in
`scripts/runner/claim.ts` lässt das bewusst stehen — „das gäbe es der Flotte
weg, obwohl es niemand gelöst hat". Die Aufsicht widerspricht dieser
Entscheidung nicht, sie meldet nur.

### Warum Punkt 9 anhält statt zu reparieren

Ein Lauf, der `scripts/runner/` kaputt gemacht hat, ist der einzige Schaden,
den die Aufsicht nicht beheben kann — sie müsste dafür Code schreiben, und
dann wäre sie ein Agent. Drei Slots würden stattdessen zwei Wochen lang
Kontingent gegen einen toten Kern verfeuern. Also: anhalten, melden, warten.
Ein angehaltener Runner kostet Zeit. Ein thrashender kostet Zeit **und** das
Kontingent, mit dem man ihn hinterher repariert.

## Reise-Modus

Die Slot-Plists liegen bewusst **nicht** in `~/Library/LaunchAgents`. Nach dem
Vorfall vom 10.08.26 (nach einem Neustart lief eine Agentenflotte, die niemand
gestartet hatte) gilt: launchd kann nicht laden, was es nicht sieht — eine
Garantie des Dateisystems, kein Flag, das versehentlich umgelegt wird.

Diese Garantie bleibt. Stattdessen wandert **die Aufsicht** nach
LaunchAgents — ein Skript, das selbst nichts bauen kann — und sie startet die
Flotte nur, solange die Reise-Markierung existiert:

```bash
touch ~/.starship-runner/trip-mode     # vor der Abreise
rm    ~/.starship-runner/trip-mode     # nach der Rückkehr
```

Ohne die Markierung meldet die Aufsicht einen fehlenden Slot nur und rührt ihn
nicht an. Das Anlegen der Datei ist dieselbe bewusste Handlung, die früher das
`fleet.sh start` war — sie überlebt nur zusätzlich den Neustart.

## Der Totmann-Schalter

`.github/workflows/fleet-watchdog.yml`, alle 30 Minuten bei GitHub. Er liest
die `Stand:`-Zeile im Body des Status-Issues und erwähnt den Menschen, wenn sie
drei Stunden alt ist. Eine Erwähnung erzeugt eine Push-Nachricht in der
GitHub-App — unterwegs der einzige Kanal, der ankommt.

Zwei Entwurfsentscheidungen, die nicht offensichtlich sind:

- **Gemessen wird der Body, nicht `updatedAt`.** `gh issue comment` bumpt
  `updatedAt` selbst; ein Wächter, der darauf hört, meldet dreißig Minuten nach
  seinem eigenen Alarm Entwarnung.
- **Keine Repo-Secrets.** `GITHUB_TOKEN` stellt die Action selbst.
  `reminders.yml` und `garmin-sync.yml` feuern seit jeher ins Leere, weil sie
  Secrets brauchen, die es hier nicht gibt. Ausgerechnet der Wächter darf
  diesen Fehler nicht wiederholen.

## Was die Aufsicht ausdrücklich nicht kann

Sie hält die Maschine am Laufen. Sie hält die **Arbeit** nicht am Laufen.

Läuft die Queue leer, steht ein Ticket auf `needs-answer` oder liegt etwas
untriagiert im Posteingang, dann ist die Flotte kerngesund und tut trotzdem
nichts. Dagegen hilft kein Wächter, sondern Vorbereitung — siehe
`docs/workflow/queue.md` und `docs/workflow/labels.md`.
