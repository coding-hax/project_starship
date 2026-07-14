# Vision

## Warum

Termine, Aufgaben, Journal und Gewohnheiten liegen heute in vier verschiedenen Apps,
die nichts voneinander wissen. Ziel ist **ein Ort für den Tag**: was ansteht, was zu tun ist,
was ich festhalten will, und was ich mir vorgenommen habe — in einer Oberfläche,
die sich schnell und leicht anfühlt und auf die ich jeden Tag freiwillig schaue.

## Für wen

Für **genau eine Person**. Es gibt keine anderen Nutzer, keine Rollen, keine Rechte,
keine Einladungen, keine Mandantentrennung. Das ist eine Feature-Entscheidung,
kein Zwischenstand — sie darf die Architektur radikal vereinfachen.

## Produktprinzipien

1. **Sofort, immer.** Jede Interaktion antwortet in unter 100 ms, weil sie lokal passiert.
   Es gibt keine Ladespinner für eigene Daten. Netz ist ein Hintergrundthema, kein Blocker.
2. **Ein Ort für den Tag.** Das „Heute"-Dashboard ist die Startseite und führt Termine,
   fällige Aufgaben, Habits und den Journal-Impuls zusammen.
3. **Lebensfroh, nicht laut.** Warme, klare Farben. Bewegung, die Zusammenhänge erklärt,
   nicht Bewegung, die beeindrucken will.
4. **Meine Daten bleiben meine.** Journal-Inhalte sind Ende-zu-Ende-verschlüsselt.
   Jederzeit vollständiger Export. Kein Format, aus dem ich nicht wieder herauskomme.
5. **Wenig, aber richtig.** Lieber vier Bereiche, die exzellent funktionieren,
   als zwölf halbe. Jedes Feature muss sich gegen „weglassen" verteidigen.

## Nicht-Ziele (ausdrücklich)

Diese Dinge bauen wir **nicht**, und Vorschläge in diese Richtung werden abgelehnt:

- Mehrbenutzer, Teilen, Kommentare, Kollaboration
- Öffentliche Registrierung, Onboarding-Flows, Marketing-Seiten
- Monetarisierung, Abos, Zahlungsabwicklung
- Native iOS-App im App Store (siehe ADR-0001)
- Zwei-Wege-Sync mit externen Kalendern (iCloud, Google) — siehe ADR-0002
- Team-/Projektmanagement, Gantt, Zeiterfassung, Rechnungen
- Social-Features, Gamification-Ranglisten, Streak-Wettbewerbe
- KI-Funktionen „weil man kann" — KI nur dort, wo sie Tipparbeit spart (Sprachmemo)

## Bereiche

**Aufgaben** — schnelles Erfassen, Fälligkeitsdatum, Priorität, Erledigen per Swipe.
**Termine** — Tages-/Wochenansicht, eigenständiger Kalender. **Kein Sync mit iCloud oder Google.**
**Journal** — täglicher Eintrag, freier Text, Stimmung, Tags, lokale Volltextsuche. Ende-zu-Ende-verschlüsselt.
**Gewohnheiten** — tägliche/wöchentliche Habits, Abhaken, Streaks, Wochenübersicht.
**Heute** — das Dashboard, das alles zusammenführt.

## Roadmap (strikt sequenziell)

| Milestone              | Inhalt                                                                                              | Fertig, wenn                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **M0** Fundament       | Repo, CI, Passkey-Login, Design-Tokens, App-Shell, PWA-Installierbarkeit, Sync-Grundgerüst (Outbox) | App lässt sich auf dem iPhone installieren, Login per Face ID, leere Tabs |
| **M1** Aufgaben        | CRUD, Fälligkeit, Priorität, Swipe-Erledigen, offline                                               | Aufgabe offline anlegen, online wiederfinden                              |
| **M2** Termine (lokal) | Tages-/Wochenansicht, CRUD, Serientermine (RRULE)                                                   | Termine funktionieren vollständig ohne externen Kalender                  |
| **M3** Journal         | Editor, Stimmung, Tags, lokale Suche, E2E-Verschlüsselung                                           | Server kennt keinen Klartext                                              |
| **M4** Gewohnheiten    | Habits, Abhaken, Streaks, Wochenraster                                                              | Streak über Tageswechsel korrekt                                          |
| **M5** Heute-Dashboard | Zusammenführung, Web Push für Erinnerungen                                                          | Eine Ansicht ersetzt alle Tabs                                            |
| **M6** Sprachmemo      | Aufnahme → Transkript → strukturierter Terminvorschlag mit Bestätigung                              | „Termin am 4.8. bei Dr. XY" wird korrekt zum Termin                       |

## Erfolgskriterien

- Ich öffne die App täglich, ohne mich dazu zwingen zu müssen.
- Eine Aufgabe erfassen dauert unter 5 Sekunden.
- Die App funktioniert im Zug ohne Netz.
- Ich habe alle vier alten Apps vom Home-Screen gelöscht.

## Entschieden (2026-07-14)

Diese Punkte standen als Annahme im Raum und sind nach dem Bootstrap beantwortet.
Sie werden nicht in jedem Ticket neu diskutiert.

- **Habits** sind **binär** (erledigt / nicht erledigt) mit Streak. Mengenziele
  („3 Liter Wasser") kommen erst, wenn sie im Alltag fehlen — sie ließen sich additiv
  ergänzen, ohne Bestehendes zu brechen.
- **Journal:** Text, Stimmung **und Tags** liegen gemeinsam in **einem** Chiffrat.
  Nur `entry_date` bleibt im Klartext. Siehe **ADR-0004** — das ersetzt den
  Metadaten-Absatz aus ADR-0001 §4. Folge: keine serverseitige Filterung über
  Journalinhalte. Kein Verlust, weil in einer Local-first-App ohnehin lokal gefiltert wird.
- **Wiederkehrende Aufgaben** kommen **nicht** in M1. M1 macht Aufgaben richtig gut
  (erfassen, Fälligkeit, Priorität, Swipe, offline). Wiederholung wird ein eigenes
  Ticket, sobald sie fehlt. Die Spalte `recurrence_rule` bleibt im Schema reserviert.
- **Erinnerungen** laufen über **Web Push ab M5**, nicht früher und nicht über E-Mail.
- **Serientermine** werden in M2 in einfacher Form unterstützt (täglich/wöchentlich/
  monatlich, mit Enddatum). Verschobene oder ausgefallene Einzeltermine einer Serie
  sind ein eigenes, späteres Ticket — ohne Kalender-Sync brauchen wir die volle
  RRULE-Komplexität nicht.
- **UI-Sprache Deutsch**, Wochenstart Montag, 24-Stunden-Format.
