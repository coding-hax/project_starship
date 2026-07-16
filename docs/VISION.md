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

**„Heute" ist keine eigene Phase, sondern eine Klammer.** Jeder Milestone ergänzt seine
eigene Heute-Sektion — so ist das Kernversprechen „ein Ort für den Tag" ab M1 nutzbar und
wächst mit, statt am Ende in einem großen Dashboard-Milestone zusammengeklebt zu werden.

| Milestone                      | Inhalt                                                                                                                                                                 | Heute-Sektion                | Fertig, wenn                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------- |
| **M0** Fundament ✅            | Repo, CI, Passkey-Login, Design-Tokens, App-Shell, PWA-Installierbarkeit, Sync-Grundgerüst (Outbox)                                                                   | —                            | Installierbar auf dem iPhone, Login per Face ID, leere Tabs                   |
| **M1** Sync-Härtung + Aufgaben | `storage.persist()`, Delete-gewinnt-Regel + Server-Sequenz **jetzt, solange die DB leer ist (Migration gratis)**; Aufgaben-CRUD, Fälligkeit, Priorität, Swipe, offline | zeigt (nur) Aufgaben         | Aufgabe offline anlegen/wiederfinden; Konflikt- und Delete-Semantik getestet |
| **M2** Gewohnheiten            | Habits binär, Abhaken, Streaks, Wochenraster — kleinstes Datenmodell, schneller Win, tägliche Nutzung                                                                 | + Streaks                    | Streak über Tageswechsel korrekt                                             |
| **M3** Push & Erinnerungen     | Web Push; fällige Aufgaben morgens, Streak-Erinnerung abends — Aufgaben + Habits **sind** die Use-Cases; **Ersatz für den GitHub-Actions-Cron**                        | —                            | Erinnerung kommt zuverlässig, ohne dass die App offen ist                    |
| **M4** Journal (E2EE)          | Editor, Stimmung, Tags, lokale Suche, Ende-zu-Ende-Verschlüsselung — Sync ist jetzt 2× bewiesen, Verschlüsselung sicher obendrauf                                      | + „heute schon geschrieben?" | Server kennt keinen Klartext                                                  |
| **M5** Termine (lokal)         | Tages-/Wochenansicht, CRUD, Serientermine **inkl. verschobener/ausgefallener Einzeltermine (Ausnahmen) von Anfang an** — härteste Domäne, kommt zuletzt                | + Termine des Tages          | Termine vollständig ohne externen Kalender, Serien-Ausnahmen korrekt         |
| **M6** Sprachmemo              | Aufnahme → Transkript → strukturierter Vorschlag mit Bestätigung — nach der #47-Recherche, wenn die Privacy-Frage geklärt ist                                          | —                            | „Termin am 4.8. bei Dr. XY" wird korrekt zum Termin                          |

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
  (erfassen, Fälligkeit, Priorität, Swipe, offline) — plus die Sync-Härtung. Wiederholung
  wird ein eigenes Ticket, sobald sie fehlt. Die Spalte `recurrence_rule` bleibt reserviert.
- **UI-Sprache Deutsch**, Wochenstart Montag, 24-Stunden-Format.

## Geändert (2026-07-16)

Roadmap nach externem Review neu sortiert. Zwei Umbauten und drei Verschiebungen — die
Produktprinzipien bleiben unberührt, nur Reihenfolge und Zuschnitt ändern sich.

- **„Heute" wird Klammer statt Phase.** Der frühere M5-Dashboard-Milestone ist aufgelöst;
  jeder Milestone liefert seine eigene Heute-Sektion (siehe Spalte oben). Das Kernversprechen
  ist ab M1 nutzbar, nicht erst am Ende.
- **Sync-Härtung zieht nach M1 vor — jetzt, solange die DB leer ist.** `storage.persist()`,
  die Delete-gewinnt-Regel und die server-monotone Sequenz (statt Konfliktauflösung über
  Client-Uhren) werden gebaut, bevor echte Daten existieren — dann ist die Migration gratis.
  (Tickets: #52, #53.)
- **Kalender/Termine wandern von M2 ganz nach hinten (M5).** Härteste Domäne, kommt zuletzt.
  Die frühere Vereinfachung „Serien-Ausnahmen sind ein späteres Ticket" wird **bewusst
  aufgehoben**: verschobene und ausgefallene Einzeltermine einer Serie werden in M5 **von
  Anfang an** gebaut, weil der Milestone ohnehin die schwierigste Domäne einmal richtig macht.
- **Erinnerungen werden ein eigener Milestone M3 (vorher „Web Push ab M5").** Aufgaben und
  Habits sind genau die Reminder-Use-Cases (fällige Tasks morgens, Streak-Erinnerung abends),
  also folgt Push direkt darauf. Ersetzt zugleich den GitHub-Actions-Cron.
- **Sprachmemo (M6)** bleibt zuletzt und startet erst nach der #47-Recherche (Privacy geklärt).
