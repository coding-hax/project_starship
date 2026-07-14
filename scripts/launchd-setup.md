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

## `~/Library/LaunchAgents/de.starship.runner.plist`

`STATUS_ISSUE` ist die Nummer des angepinnten Issues **🚦 Runner-Status**.
Ohne sie schreibt der Runner keinen Status — er läuft trotzdem.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>de.starship.runner</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/max/Documents/Max/vsc/claude proj/project_starship/scripts/claude-runner.sh</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>REPO_DIR</key>
    <string>/Users/max/Documents/Max/vsc/claude proj/project_starship</string>
    <key>STATUS_ISSUE</key>
    <string>1</string>
    <!-- launchd startet mit einem kargen PATH. Homebrew, node und claude
         liegen nicht darin — ohne diese Zeile findet das Skript nichts. -->
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/max/.local/bin</string>
  </dict>

  <!-- Alle 20 Minuten. -->
  <key>StartInterval</key>
  <integer>1200</integer>

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
Prüf den echten Pfad mit `which claude gh jq` und trag die Verzeichnisse ein.

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

## Was du dabei im Blick behalten musst

- **Der Mac muss wach sein.** Schläft er, feuert der Timer nicht. launchd holt einen
  verpassten Lauf beim Aufwachen nach (einen, nicht alle).
- Läuft der Mac im Deckel-zu-Betrieb ohne Strom, passiert gar nichts. Das ist der
  Preis dafür, dass der Runner nicht auf einem Server läuft.

## Was du davon auf dem Handy siehst

- **GitHub-App installieren, Repo abonnieren.**
- Fragen von Claude kommen als **Issue-Kommentar** → Push-Nachricht aufs Handy.
- Fertige Arbeit kommt als **Pull Request** → du liest den Diff und mergst per Daumen.
- Der aktuelle Zustand steht immer im angepinnten Issue **🚦 Runner-Status**.
  Das wird per _Edit_ aktualisiert, nicht per Kommentar — sonst spammt es dich zu.

Das Terminal brauchst du nie.
