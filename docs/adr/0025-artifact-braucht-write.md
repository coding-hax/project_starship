# ADR-0025: `Artifact` braucht `Write` — die Denk-Rollen bekommen es

Status: angenommen
Datum: 2026-08-16
Korrigiert: [ADR-0024](0024-denk-laeufe-artifact.md) (dessen Kernannahme)
Bezug: [ADR-0005](0005-opus-im-runner.md), #325 (O2/O3), #752, #767

## Kontext

ADR-0024 hat den Denk-Rollen das Werkzeug `Artifact` gegeben und dabei
festgehalten:

> Ein headless-Testlauf (`claude -p --allowedTools "Artifact"`, cwd außerhalb
> des Repos) widerlegt das: `Artifact` publiziert **direkt** nach claude.ai,
> ohne Umweg über ein lokales `Write`.
>
> `READONLY_DENY` bleibt **unverändert** `Edit,Write` — `Artifact` schreibt
> keine Repo-Datei, die Denyliste hat damit nichts zu verbieten.

**Diese Annahme ist falsch.** `Artifact` nimmt ausschließlich einen `file_path`
auf eine bereits geschriebene `.html`/`.md`-Datei; einen Inline-Inhalt gibt es
im Werkzeugschema nicht. Ohne `Write` ist `Artifact` für eine Rolle, die
`Write` verweigert bekommt, schlicht unbenutzbar.

Sichtbar wurde das an #752. Der Recherche-Lauf sollte ein Entwurfsblatt für die
Routinen-Formen veröffentlichen und ist dreimal gescheitert — zuletzt mit der
Erklärung, das Werkzeug *„existiert hier schlicht nicht"*. Auch das stimmt
nicht: Ein Headless-Lauf auf derselben Maschine meldet im `system/init`-Ereignis
26 Werkzeuge, `Artifact` und `DesignSync` darunter. Vorhanden war es; benutzbar
nicht.

ADR-0024 hat den Fall selbst vorgesehen:

> Trägt sich die Kernannahme (Artifact ohne Write) in der Praxis nicht, ist das
> ein Stop-Gate: anhalten und fragen, nicht die Denyliste aufweichen.

Der Lauf hat angehalten und gefragt — formal richtig, nur mit falscher Ursache.
Der Mensch hat das Gate am 16.08.26 aufgelöst.

## Warum die feine Grenze nicht geht

Naheliegend wäre, `Write` nur für ein Wegwerf-Verzeichnis außerhalb des Repos
zu erlauben. Pfad-gebundene Regeln (`Write(//pfad/**)`) wirken in Claude Code
2.1.202 aber **in keiner der drei Varianten**, alle empirisch geprüft:

| Weg | Ergebnis |
| --- | --- |
| `--allowedTools "Write(//private/tmp/x/**)"` | auch der erlaubte Pfad wird abgelehnt |
| `--disallowedTools "Write(//private/tmp/repo/**)"` | der verbotene Pfad wird trotzdem geschrieben |
| `--settings` mit `permissions.deny` | der verbotene Pfad wird trotzdem geschrieben |

Der Pfadteil wird jeweils ignoriert. Was stattdessen **wirkt**, kam bei
derselben Messreihe heraus: Claude Code sperrt Schreibzugriffe ohnehin auf den
Arbeitsbaum ein — ein Pfad außerhalb wird mit „liegt außerhalb der erlaubten
Arbeitsverzeichnisse" abgelehnt, ganz ohne Regel.

## Entscheidung

**`READONLY_DENY` wird von `Edit,Write` auf `Edit` verkürzt, und beide
Denk-Rollen bekommen `Write` in die Allowlist.**

Die Lese-Zusage bleibt gewahrt, jetzt durch drei andere Mittel statt durch das
`Write`-Verbot:

- **Der cwd ist ein Wegwerf-Worktree.** Seit #325 (O2) laufen Denk-Rollen in
  einem eigenen Worktree, den `claude-runner.sh` nach dem Lauf per
  `git worktree remove` entfernt. Geschrieben werden kann nur, was ohnehin
  weggeworfen wird.
- **Die Arbeitsbaum-Sperre.** Ein Schreibzugriff außerhalb des cwd wird von
  Claude Code abgelehnt — der geteilte Haupt-Checkout und die Worktrees der
  anderen Slots sind damit unerreichbar.
- **Der Tripwire aus ADR-0005** (`beforeDirty`-Vergleich in `roundEval()`)
  bleibt unverändert als zweiter Boden.

`Edit` bleibt gesperrt. Der Unterschied ist die Absicht: Eine neue Datei
anlegen ist der Zweck; eine bestehende ändern ist es nie.

`BUILD_TOOLS` bleibt unangetastet — die Bau-Rolle hatte `Write` immer.

## Alternativen, die wir nicht genommen haben

**Beim Stop-Gate bleiben.** Dann bleibt `Artifact` für Denk-Rollen tote
Konfiguration: Das Werkzeugschema kostet in jeder Runde Kontext, benutzbar wäre
es nie. Entweder ganz zurückbauen oder benutzbar machen — der Zwischenzustand
ist der schlechteste.

**Ein Wegwerf-Verzeichnis außerhalb des Repos.** Wäre die sauberere Grenze,
scheitert aber an der Arbeitsbaum-Sperre: Genau ein Pfad außerhalb des cwd wird
abgelehnt. Das Werkzeug müsste dann im Wegwerf-Verzeichnis *arbeiten*, was den
Lese-Zugriff aufs Repo mitnähme.

**`--add-dir` für ein Artefakt-Verzeichnis.** Zusätzliche Fläche, zusätzliche
Konfiguration, und der Gewinn gegenüber dem ohnehin verworfenen Worktree ist
null.

## Konsequenzen

- Ein Denk-Lauf kann jetzt eine Datei in seinem Wegwerf-Worktree anlegen. Wer
  im Auftrag „nur lesend" liest, muss wissen: gemeint ist **das Repo**, nicht
  das Dateisystem.
- Der Prompt (`ARTIFACT_RULE`) schreibt den Ablauf vor: erst `Write` in den
  cwd, dann `Artifact` mit diesem Pfad, und die Datei gehört in keinen Commit.
- `scripts/runner/round.test.ts` prüft für beide Denk-Rollen `Artifact` **und**
  `Write` in der Allowlist, `Edit` in keiner der beiden;
  `scripts/tests/research-mode.test.sh` deckt denselben Vertrag zeilengenau
  über den echten `claude`-Aufruf ab.
- Bleibt eine Wirkung aus, ist die nächste Verdächtige nicht die Allowlist,
  sondern die Kontobindung: Artifacts sind laut Anbieter-Doku an Plan, Login
  und Org-Policy gebunden, nicht an die CLI-Version.
