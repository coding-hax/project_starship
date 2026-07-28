# Runner als Dienst einrichten (Linux / macOS via WSL o. ä.)

Der Runner ist zustandslos: er schaut alle 60 Sekunden nach, ob es Arbeit gibt,
und beendet sich sofort wieder. Nichts hängt, nichts läuft dauerhaft. Innerhalb
eines Takts kettet er bis zu 3 Tickets hintereinander (Ticket-Chaining, #61) --
der 60-Sekunden-Takt bestimmt nur, wie lange es dauert, bis eine leere Queue oder
eine offene Frage bemerkt wird.

## Voraussetzung: die eigenständige CLI

Die VS-Code-Erweiterung bringt ihre eigene CLI-Kopie für das Panel mit, legt `claude`
aber **nicht** in den PATH. Der Runner braucht die eigenständige Installation:

```bash
claude --version     # muss im normalen Terminal funktionieren, nicht nur im Panel
```

Falls nicht: CLI separat installieren. Der echte Headless-Modus (`claude -p`) ist
ohnehin CLI-only — das Panel kann ihn nicht.

## ⚠️ Runner pausieren, wenn du selbst am Code arbeitest

Wenn du im VS-Code-Panel arbeitest und der Timer währenddessen losläuft, hantieren
**zwei Agenten in derselben Arbeitskopie**. Der `flock` im Skript schützt nur gegen
zwei parallele Runner-Läufe — nicht gegen dich.

```bash
systemctl --user stop claude-runner.timer     # bevor du dich hinsetzt
systemctl --user start claude-runner.timer    # wenn du fertig bist
```

Merk dir das als feste Gewohnheit. Ein halb gemergter Branch, an dem gleichzeitig
zwei Instanzen schreiben, ist die unangenehmste Fehlersuche, die dieses Setup zu
bieten hat.

## Vorbereitung

```bash
gh auth login                      # GitHub-CLI einmalig authentifizieren
claude                             # Claude Code einmalig interaktiv einloggen (/login)
chmod +x scripts/claude-runner.sh
```

**Wichtig:** Wenn auf dem Rechner eine `ANTHROPIC_API_KEY`-Umgebungsvariable gesetzt ist,
rechnet Claude Code gegen die API ab statt gegen dein Abo. Falls du das nicht willst:
Variable entfernen und `/login` benutzen.

## `~/.config/systemd/user/claude-runner.service`

```ini
[Unit]
Description=Claude Runner – arbeitet GitHub-Tickets ab

[Service]
Type=oneshot
Environment=REPO_DIR=%h/projects/meine-app
Environment=STATUS_ISSUE=1
ExecStart=%h/projects/meine-app/scripts/claude-runner.sh
```

## `~/.config/systemd/user/claude-runner.timer`

```ini
[Unit]
Description=Claude Runner alle 60 Sekunden

[Timer]
OnBootSec=2min
OnUnitActiveSec=60s
Persistent=true

[Install]
WantedBy=timers.target
```

## Aktivieren

```bash
systemctl --user daemon-reload
systemctl --user enable --now claude-runner.timer
loginctl enable-linger "$USER"     # läuft weiter, auch wenn du nicht eingeloggt bist

systemctl --user list-timers       # wann läuft er das nächste Mal?
journalctl --user -u claude-runner -f   # Live-Log (brauchst du im Alltag nicht)
```

## gh CLI API-Limit und Skalierung

Der Runner benutzt die GitHub CLI (`gh`) für API-Aufrufe. Das gh-Limit liegt bei
**5000 Calls pro Stunde**. Ein typischer Lauf kostet ~10–20 API-Calls:

| Takt | Slots | Calls/h |
| --- | --- | --- |
| 300 s (5 min) | 1 | ~120–240 |
| 60 s | 1 | ~600–1200 |
| 60 s | 3 (#204) | ~1800–3600 |

Für einen Slot (Standard) ist 60 Sekunden unbedenklich. **Sobald #204 mit mehreren
Slots läuft** (parallele Läufe), **muss der Takt auf 120–300 Sekunden zurück**,
sonst rückt das Limit in Reichweite.

Prüf dein aktuelles Limit mit:

```bash
gh api rate_limit | jq '.rate'
```

Der zweite Nebeneffekt: der Shim macht bei jedem Tick ein `git fetch origin main` —
das sind jetzt 60 statt 12 Fetches pro Stunde.

## Auf Windows

Entweder in WSL2 wie oben, oder über die Aufgabenplanung
(Trigger: alle 60 Sekunden, Aktion: `wsl.exe bash /pfad/claude-runner.sh`).
WSL2 ist der deutlich weniger schmerzhafte Weg.

## Was du davon auf dem Handy siehst

- **GitHub-App installieren, Repo abonnieren.**
- Fragen von Claude kommen als **Issue-Kommentar** → Push-Nachricht aufs Handy.
- Fertige Arbeit kommt als **Pull Request** → du liest den Diff und mergst per Daumen.
- Der aktuelle Zustand steht im angepinnten Status-Issue. **Die Farbe steht im Titel** —
  🟢 läuft · 🟡 wartet auf dich · 🔴 Fehler · 🔵 pausiert · ⚪️ nichts zu tun. Nur Gelb und
  Rot verlangen dich; du siehst das in der Issue-Liste, ohne hineinzuklicken.
  Das wird per _Edit_ aktualisiert, nicht per Kommentar — sonst spammt es dich zu.

Das Terminal brauchst du nie.
