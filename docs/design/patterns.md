# Icon-Sprache, Mobile-Patterns & Desktop

## Icon-Sprache

Keine Icon-Library — der Satz lebt handgezeichnet in `src/ui/icons.tsx`, damit er als
Satz sichtbar bleibt und kein Kilobyte ungenutztes Set ins Bundle kommt (issue #125).
Ein neues Icon hält sich an dieselbe Form:

- 24×24 Viewbox, Strichstärke 1.5, `stroke-linecap`/`stroke-linejoin: round`.
- Kontur statt Fläche: `fill="none"`, `stroke="currentColor"` — Farbe kommt aus CSS,
  Aktiv-Akzent und Dark Mode brauchen keinen Sonderfall.
- Nie ein Unicode-Glyph: jedes System zeichnet die anders (Strichstärke, Grundlinie,
  auf iOS teils sogar farbig als Emoji).

## Mobile-Patterns

- **Bottom-Navigation**: fünf sichtbare Plätze, horizontal schiebbar (Karussell) sobald
  mehr Einträge existieren, Reihenfolge in den Einstellungen einstellbar (issue #205).
  Heutige Einträge: Übersicht · Aufgaben · Gewohnheiten · Kalender · Journal ·
  Aktivitäten (sechster Eintrag, issue #180 — löst das Karussell standardmäßig aus).
  Einstellungen ist kein Tab. Ab 768px bleibt es eine vertikale Sidebar-Liste ohne
  Karussell — dieselbe Reihenfolge, kein zweites Design.
- Touch-Ziele mindestens **44 × 44 px**.
- `env(safe-area-inset-*)` überall — die Navigation darf nicht unter dem Home-Indicator kleben.
- **Swipe-Gesten:** nach rechts = erledigen, nach links = verschieben/löschen. Immer mit Undo-Toast.

### Einstellungen-Einstieg (issue #126)

Der Einstieg zu Einstellungen ist **kein globaler Header.** Mobile (< 768px) hat er
genau eine Stelle: oben auf `/uebersicht`, rechtsbündig in einer Zeile mit der Überschrift
— als Teil des Seiteninhalts, nicht als eigene Zeile im App-Shell-Grid. Jeder andere
Screen beginnt direkt oben, ohne Kopfzeile. Ab `768px` hat die Sidebar Platz, dort
bleibt der Einstieg auf jedem Screen sichtbar (`.app-header--chrome`).

**Warum nicht einfach den Header überall zeigen und per Route verstecken:** Eine
Kopfzeile, die im App-Shell-Grid eine eigene Zeile belegt und je nach Route ein-
und ausblendet, verschiebt die Startposition von `main` beim Tab-Wechsel — genau
der Layout-Shift, den Smooth-Regel 3 verbietet. Deshalb lebt der mobile Einstieg
im Seiteninhalt von Übersicht selbst (`app-header--inline`), nicht im Shell-Grid; der
Desktop-Einstieg (`app-header--chrome`) ist dagegen immer an oder immer aus, nie
abhängig von der aktuellen Route — nur vom Breakpoint.

**Für den nächsten Screen:** Kein neuer Screen bekommt eine eigene Kopfzeile für
einen einzelnen Einstieg. Wenn mobil ein globaler Zugriff nötig scheint, gehört er
in die Bottom-Nav oder auf Übersicht — nicht in ein neues Header-Element.
- Neuer Eintrag über einen **Floating Action Button**, der ein Bottom-Sheet öffnet.
- Der Cursor springt beim Öffnen ins Textfeld. Erfassen darf keine Navigation kosten.

## Desktop

Dieselbe App, breiter — abgeleitet aus dem Hochformat, nie ein zweiter Entwurf
(Leitsatz, `docs/DESIGN_SYSTEM.md`). Bottom-Nav wird zur **Sidebar**, Listen
werden mehrspaltig. Zusätzlich Tastaturkürzel (`n` = neu, `/` = suchen, `j`/`k`
= navigieren).
