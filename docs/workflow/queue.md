# Die Prioritäts-Queue

**Die Prioritäts-Queue (#91, umgebaut #109) — eine flache Reihenfolge, Label egal:**
Das angepinnte **Queue-Issue** (`QUEUE_ISSUE`) ist eine schlichte, geordnete Liste von
`#NN`. **Wer gelistet ist, wird bearbeitet — in genau dieser Reihenfolge**, ganz ohne
`ready` zu setzen. Das Eintragen in die Queue **ersetzt** die `ready`-Freigabe.

```
- #101
- #98 nach #101
- #104
```

Zahlen oben = zuerst. Wichtig:

- **Nur Zeilen, die mit `- #` beginnen, zählen** (seit #265) — und zwar ohne
  Einrückung, direkt am Zeilenanfang. Alles andere ist Notiz: Überschriften,
  Fließtext, Tabellen und **eingerückte** Beispiele dürfen wieder ganz normal
  Ticketnummern mit Raute enthalten. Vorher zählte **jede** `#NN` im Body, auch
  die in Notizen; dagegen half nur eine Warnung im Issue, an die jemand denken
  musste. Der Irrtum geht jetzt in die sichere Richtung: ein versehentlich
  eingerückter Eintrag wird **nicht** gebaut, und das fällt im Status auf.
- **Die erste Nummer der Zeile ist der Eintrag, jede weitere eine
  Voraussetzung.** `- #98 nach #101` heißt: #98 kommt erst dran, wenn #101
  **geschlossen** ist (beim Merge passiert das über `Closes #` von selbst).
  Bewertet wird bei **jeder** Auswahl neu — nach einem Merge ist also nichts
  nachzulabeln. Das Wort zwischen den Nummern (`nach`, `braucht`, …) ist reine
  Lesbarkeit und wird nicht ausgewertet.
- **`blocked-by` zeigt es am Ticket an** — gesetzt und wieder entfernt vom
  Runner, nicht von dir. Eine Voraussetzung, die es gar nicht gibt (Tippfehler),
  zählt als erfüllt: ein Zahlendreher soll ein Ticket nicht still für immer
  begraben.
- **Zirkel** (`- #1 nach #2` und `- #2 nach #1`) meldet der Runner im
  Status-Issue; keins der beteiligten Tickets wird gebaut.
- **Das Label ist für die Auswahl egal.** Ein gelistetes Ticket wird bearbeitet, auch
  ohne `ready`. Die **Rolle** kommt weiter aus dem Label: `plan` → Planlauf,
  `research` → Recherche, **sonst bauen**.
- **Weiterhin ausgeschlossen:** `needs-answer` (wartet auf dich) und `hands-off`
  (Kill-Switch) — ein so markiertes Ticket wird auch dann nicht genommen, wenn es
  gelistet ist.
- **Sicherheit:** Weil die Liste das Freigabesignal ist, wird ein versehentlich
  gelistetes, unfertiges Ticket gebaut. Einen Merge-Schutz für geschützte Pfade gibt es nicht mehr (#276, #283).
- **Nicht Gelistetes** läuft über den Fallback: die bisherige Label-Reihenfolge
  (`plan` → `research` → `ready`, je ältestes `createdAt`). Solange die Liste
  etwas Baubares enthält, kommt davon allerdings nichts dran — deshalb **nennt
  das Status-Issue jedes nicht gelistete `ready`-Ticket**, damit dir das nicht
  wochenlang entgeht (#265).
- **Erledigte Einträge** bleiben stehen, bis **du** sie streichst. Der Runner
  schreibt das Queue-Issue nicht um; er weist im Status aus, was weg kann.
- **Leeres/fehlendes Queue-Issue → reiner Fallback**, also das bisherige Verhalten.

Vom Handy aus editierst du dafür nur den Issue-Body — kein Commit, kein Branch.

Einfache/mechanische Tickets (klarer CSS-Fix, Doku, Umbenennung) überspringen
`plan` und gehen direkt auf `ready` — der Planungsschritt würde hier nur
Tokens kosten, ohne die Ausführung konkreter zu machen.

**Kein extra Code-Änderungsbedarf am Runner für den Fallback:** Ohne
Queue-Eintrag gilt weiterhin die Label-Kaskade — ein Ticket mit `plan`
oder `research` und ohne `ready` liegt dort automatisch still, auch ohne
eigene Guard-Logik. Ist das Ticket dagegen gelistet, entscheidet allein die
Reihenfolge in der Queue (siehe oben); das Label ist dann nur noch für die
**Rolle** relevant (Plan/Recherche/Bau), nicht mehr für die Auswahl.
