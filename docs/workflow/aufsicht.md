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
scripts/runner-supervisor.sh [--dry-run] [--quiet]
```

Ihr Repertoire ist eine **feste, endliche Liste** bekannter Störungen mit je
einem bekannten Handgriff — jede davon hat die Flotte schon einmal stillgelegt:

1. **Slot nicht geladen** (Neustart) → `fleet.sh start <n>`, nur im Reise-Modus
2. **Agent an PID 1** (`bootout` beendet die Shell, nicht den `claude -p`) → beenden
3. **Agent älter als 95 Minuten** (Bau-Fenster ist 45) → beenden
4. **Sperre mit toter PID** → entfernen; eine lebende Sperre bleibt liegen
5. **Tote `node_modules`-Links** (#606) → `pnpm install --dir <repo>`
6. **Gestagte Änderungen** → aus dem Index nehmen, Arbeitsbaum nicht anfassen
7. **Verwaiste Worktree-Einträge** → `git worktree prune`
8. **Runner-Kern unbenutzbar** → nach dem dritten Lauf die Flotte **anhalten**
9. **Platte voll, Postgres tot, Mac schläft am Netzteil** → melden

Sie ruft **kein `claude`**, schreibt keinen Code und fasst nichts unter `src/`
an. Genau deshalb darf sie das, was der Flotte verwehrt ist: beim Login
automatisch starten.

### Warum Punkt 8 anhält statt zu reparieren

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
