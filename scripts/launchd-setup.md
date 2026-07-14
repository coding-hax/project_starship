# Runner als Dienst einrichten (macOS / launchd)

Der Runner ist zustandslos: er schaut alle 20 Minuten nach, ob es Arbeit gibt,
und beendet sich sofort wieder. Nichts hängt, nichts läuft dauerhaft.

> **Linux?** Dann gilt `systemd-setup.md`. Diese Datei ist das macOS-Gegenstück —
> `systemd` gibt es hier nicht, der Dienst heißt `launchd`.

---

## Voraussetzungen — bitte der Reihe nach prüfen

### 1. Die eigenständige `claude`-CLI

Die VS-Code-Erweiterung bringt ihre eigene CLI-Kopie für das Panel mit, legt `claude`
aber **nicht** in den PATH. Der Runner braucht die eigenständige Installation:

```bash
claude --version     # muss im normalen Terminal funktionieren, nicht nur im Panel
```

Schlägt das fehl, ist der Runner nutzlos. Der echte Headless-Modus (`claude -p`) ist
ohnehin CLI-only — das Panel kann ihn nicht.

### 2. `gh` und `jq`

```bash
gh auth status       # muss eingeloggt sein
jq --version
```

### 3. Kein `ANTHROPIC_API_KEY` in der Umgebung

Ist die Variable gesetzt, rechnet Claude Code **gegen die API ab statt gegen dein Abo**.
Wenn du das nicht willst: Variable entfernen und `claude` einmal interaktiv per `/login`
anmelden.

### 4. Docker läuft

Der Runner lässt Tests laufen, die eine Postgres brauchen:

```bash
docker compose up -d
```

### 5. Das Repo liegt **nicht** in `~/Documents`

`~/Documents`, `~/Desktop` und `~/Downloads` sind von macOS per TCC geschützt. Dein
Terminal hat dort Zugriff — der von **launchd** gestartete `/bin/bash` nicht. Der
Runner scheitert dann mit:

```
/bin/bash: …/scripts/claude-runner.sh: Operation not permitted
```

Das ist kein Rechte-Problem der Datei (`chmod` hilft nicht) und es fällt nicht auf,
solange du von Hand testest — nur der Timer-Lauf stirbt. Leg das Repo in einen
ungeschützten Ordner (`~/dev`, `~/projects`). `/bin/bash` „Festplattenvollzugriff"
zu geben wäre der falsche Ausweg: das gilt dann für **jedes** Skript auf dem Rechner.

---

## ⚠️ Runner pausieren, wenn du selbst am Code arbeitest

Wenn du im VS-Code-Panel arbeitest und der Timer währenddessen losläuft, hantieren
**zwei Agenten in derselben Arbeitskopie**. Der Lock im Skript schützt nur gegen
zwei parallele Runner-Läufe — nicht gegen dich.

```bash
launchctl unload ~/Library/LaunchAgents/de.starship.runner.plist   # bevor du dich hinsetzt
launchctl load   ~/Library/LaunchAgents/de.starship.runner.plist   # wenn du fertig bist
```

Merk dir das als feste Gewohnheit. Ein halb gemergter Branch, an dem gleichzeitig
zwei Instanzen schreiben, ist die unangenehmste Fehlersuche, die dieses Setup zu
bieten hat.

---

## Der Shim — launchd startet **nicht** den Arbeitsbaum

`scripts/claude-runner.sh` liegt in genau dem Repo, das der Agent bearbeitet. Zeigt
launchd direkt darauf, führt es die Datei aus **dem gerade ausgecheckten Branch** aus —
und welcher das ist, entscheidet der Agent.

Damit stünde der Wächter an der falschen Tür: `protected-paths` verhindert den **Merge**
von `scripts/`-Änderungen, nicht deren **Ausführung**. Ein Agent, der seinen eigenen
Runner auf seinem Feature-Branch umschreibt, bekäme diesen Code beim nächsten Tick
ausgeführt — ohne CI, ohne Review, ohne `human-approved`. Er müsste dafür nichts
umgehen; es genügt, die geänderte Datei im Arbeitsbaum liegen zu lassen.

Deshalb startet launchd einen Shim, der immer die **gemergte** Fassung holt:

```bash
# ~/.local/bin/starship-runner
#!/usr/bin/env bash
set -euo pipefail
REPO="${REPO_DIR:-$HOME/dev/project_starship}"
REF="${RUNNER_REF:-origin/main}"
cd "$REPO" || { echo "REPO_DIR nicht gefunden: $REPO" >&2; exit 1; }

# Nur den Ref aktualisieren, nichts auschecken — der Agent arbeitet hier
# womöglich gerade auf einem Feature-Branch, den wir nicht anfassen dürfen.
git fetch -q origin main || { echo "git fetch fehlgeschlagen — Lauf übersprungen." >&2; exit 0; }

TMP=$(mktemp -t starship-runner) || exit 1
trap 'rm -f "$TMP"' EXIT
git show "$REF:scripts/claude-runner.sh" > "$TMP" || {
  echo "Konnte scripts/claude-runner.sh aus $REF nicht lesen." >&2; exit 1; }
bash -n "$TMP" || { echo "Runner aus $REF ist syntaktisch kaputt — Lauf übersprungen." >&2; exit 1; }
exec bash "$TMP"
```

```bash
chmod +x ~/.local/bin/starship-runner
```

So läuft nur Runner-Code, der durch CI **und** durch deine Freigabe gegangen ist —
egal, worauf das Repo gerade steht.

## `~/Library/LaunchAgents/de.starship.runner.plist`

`STATUS_ISSUE` ist die Nummer des angepinnten Runner-Status-Issues.
Ohne sie schreibt der Runner keinen Status — er läuft trotzdem.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>de.starship.runner</string>

  <!-- Auf den Shim zeigen, NICHT auf scripts/claude-runner.sh im Repo. Warum:
       siehe Abschnitt "Der Shim" oben. -->
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/max/.local/bin/starship-runner</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>REPO_DIR</key>
    <string>/Users/max/dev/project_starship</string>
    <key>STATUS_ISSUE</key>
    <string>1</string>

    <!-- launchd erbt die Shell-Umgebung NICHT. Ohne diesen PATH findet das Skript
         weder claude noch gh noch node — und bricht bei jedem Lauf ab.
         ACHTUNG: node liegt unter nvm. Wechselst du die Node-Version, ändert sich
         dieser Pfad und der Runner findet node nicht mehr. Dann hier nachziehen. -->
    <key>PATH</key>
    <string>/Users/max/.local/bin:/Users/max/.nvm/versions/node/v22.5.1/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>

    <key>HOME</key>
    <string>/Users/max</string>
  </dict>

  <!-- Alle 20 Minuten. -->
  <key>StartInterval</key>
  <integer>1200</integer>

  <!-- Nicht sofort beim Laden loslaufen — sonst startet ein Agent in dem Moment,
       in dem du den Timer aktivierst. -->
  <key>RunAtLoad</key>
  <false/>

  <key>StandardOutPath</key>
  <string>/tmp/starship-runner.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/starship-runner.err.log</string>
</dict>
</plist>
```

**Der `PATH`-Eintrag ist nicht optional.** launchd erbt nicht deine Shell-Umgebung.
Ohne ihn findet das Skript weder `gh` noch `claude` und bricht bei jedem Lauf ab.
Prüf den echten Pfad mit `which claude gh jq node` und trag die Verzeichnisse ein.

**Nach jeder Änderung an der plist neu laden.** launchd hält die alte Fassung im
Speicher; ein bloßes Speichern der Datei ändert nichts:

```bash
launchctl unload ~/Library/LaunchAgents/de.starship.runner.plist
launchctl load   ~/Library/LaunchAgents/de.starship.runner.plist
launchctl list de.starship.runner | grep -A3 ProgramArguments   # zeigt, was WIRKLICH läuft
```

## Aktivieren

```bash
launchctl load ~/Library/LaunchAgents/de.starship.runner.plist
launchctl list | grep starship          # läuft er?
```

Einmal von Hand anstoßen, ohne auf den Timer zu warten:

```bash
launchctl start de.starship.runner
tail -f /tmp/starship-runner.err.log
```

## Abschalten

```bash
launchctl unload ~/Library/LaunchAgents/de.starship.runner.plist
```

## Wenn das Kontingent leer ist

Läuft `claude -p` ins Limit, kommt kein Absturz zurück, sondern ein `429` mit einer
Meldung wie `You've hit your session limit · resets 2:50pm (Europe/Berlin)`.

Der Runner erkennt das an **`api_error_status == 429`** — nicht am Wortlaut. Der Satz
ist nicht stabil: die frühere Erkennung greppte nach `usage limit` und kannte
`session limit` nicht, hat ein harmloses Limit als harten Fehler behandelt und dem
Ticket `needs-input` verpasst. Der Text-Grep ist nur noch ein Netz.

Aus der Meldung liest er den Reset-Zeitpunkt und **überspringt die Läufe bis dahin**.
Die CLI formatiert ihn in zwei Formen:

| Reset | Meldung | Verhalten |
|---|---|---|
| ≤ 24 h (Session-Limit) | `resets 9pm` | pausiert bis 21:01 |
| > 24 h (Wochenlimit) | `resets Jul 17, 5:09pm` | schläft bis Freitag — **kein** 20-Minuten-Takt |
| nicht lesbar | — | fällt auf den 20-Minuten-Takt zurück |

Der Zeitpunkt steht in `.runner/limit-until` (Unix-Zeit). **Ein Fehlparsen darf den
Runner nie stilllegen**, deshalb wird eine unplausible Zeit verworfen statt geglaubt —
lieber einmal umsonst aufwachen (ein `429` kommt sofort zurück und kostet null Tokens)
als tagelang blind schlafen.

Willst du eine Pause von Hand aufheben:

```bash
rm -f ~/dev/project_starship/.runner/limit-until
```

Limit-Meldungen, deren Reset-Zeit er nicht deuten konnte, landen in
`.runner/unparsed-limits.log` — dort steht der echte Wortlaut, falls der Parser
nachgeschärft werden muss.

## Was du dabei im Blick behalten musst

- **Der Mac muss wach sein.** Schläft er, feuert der Timer nicht. launchd holt einen
  verpassten Lauf beim Aufwachen nach (einen, nicht alle).
- Läuft der Mac im Deckel-zu-Betrieb ohne Strom, passiert gar nichts. Das ist der
  Preis dafür, dass der Runner nicht auf einem Server läuft.

## Was du davon auf dem Handy siehst

- **GitHub-App installieren, Repo abonnieren.**
- Fragen von Claude kommen als **Issue-Kommentar** → Push-Nachricht aufs Handy.
- Fertige Arbeit kommt als **Pull Request** → du liest den Diff und mergst per Daumen.
- Der aktuelle Zustand steht im angepinnten Status-Issue. **Die Farbe steht im Titel** —
  🟢 läuft · 🟡 wartet auf dich · 🔴 Fehler · 🔵 pausiert · ⚪️ nichts zu tun. Nur Gelb und
  Rot verlangen dich; du siehst das in der Issue-Liste, ohne hineinzuklicken.
  Das wird per _Edit_ aktualisiert, nicht per Kommentar — sonst spammt es dich zu.

Das Terminal brauchst du nie.
