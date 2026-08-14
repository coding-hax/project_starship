# ADR-0023: Die Queue verschwindet als Ort, nicht als Regel

Status: angenommen
Datum: 2026-08-14
Ersetzt: die Prioritäts-Queue aus #91 / #109 / #265 (Issue #92)
Bezug: [ADR-0013](0013-modellstufe-am-ticket.md), [ADR-0014](0014-mehrere-runner-slots.md)

## Kontext

Die Auswahlreihenfolge des Runners steht seit #91 im Body eines angepinnten
Issues (#92). Dieser Body liefert **zwei verschiedene Dinge in einer Syntax**:

- **Rang** — die Zeilenreihenfolge. `- #683` ganz oben heißt: vor allem anderen.
- **Kette** — `- #688 nach #687`. Eine Voraussetzung, bei jeder Auswahl neu
  bewertet.

Das hat funktioniert. Bezahlt wurde es mit Pflege, und die Pflege ist die
eigentliche Rechnung:

- **Erledigte Zeilen bleiben stehen**, bis ein Mensch sie streicht. Der Runner
  meldet jeden Takt, was weg kann — eine Aufgabe, die es ohne die Liste gar
  nicht gäbe.
- **Nur `- #` am Zeilenanfang zählt** (#265). Die Regel ist so scharf, weil
  eine frühere Fassung jede Raute im Fließtext als Eintrag las und dabei drei
  Tickets einreihte, die niemand freigegeben hatte.
- **Die Ketten stehen zweimal da**: als `nach`-Klausel in der Liste und als
  Prosa in den Notizen darunter. Gelesen wird nur die erste.

Und dann der Fall, der die Rechnung aufmacht: **Die Kette ist eine Eigenschaft
des Tickets, steht aber woanders.**

Am 13.08.26 liefen #704, #705 und #706 gleichzeitig auf drei Slots, obwohl ihre
Reihenfolge in allen drei Plan-Kommentaren stand — maschinenlesbar war sie
nirgends. #702 fand seine Voraussetzung nicht in `main` und endete nach drei
Läufen und einer Opus-Eskalation mit `needs-answer`, ohne eine Zeile Code.

Der Planer **weiß** die Reihenfolge. Er schreibt sie in den Plan-Kommentar.
Danach muss ein Mensch sie in ein zweites Dokument übertragen, sonst gilt sie
nicht. Genau dieser Übertragungsschritt fällt aus, wenn niemand am Rechner
sitzt — und er fällt still aus.

## Entscheidung

**Der Ordnungszustand wandert an die Tickets. Das Queue-Issue entfällt.**

Zwei Träger, je einer für die zwei Fragen, die #92 vermischt hat:

| Frage | heute | ab jetzt |
| --- | --- | --- |
| Kommt #688 überhaupt dran? | `- #688 nach #687` in #92 | `Nach: #687` im Body von #688 |
| Kommt #683 zuerst dran? | Zeile 1 in #92 | Label `next` an #683 |

**Die Regel bleibt wörtlich stehen:** Es gibt eine Queue; ist sie leer, greift
die Label-Kaskade. Nur ist die Queue jetzt „alle Tickets mit `next`" statt
„alle Zeilen in #92".

```
1. in-progress    laufender Lauf
2. next           <- die Queue
3. plan
4. research
5. ready
```

Je ältestes `createdAt`, wie gehabt. Ketten filtern **zentral, vor allen
Zweigen** — ein wartendes Ticket rutscht auch nicht über `in-progress` oder
`ready` herein. Das ist unverändert die Lehre aus #266.

### `Nach:` im Ticket-Body

```
Nach: #687
```

Zeilenanker; mehrere Nummern je Zeile (`Nach: #687 #690`) und mehrere
`Nach:`-Zeilen sind erlaubt. Fließtext („… läuft erst nach #687") triggert
**nicht** — dieselbe Vorsicht wie bei `ENTRY_LINE`, aus demselben Grund.

Ausgewertet wird bei **jeder** Auswahl gegen den offenen Bestand: Eine
Voraussetzung gilt als erfüllt, sobald ihr Ticket nicht mehr offen ist. Beim
Merge passiert das über `Closes #` von selbst. Eine Nummer, die es gar nicht
gibt, zählt ebenfalls als erfüllt — ein Zahlendreher darf ein Ticket nicht
still für immer begraben (unverändert aus #265).

### Wer `Nach:` schreibt

**Der Planer**, im selben Schritt, in dem er Kind-Tickets anlegt. Er ist der
Einzige, der die Reihenfolge kennt, und der einzige Lauf, der überhaupt noch
Tickets anlegt (CLAUDE.md, Regel 2). Damit entsteht die Reihenfolge dort, wo
sie gedacht wird, statt später von Hand übertragen zu werden.

Ein Mensch darf die Zeile jederzeit vom Handy aus in einen Body schreiben oder
streichen. Er **muss** es nicht mehr.

## Warum der Stand nicht in den Runner wandert

Der naheliegende Gegenvorschlag ist, die Reihenfolge lokal zu halten — eine
Datei in `.runner/`, gepflegt vom Runner selbst. Das wäre falsch, und zwar aus
vier Gründen, von denen der letzte allein reicht:

- **Unsichtbar.** Der Rechner läuft unbeaufsichtigt, der Mensch sieht unterwegs
  nur GitHub. Genau diesen Fehler benennt ADR-0013 an `tier-<nr>` und gleicht
  ihn über das Status-Issue wieder aus.
- **Geteilt.** Drei Slots (ADR-0014) sind drei Arbeitsbäume mit je eigenem
  `.runner/`. Ein gemeinsamer Rang bräuchte eine weitere Stelle, die zwischen
  ihnen konsistent bleiben muss.
- **Verlierbar.** Ein Rechner-Reset nimmt den Stand mit, während die Tickets
  weiterleben.
- **Veraltbar.** Ein geschriebener Rang ist eine Behauptung über die
  Vergangenheit. Die heutige Ketten-Auswertung ist es ausdrücklich nicht: Sie
  fragt bei jeder Auswahl neu, ob ein Ticket noch offen ist. Genau deshalb muss
  nach einem Merge nie jemand nachpflegen — und genau das gäbe eine Datei auf.

Der Zustand bleibt also dort, wo er ohnehin schon wahr ist: an den Tickets.

## Alternativen, die wir nicht genommen haben

**Ein Project-Board als Queue.** Echter feiner Rang per Drag & Drop, kein
Handpflege-Body. Kostet einen `read:project`-Scope am Token, `gh project
item-list` als neue Abhängigkeit mitten im Auswahlpfad — und ist am Handy
fummelig zu sortieren. Vor allem bleibt es eine Oberfläche, die gepflegt werden
will; genau die soll weg.

**Feiner Rang über Zahlen-Labels (`p0`, `p1`, `p2`).** Mehr Ordnung, als je
gebraucht wurde. Über die gesamte Lebensdauer von #92 gab es genau einen Fall
von „das hier zuerst", der nicht schon aus einer Kette folgte: #683, der Flake,
der fremde PRs rot machte. Ein Label reicht dafür. Drei wären eine Ordnung, die
niemand pflegt — und die deshalb irgendwann lügt.

**Das Queue-Issue behalten und nur die Ketten ans Ticket ziehen.** Dann liegt
der Rang weiter in einem Body, der gestrichen werden will, und die Auswahl
liest zwei Quellen statt einer. Die halbe Pflege bliebe, die ganze Komplexität
auch.

## Was mit dem Umbau verschwindet

- `QUEUE_ISSUE` als Konfiguration, samt dem Abruf je Takt
- `queueEntries()` mit `ENTRY_LINE`, `queueOrderFlat()`, `queueDone()`
- Die Meldung „In der Queue erledigt, kannst du streichen"
- Die Meldung über nicht gelistete `ready`-Tickets (#265) — ohne Liste kann
  nichts mehr an ihr vorbei verhungern
- Die Sonderformulierung „Queue: …" gegen „Offen: …" im Status (#296)

Was bleibt: `blocked-by` (vom Runner gesetzt und entfernt, nie von Hand), die
Zirkel-Meldung im Status-Issue, `queuePending()`, `untriaged()` — und die
Kaskade selbst.

Issue #92 wird **geschlossen, nicht geleert.** Ein leeres, angepinntes
Queue-Issue ist eine Einladung, wieder etwas hineinzuschreiben.

## Umsetzung

In zwei Schritten, damit zu keinem Zeitpunkt eine Kette unbewacht ist:

1. **#724** — `Nach:` am Ticket. Ketten aus Queue-Body und Ticket-Bodies werden
   **vereinigt** ausgewertet; der Rang bleibt vorerst im Queue-Issue.
   Rückwärtskompatibel: Fällt der neue Parser aus, gilt exakt das heutige
   Verhalten.
2. **#725** — `next` als Rang, `QUEUE_ISSUE` und der Listen-Apparat fallen weg,
   #92 wird geschlossen.
