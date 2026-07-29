# Runner als Dienst einrichten (macOS / launchd)

Der Runner ist zustandslos: er schaut alle 60 Sekunden nach, ob es Arbeit gibt,
und beendet sich sofort wieder. Nichts hängt, nichts läuft dauerhaft. Innerhalb
eines Takts kettet er bis zu 3 Tickets hintereinander (Ticket-Chaining, #61) --
der 60-Sekunden-Takt bestimmt nur, wie lange es dauert, bis eine leere Queue oder
eine offene Frage bemerkt wird.

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

### 6. iCloud & Netzwerkvolumes — die zweite TCC-Falle

iCloud Drive (`~/Library/Mobile Documents`) und `/Volumes` (externe Laufwerke — ein
Symlink wie `Festplatte MAC → /` zieht einen `/Volumes`-Scan ins gesamte Dateisystem)
sind eigene TCC-Kategorien und **nicht** durch Punkt 5 abgedeckt (siehe #38).

Leg das Repo **nie** in iCloud Drive ab. Runner und Agent scannen ausschließlich im
Repo, nie rekursiv über `~`, `/` oder `/Volumes` — das ist als Leitplanke im
Bau- und Planer-Prompt in `scripts/claude-runner.sh` verankert.

**Kein TCC-Grant im Voraus setzen:** ein versehentlich erteilter Grant ist breiter als
nötig und kehrt zurück, sobald der Runner erneut dorthin greift — Ursache vermeiden
statt Zugriff gewähren. Greift die Leitplanke einmal nicht, hängt der Lauf nicht
dauerhaft: `MAX_RUNTIME` würgt ihn ab, der nächste Lauf macht am Fortschrittskommentar
weiter. Wie bei Punkt 5 gilt: **kein** Full-Disk-Access für `/bin/bash` oder `claude`.

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
ausgeführt — ohne CI, ohne Review. Er müsste dafür nichts
umgehen; es genügt, die geänderte Datei im Arbeitsbaum liegen zu lassen.

Deshalb startet launchd einen Shim, der immer die **gemergte** Fassung holt. Er
liegt als [`scripts/starship-runner`](starship-runner) im Repo — reviewt, von
`protected-paths` bewacht.

Der Quelltext stand hier früher als Codeblock. Das war die Ursache von #249: die
Datei, die tatsächlich lief, war für das Repo unsichtbar, und als #203 den
Startpfad umbaute, konnte das keine CI und kein Test bemerken. Elf Stunden
Stillstand, aufgefallen ist es einem Menschen am nächsten Morgen.

Installiert wird von Hand:

```bash
install -m 0755 scripts/starship-runner ~/.local/bin/starship-runner
```

**Von Hand ist Absicht.** Ein Runner, der seinen eigenen Starter ersetzen darf,
hat keinen Vertrauensanker mehr — er könnte sich den Wächter selbst abnehmen.
Deshalb kopiert ein Mensch, und der Runner darf nur *melden*, dass kopiert werden
muss: weicht die laufende Datei von `origin/main:scripts/starship-runner` ab,
setzt er das Status-Issue auf 🟡 mit genau diesem Befehl. Der Lauf geht dabei
weiter — ein stehender Runner ist teurer als ein abweichender.

So läuft nur Runner-Code, der durch CI **und** durch deine Freigabe gegangen ist —
egal, worauf das Repo gerade steht.

Seit der Kern in TypeScript liegt (#184/S6), wandert der **ganze** Runner mit:
`scripts/runner/`, `claude-runner.sh` und `package.json` werden aus `origin/main`
in ein Wegwerf-Verzeichnis materialisiert, `node_modules` wird aus dem Repo
verlinkt. Würde nur die `.sh` kopiert, käme der TS-Kern — also die eigentliche
Entscheidungslogik — wieder aus dem Arbeitsbaum.

`REPO_DIR` und `STATE_DIR` bleiben dabei unangetastet: gebaut wird weiter im echten
Arbeitsbaum, der Zustand liegt weiter in `$REPO/.runner`. Wegwerf ist nur der Runner
selbst.

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

  <!-- Alle 60 Sekunden (#61). -->
  <key>StartInterval</key>
  <integer>60</integer>

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

**#61 (Ticket-Chaining + 60-Sekunden-Takt):** Diese Datei liegt im Repo, die echte
`~/Library/LaunchAgents/de.starship.runner.plist` **nicht** — ein PR kann sie nicht
ändern. Trag `StartInterval` dort von Hand auf `60` ein (siehe oben) und lade neu
(nächster Absatz). Der 60-Sekunden-Takt bestimmt, wie schnell der Runner auf neue
Arbeit oder beantwortete Fragen reagiert. Das Chaining selbst (`MAX_ROUNDS`/`TICK_BUDGET`
in `scripts/claude-runner.sh`, Default 3 Runden bzw. `MAX_RUNTIME`) wirkt sofort mit
dem nächsten Lauf, unabhängig von der plist. Beide Werte lassen sich optional unter
`EnvironmentVariables` überschreiben — der Default reicht normalerweise.

**Nach jeder Änderung an der plist neu laden.** launchd hält die alte Fassung im
Speicher; ein bloßes Speichern der Datei ändert nichts:

```bash
launchctl unload ~/Library/LaunchAgents/de.starship.runner.plist
launchctl load   ~/Library/LaunchAgents/de.starship.runner.plist
launchctl list de.starship.runner | grep -A3 ProgramArguments   # zeigt, was WIRKLICH läuft
```

## gh CLI API-Limit und Skalierung

Der Runner benutzt die GitHub CLI (`gh`) für API-Aufrufe. Das gh-Limit liegt bei
**5000 Calls pro Stunde**. Ein typischer Lauf kostet ~10–20 API-Calls:

| Takt | Slots | Calls/h |
| --- | --- | --- |
| 300 s (5 min) | 1 | ~120–240 |
| 120 s | 3 (#204) | ~900–1800 |
| 60 s | 1 | ~600–1200 |
| 60 s | 3 (#204) | ~1800–3600 |

Für einen Slot (Standard) ist 60 Sekunden unbedenklich. Sobald #204 mit mehreren
Slots läuft, **fährt der Takt auf 120 Sekunden** — der Default in
`gen-slot-plists.sh`, per `START_INTERVAL` überschreibbar. Gemessen am 29.07.26 im
laufenden 3-Slot-Betrieb: `gh api rate_limit` meldet **0/5000** core-Calls, GraphQL
206/5000 — zum Limit reichlich Luft; die früheren 300 s waren geschätzt, nicht
gemessen (#360).

Prüf dein aktuelles Limit mit:

```bash
gh api rate_limit | jq '.rate'
```

Der zweite Nebeneffekt: der Shim macht bei jedem Tick ein `git fetch origin main` —
das sind jetzt 60 statt 12 Fetches pro Stunde.

## Mehrere Slots (#204)

Ein Slot ist eine eigene launchd-Instanz + ein eigener Arbeitsbaum + ein eigenes
`.runner/`. `SLOT_ID` ist die einzige Variable, die einen Slot vom nächsten
unterscheidet — Ports und der Zustandsordner leiten sich rechnerisch daraus ab
(`scripts/claude-runner.sh`, `tests/run-lock.ts`). Betriebswert ist **3**,
harter Deckel im Code ist **10** (Vertipper-Schutz, AK8). Architektur und
Begründung: `docs/adr/0014-mehrere-runner-slots.md`.

**1. Slot 2..N klonen.** Slot 1 bleibt der vorhandene Checkout (`$REPO_DIR`),
kein neuer Clone nötig.

```bash
git clone https://github.com/coding-hax/project_starship.git ~/dev/starship-slot-2
cd ~/dev/starship-slot-2 && pnpm install
cp ~/dev/project_starship/.env.local .env.local   # danach DATABASE_URL unten anpassen
createdb -O starship starship_slot_2              # -O ist Pflicht, sonst Rechtefehler in der Migration
pnpm db:migrate
```

Wiederholen für jeden weiteren Slot (`starship-slot-3`, `starship_slot_3`, …).

**2. Plists erzeugen.** `scripts/gen-slot-plists.sh` schreibt nur Dateien —
er lädt oder installiert nichts von selbst, genau wie der Shim-Install oben
von Hand bleibt:

```bash
SLOT_COUNT=3 STATUS_ISSUE=1 scripts/gen-slot-plists.sh /tmp/starship-plists
cp /tmp/starship-plists/de.starship.runner.slot-*.plist ~/Library/LaunchAgents/
```

`STATUS_ISSUE` ist bei mehreren Slots **ein einziges** Issue für die ganze
Flotte (Frage 4/6, aggregierter Status vom jeweils effektiven Leitslot) — nicht
mehr eins je Slot. Vorhandene Env-Variablen aus dem alten Ein-Slot-Setup
(`SLOT_ID` etc.) überschreibt der Generator nicht von selbst; lädst du eine
alte `de.starship.runner.plist` (ohne Slot-Suffix) parallel, laufen zwei
Instanzen gegen denselben Arbeitsbaum — die vorher entladen (`launchctl
unload ~/Library/LaunchAgents/de.starship.runner.plist`).

**3. Laden.**

```bash
for f in ~/Library/LaunchAgents/de.starship.runner.slot-*.plist; do
  launchctl load "$f"
done
launchctl list | grep starship          # laufen alle drei?
```

**Rückweg:** `launchctl unload` jeder Slot-plist, dann `rm -rf
~/dev/starship-slot-2 ~/dev/starship-slot-3 ~/.starship-runner`. `SLOT_ID=1`
allein verhält sich exakt wie vor #204 (AK9) — der Rückweg braucht keinen
Code-Änderung, nur weniger geladene plists.

**Platte im Blick behalten:** jeder zusätzliche Clone bringt `node_modules`
(~570 MB) und `.next` (~275 MB) mit. Bei knappem Rest zuerst den `.next`-Cache
ruhender Slots löschen, nicht gleich einen Slot abschalten.

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
Ticket `needs-answer` verpasst. Der Text-Grep ist nur noch ein Netz.

Aus der Meldung liest er den Reset-Zeitpunkt und **überspringt die Läufe bis dahin**.
Die CLI formatiert ihn in zwei Formen:

| Reset | Meldung | Verhalten |
|---|---|---|
| ≤ 24 h (Session-Limit) | `resets 9pm` | pausiert bis 21:01 |
| > 24 h (Wochenlimit) | `resets Jul 17, 5:09pm` | schläft bis Freitag — **kein** 60-Sekunden-Takt |
| nicht lesbar | — | fällt auf den 60-Sekunden-Takt zurück |

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
