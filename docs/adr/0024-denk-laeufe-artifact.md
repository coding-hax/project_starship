# ADR-0024: Denk-Läufe dürfen ein Artifact auf claude.ai veröffentlichen

Status: angenommen
Datum: 2026-08-15
Bezug: [ADR-0005](0005-opus-im-runner.md) (#767, Issue #722 als Anlass)

## Kontext

Entwurfsblätter und Rechercheergebnisse als Artifact auf claude.ai entstehen
bisher nur in Chat-Sitzungen (Beispiel: das Entwurfsblatt in #722). Ein
Runner-Lauf konnte das nicht — `Artifact` stand in keiner der beiden
Werkzeuglisten (`READONLY_TOOLS`/`BUILD_TOOLS` in `scripts/runner/prompts.ts`).

ADR-0005 legt die beiden Denk-Rollen (`plan`, `research`) als **nur lesend**
fest: kein `Edit`/`Write`, harte Zusatzgrenze `READONLY_DENY = 'Edit,Write'`
(O3, #325). Naheliegend wäre die Annahme, ein Artifact brauche zuerst ein
lokales `Write` — das wäre mit der Read-only-Zusage unvereinbar.

Ein headless-Testlauf (`claude -p --allowedTools "Artifact"`, cwd außerhalb
des Repos) widerlegt das: `Artifact` publiziert **direkt** nach claude.ai,
ohne Umweg über ein lokales `Write`. Auth ist kein Hindernis — der Runner
setzt kein `ANTHROPIC_API_KEY`, ein Lauf erbt den `claude login`-OAuth, das
Artifact landet in der Galerie des Menschen. Das Werkzeug-Schema kennt aber
kein `action:"list"` — ein Lauf kann seine eigenen Artifacts nicht abfragen,
die URL muss also außerhalb des Werkzeugs festgehalten werden.

## Entscheidung

Beide Denk-Rollen (`plan` **und** `research`) dürfen `Artifact` benutzen,
`build` **nicht**:

- `scripts/runner/round.ts` hängt `Artifact` an die tools-Komposition beider
  Denk-Rollen an (`READONLY_TOOLS,Artifact` bzw.
  `READONLY_TOOLS,WebSearch,Artifact`), analog zu `WebSearch` bei `research`.
  `READONLY_DENY` bleibt **unverändert** `Edit,Write` — `Artifact` schreibt
  keine Repo-Datei, die Denyliste hat damit nichts zu verbieten.
- `scripts/runner/prompts.ts` bekommt eine geteilte `ARTIFACT_RULE`, in
  `planPrompt()` und `researchPrompt()` eingebunden (nicht in
  `buildPrompt()`/`ciFixPrompt()` — ein Bau-Lauf, der nebenbei eine Seite
  veröffentlicht, wäre Scope-Creep). Sie schreibt vor:
  - **Wann**: nur wenn ein anzuschauendes Objekt die Entscheidung trägt,
    sonst reicht der Issue-Kommentar — der Normalfall ist kein Artifact.
  - **Wie**: klein, nur das Objekt plus Beschriftung; keine
    Begründungs-Abschnitte, Trade-off-Tabellen oder Code-Listings auf der
    Seite, nicht mehr Varianten als die Entscheidung braucht.
  - **Nie ins Artifact**: echte Nutzerdaten (insbesondere Journal-Inhalte)
    oder Secrets — veröffentlichen heißt, es verlässt das Gerät.
  - **URL im Kommentar**: landet im Plan-/Rechercheergebnis-Kommentar, nicht
    nur in der Galerie. Ein Fortsetzungslauf aktualisiert über diese URL/ID
    dasselbe Artifact statt ein zweites anzulegen — die einzige verfügbare
    Klammer, da das Werkzeug kein `action:"list"` kennt.
- `build`-Läufe bekommen `Artifact` nicht (`BUILD_TOOLS` bleibt unverändert).

## Grenzen

- **Read-only bleibt by construction gewahrt**: der Tripwire aus ADR-0005
  (`beforeDirty`-Vergleich in `roundEval()`) prüft weiterhin nur Repo-Zustand
  — `Artifact` berührt den Repo nie, also gibt es dort nichts Neues zu
  melden.
- **Kein Ersatz für den Kommentar**: das Artifact zeigt das Objekt, die
  Überlegung (Trade-offs, Begründung) bleibt im Issue-Kommentar — der Mensch
  sieht unterwegs nur GitHub.
- Trägt sich die Kernannahme (Artifact ohne Write) in der Praxis nicht, ist
  das ein Stop-Gate: anhalten und fragen, nicht die Denyliste aufweichen.

## Konsequenzen

- Token-Kosten: das Artifact-Werkzeugschema liegt ab jetzt in jeder Runde
  beider Denk-Rollen im Kontext, auch ohne Artifact-Aufruf — grob einige
  hundert Tokens plus die `ARTIFACT_RULE`-Passage im Prompt. Klein gegenüber
  der ohnehin leselastigen Denk-Rolle.
- `scripts/runner/round.test.ts` und `scripts/runner/prompts.test.ts`:
  `Artifact` in der Werkzeugliste beider Denk-Rollen, nicht in `BUILD_TOOLS`;
  `scripts/tests/research-mode.test.sh` deckt denselben Vertrag Ende-zu-Ende
  über den `claude`-Aufruf ab.
- Rückweg: additiv und reversibel — die beiden `,Artifact`-Anhänge in
  `round.ts` sowie `ARTIFACT_RULE` (Konstante + Einbindung) entfernen, Tests
  zurücknehmen.
