# Formwahl & Zustände

Die anderen Design-System-Dateien regeln **Werte** — Farbe, Abstand, Radius,
Motion. Sie regeln nicht die **Formwahl**: welche Grundform ein Screen
überhaupt bekommt. Genau dort ist `/kalender` gescheitert — die Zeitachse als
Hauptfläche (issue #473) hat jede Wertregel eingehalten und ist trotzdem
falsch, weil sie bei drei Terminen **1440 px Gerüst zu 180 px Inhalt** zeigt.
Ein Token ist ein Wert, „Zeitachse als Hauptfläche" ist eine Form — diese
Regeln greifen eine Ebene früher und gelten für jeden künftigen Screen.

**R1 — Inhalt schlägt Gerüst.** Bei *typischer* Datenmenge muss die gewählte
Form überwiegend Inhalt zeigen, nicht Struktur. Typisch heißt: was diese eine
Person wirklich hat — drei Termine, nicht zwölf. Prüffrage vor dem Ticket:
„Wie sieht das bei drei Einträgen aus?"

**R2 — Die Form folgt der Frage.** Jeder Screen beantwortet *eine* Frage, in
einem Satz sagbar. „Was steht heute an?" ist eine Liste. „Wo ist zwischen 9
und 17 noch Lücke?" ist ein Raster. Wer die Frage nicht sagen kann, hat kein
Konzept.

**R3 — Jede Form braucht ein Zustimmungsargument.** Eine Entscheidung, die
nur begründet, was sie *ablehnt*, ist keine Entscheidung. Konzepte dürfen
eingefroren werden, müssen aber wieder aufgemacht werden, wenn das gebaute
Ergebnis ihnen widerspricht.

**R4 — „Spärlich" ist der fünfte Zustand.** Siehe [Zustände](#zustände).

## Zustände

Jede Ansicht braucht fünf gestaltete Zustände: **leer**, **spärlich**, **ladend**,
**Fehler**, **offline**.

Der Offline-Zustand ist kein Fehler, sondern eine ruhige Notiz („Änderungen werden gesendet,
sobald du wieder online bist"). Nichts blinkt rot, nur weil kein Netz da ist.

**Spärlich** ist der Normalfall dieser App — drei Termine in 24 Stunden, zwei
Aufgaben, ein Journaleintrag. Für „leer" gab es eine Vorschrift, für „voll"
implizit auch; für „fast leer" keine — deshalb hat ihn niemand entworfen.
Spärlich wird als ruhige Notiz gestaltet („Danach nichts mehr geplant."),
nicht als leeres Gerüst und nicht als aufgeblasener Leerzustand.

### Ladend gehört dem Screen, nicht dem einzelnen Block

**Ladend** ist der Zustand, der am leichtesten pro Komponente entschieden wird
und genau dann falsch ist. Jeder einzelne Block, der während seiner Live-Query
`null` rendert, tut das Richtige; sechs davon auf einem Screen antworten in
beliebiger Reihenfolge, und jeder klappt auf Kosten aller darunter auf — der
Layout-Shift aus Smooth-Regel 3, verschoben auf die erste Sekunde nach dem
Öffnen (issue #642).

Ein Skeleton je Block heilt das nicht, sondern dreht es um: Blöcke, die geladen
absichtlich *nichts* zeigen (Fortschrittsring bei M = 0, Streak-Karte ohne
aktive Routine, Monatsstreifen ohne Aktivitäten), müssten reservierte Höhe
wieder hergeben. Ein Kollaps schiebt so hart wie ein Pop-in.

Deshalb gilt: **ein Enthüllungspunkt je Screen.** Der Inhalt bleibt verborgen,
bis alle lokalen Blöcke einmal geantwortet haben, und erscheint dann gemeinsam
unterhalb dessen, was schon steht — Anfügen nach unten verschiebt per Definition
nichts. Das braucht keine geratene Höhe und entscheidet „Block vorhanden oder
nicht?", bevor zum ersten Mal Inhalt gemalt wird. Umgesetzt in
`src/ui/overview-ready.tsx`.

Was **nicht** in den Enthüllungspunkt gehört: alles, was an einem echten
Netz-Request hängt (das Wetter). Es darf den Screen nie aufhalten und behält
sein formgleiches Skeleton. Die Wartezeit ist damit ein IndexedDB-Lesen, kein
Roundtrip — Smooth-Regel 2 („keine Spinner für eigene Daten") bleibt gewahrt.
