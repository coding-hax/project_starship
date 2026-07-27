# ADR-0013: Die Modellstufe ist am Ticket wählbar

Status: angenommen
Datum: 2026-07-27
Nachtrag zu: [ADR-0005](0005-opus-im-runner.md), [ADR-0007](0007-opus-eskalation-baut.md)

## Kontext

ADR-0005 hält fest: Opus plant und recherchiert, **baut aber nicht**. ADR-0007
öffnet dafür genau eine Tür — die Eskalation: nach drei erfolglosen
Sonnet/Haiku-Läufen darf Opus bauen, gedeckelt auf zwei Bau-Läufe je Ticket
und Tag.

Diese Tür hat einen Preis, den man vorher kennt: Bei einem Ticket, von dem
schon beim Schneiden klar ist, dass es schwer wird — Sync, Krypto, ein
Umbau quer durch mehrere Module —, kostet der Weg dorthin drei Läufe, die
absehbar nichts liefern. Das sind drei Läufe Kontingent, drei Runden CI und
im schlechtesten Fall ein Branch, den der vierte Lauf erst wieder aufräumen
muss.

Dazu kommt ein Sichtbarkeitsproblem: Die laufende Stufe steht in
`.runner/tier-<nr>` — einer Datei auf dem Rechner, der niemandem gehört, der
gerade hinschaut. Vom Handy aus ist nicht erkennbar, dass der nächste Lauf
Opus verbrennt. `model:haiku` beschrieb bis heute die Startstufe, während real
längst Opus lief.

## Entscheidung

**Die Modellstufe ist am Ticket wählbar: `model:haiku`, `model:sonnet`,
`model:opus`.**

Das Label ist die **Startstufe**, nicht die Fessel:

```
tier-<nr> gesetzt (eskaliert)?  -> diese Stufe.
sonst model:*-Label gesetzt?    -> dessen Stufe.
sonst Rolle plan/research       -> opus   (ADR-0005 unverändert).
sonst                           -> sonnet (ADR-0007 unverändert).
```

Ein hand-gesetztes `model:opus` heißt damit: **Opus baut sofort, ohne die drei
erfolglosen Läufe.** Das ist die eigentliche Erweiterung gegenüber ADR-0005.

Für die Denk-Rollen schlägt das Label die Rolle: `plan` + `model:sonnet` plant
auf Sonnet. Ohne Label bleibt es bei Opus, ADR-0005 ändert sich also für
niemanden, der nichts tut.

## Warum das keine Aufweichung von ADR-0005 ist

Der Kern von ADR-0005 war nie „Opus ist verboten", sondern **„Opus baut nicht
aus Versehen"** — nicht, weil der Runner es beiläufig für eine gute Idee hält.
Genau das bleibt: Der Runner schaltet weiterhin nur über die Eskalation aus
ADR-0007 selbsttätig hoch. `model:opus` setzt ein Mensch, absichtlich, mit
Blick auf ein konkretes Ticket.

Die Deckel bleiben alle:

- Der **Opus-Tagesdeckel** (zwei Bau-Läufe je Ticket und Tag) greift
  unverändert, auch bei hand-gesetztem `model:opus`.
- `no-escalation` friert weiter ein — dann gilt die Startstufe aus dem Label,
  und der Runner schaltet nie selbst hoch.
- `opus-boost` bleibt unverändert der Weg, den Tagesdeckel einmalig zu heben.

## Eine Folge, die man kennen muss

`tierBump()` hat von Opus aus **keinen Sprung mehr**. Ein Ticket, das mit
`model:opus` startet, hat die Leiter also schon oben betreten: Bleiben drei
Läufe erfolglos, meldet der Runner „Stufe erschöpft", setzt `needs-answer` und
hört auf.

Das ist gewollt. Wenn Opus dreimal nicht weiterkommt, ist die Antwort nicht ein
viertes Modell — die gibt es nicht —, sondern ein anderer Zuschnitt des
Tickets. Diese Entscheidung gehört einem Menschen.

## Sichtbarkeit

Das Status-Issue nennt ab jetzt die **aktuelle** Stufe („arbeitet an #266,
Stufe: opus"). Damit ist der Unterschied zwischen „hier steht `model:sonnet`"
und „hier läuft gerade Opus, weil zweimal eskaliert wurde" vom Handy aus
sichtbar, ohne dass ein zweiter Zustand aufs Board wandert.

Der laufende Zustand bleibt bewusst in `.runner/tier-<nr>`: Er ändert sich
mitten im Lauf, gehört dem Runner und nicht dem Menschen — ein Label, das der
Runner selbst umsetzt, hätte genau die Doppeldeutigkeit erzeugt, die #264
gerade abschafft.

## Alternativen, die wir nicht genommen haben

**Nur `model:opus`, kein `model:sonnet`.** Hätte gereicht, um die Eskalation
abzukürzen, aber nicht, um eine Denk-Rolle billiger zu machen. Drei Labels sind
eine vollständige, langweilige Menge; zwei wären eine Ausnahmeregel.

**Die Stufe als Label führen, statt in `tier-<nr>`.** Dann schreibt der Runner
Labels, die wie menschliche Anweisungen aussehen. Genau diese Vermischung
räumt #264 gerade weg.

**Alles beim Alten lassen und drei Fehlläufe in Kauf nehmen.** Das ist die
ehrliche Nullvariante — sie kostet nur jedes Mal, wenn man es vorher besser
wusste.
