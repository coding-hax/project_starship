# Die Queue: das Label `next`

**Die Regel bleibt wörtlich (#91, umgebaut #109, #725/ADR-0023): Es gibt eine
Queue; ist sie leer, greift die Label-Kaskade.** Nur ist die Queue seit #725
„alle Tickets mit dem Label `next`" statt einer Zeilenreihenfolge in einem
angepinnten Queue-Issue.

```
1. in-progress    laufender Lauf
2. next           <- die Queue
3. plan
4. research
5. ready
```

Ein Ticket mit `next` **wird bearbeitet, vor jedem anderen ohne `next`** —
je ältestes `createdAt`, wenn mehrere Tickets `next` tragen. Das
**Rollenlabel bleibt daneben bestehen** und entscheidet, was passiert:
`plan` → Planlauf, `research` → Recherche, sonst Bau. `next` selbst sagt
nichts über die Rolle.

- **`next` fällt nicht mit dem Start eines Bau-Laufs weg** — nur `ready`
  wird abgenommen, wie bisher. `next` verschwindet erst mit dem Ticket
  selbst (Schließen/Merge).
- **Weiterhin ausgeschlossen:** `needs-answer` (wartet auf dich) und
  `hands-off` (Kill-Switch) — ein so markiertes Ticket wird auch dann nicht
  genommen, wenn es `next` trägt. Beide filtern **zentral, vor allen
  Zweigen** — das gilt für `next` genauso wie für `plan`/`research`/`ready`.
- **Sicherheit:** Ein versehentlich mit `next` markiertes, unfertiges Ticket
  wird gebaut. Einen Merge-Schutz für geschützte Pfade gibt es nicht mehr
  (#276, #283).
- **Kein `next`-Ticket → reiner Fallback**, also die Label-Kaskade
  `plan` → `research` → `ready`, je ältestes `createdAt`.

## `Nach:` im Ticket-Body

Die zweite Frage, die die alte Queue vermischte — „kommt dieses Ticket
überhaupt dran, oder wartet es auf ein anderes?" —, ist von `next` getrennt
und lebt seit #724 als eigene Zeile im TICKET-Body selbst:

```
Nach: #687
```

Zeilenanker (kein Fließtext-Trigger); mehrere Nummern je Zeile
(`Nach: #687 #690`) und mehrere `Nach:`-Zeilen sind erlaubt. Ausgewertet wird
bei **jeder** Auswahl gegen den offenen Bestand: Eine Voraussetzung gilt als
erfüllt, sobald ihr Ticket nicht mehr offen ist (beim Merge passiert das über
`Closes #` von selbst). Eine Nummer, die es gar nicht gibt, zählt ebenfalls
als erfüllt — ein Zahlendreher darf ein Ticket nicht still für immer
begraben.

- **`blocked-by` zeigt eine offene Voraussetzung am Ticket an** — gesetzt und
  wieder entfernt vom Runner, nicht von dir.
- **Zirkel** (`#1` nach `#2` und `#2` nach `#1`) meldet der Runner im
  Status-Issue; keins der beteiligten Tickets wird gebaut.
- **Wer `Nach:` schreibt:** der Planer, im selben Schritt, in dem er
  Kind-Tickets anlegt — er kennt die Reihenfolge, die er gerade selbst
  entworfen hat. Ein Mensch darf die Zeile jederzeit vom Handy aus in einen
  Body schreiben oder streichen.

Vom Handy aus setzt du die Priorität dafür nur noch als Label am Ticket —
kein Issue-Body zum Pflegen, kein Commit, kein Branch.

Einfache/mechanische Tickets (klarer CSS-Fix, Doku, Umbenennung) überspringen
`plan` und gehen direkt auf `ready` — der Planungsschritt würde hier nur
Tokens kosten, ohne die Ausführung konkreter zu machen.

**Kein extra Code-Änderungsbedarf am Runner für den Fallback:** Ohne `next`
gilt weiterhin die Label-Kaskade — ein Ticket mit `plan` oder `research` und
ohne `ready` liegt dort automatisch still, auch ohne eigene Guard-Logik.
Trägt das Ticket dagegen `next`, entscheidet allein dieses Label die
Reihenfolge; das Rollenlabel ist dann nur noch für die **Rolle** relevant
(Plan/Recherche/Bau), nicht mehr für die Auswahl.

## Was mit #725 verschwunden ist

Das angepinnte Queue-Issue (#92) samt Zeilenreihenfolge (`- #NN`), der
Meldung „In der Queue erledigt, kannst du streichen" und der Meldung über
nicht gelistete `ready`-Tickets — siehe [ADR-0023](../adr/0023-queue-verschwindet-als-ort.md)
für die Begründung. Issue #92 selbst ist geschlossen, nicht gelöscht.
