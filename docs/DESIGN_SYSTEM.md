# Design System

Leitbild: **lebensfroh, warm, ruhig.** Die App darf gute Laune machen,
ohne dabei laut zu werden. Farbe trägt Bedeutung, sie ist keine Dekoration.

## Farben

Alle Farben in **OKLCH**, damit Helligkeit über die Farbtöne hinweg konsistent bleibt.

### Bereichsfarben (tragen die Orientierung)

| Bereich      | Farbe           | Rolle                    |
| ------------ | --------------- | ------------------------ |
| Aufgaben     | Koralle / Mango | Primärfarbe der App      |
| Termine      | Teal            | ruhig, strukturiert      |
| Journal      | Warmes Violett  | persönlich, introspektiv |
| Gewohnheiten | Sattes Grün     | Wachstum, Streaks        |
| Aktivitäten  | Blau            | Garmin, Strecke/Puls (issue #180) |

Jeder Bereich hat genau eine Akzentfarbe. Ein Element trägt genau eine Bedeutung.

### Kategoriefarben (Termine, issue #553)

Innerhalb des Bereichs Termine tragen die fünf Kategorien (`privat`, `arbeit`,
`gesundheit`, `sport`, `familie`) je einen eigenen Akzent — `--cat-privat` /
`--cat-arbeit` / `--cat-gesundheit` / `--cat-sport` / `--cat-familie`. Das sind
**keine** fünf gleichberechtigten Primärfarben, sondern Varianten um den
Teal-Ton der Bereichsfarbe (gleiche Helligkeit/Chroma, nur der Farbton wandert).
Sie erscheinen ausschließlich als 3px-Farbkante an der Terminkarte, nie als
Flächenfarbe — die Fläche bleibt `--surface`. Ein Termin ohne Kategorie trägt
stattdessen `--area-events`.

### Neutrale

- Hintergrund hell: **warmes Off-White**, niemals reines `#FFFFFF`
- Hintergrund dunkel: **warmes Anthrazit**, niemals reines `#000000`
- Text: hoher Kontrast, aber nie tiefschwarz auf weiß (WCAG AA als Minimum, AAA für Fließtext)

### Semantische Tokens

Komponenten benutzen **niemals** Rohfarben, sondern nur Tokens:
`--bg`, `--surface`, `--surface-raised`, `--text`, `--text-muted`, `--border`,
`--accent`, `--accent-fg`, `--success`, `--warning`, `--danger`.

Dark Mode ist keine Nachrüstung: jedes Token existiert in beiden Modi von Anfang an.

## Typografie

- Ein Font: **Inter Variable** (oder Geist). Kein zweiter Font ohne ADR.
- Zahlen immer mit `font-variant-numeric: tabular-nums` — sonst zappeln Uhrzeiten und Streaks.
- Skala: 12 / 14 / 16 / 20 / 24 / 32. Fließtext 16px, nie kleiner als 14px auf Mobile.
- Zeilenhöhe großzügig (1.5 für Text, 1.2 für Überschriften).

## Form & Raum

- Radien: **großzügig** (12–16px für Karten, 999px für Pills). Nichts wirkt kantig.
- Schatten: weich, tief liegend, niedrige Deckkraft. Keine harten Ränder.
- Spacing-Skala: 4 / 8 / 12 / 16 / 24 / 32 / 48. Nichts dazwischen.
- Karten statt Tabellen auf Mobile. Tabellen erst ab Desktop-Breakpoint.

## Ebenen

Jede schwebende Fläche nimmt eine benannte Stufe aus `src/ui/tokens.css`, nie eine
roh gewählte Zahl. Damit ist „liegt drüber / liegt drunter" eine Entscheidung im
Design-System, nicht das Ergebnis von DOM-Reihenfolge und Zufall (Anlass: #508,
die Bottom-Nav hatte gar kein `z-index` und wurde vom Seiteninhalt überdeckt).

| Token | Wert | Fläche |
|---|---|---|
| `--z-nav` | 10 | Bottom-Nav / Sidebar |
| `--z-fab` | 20 | Floating Action Button |
| `--z-toast` | 30 | Toast-Host |
| `--z-drag` | 40 | Drag-Caption |
| `--z-sheet` | 50 | Modales Sheet + Backdrop |

Stufen liegen in Zehnerschritten auseinander, damit später eine Ebene dazwischen
passt, ohne alle darüber neu zu nummerieren.

Das Sheet ist ein modaler `<dialog>` (`showModal()`) und liegt deshalb ohnehin in
der Top-Layer des Browsers — **über allem**, unabhängig von `z-index` und
DOM-Reihenfolge. `--z-sheet` erzeugt diese Garantie nicht, sondern dokumentiert sie
und ordnet das Sheet gegen künftige Top-Layer-Geschwister. Weil der Toast-Host im
normalen Layer liegt (also hinter dem Sheet-Backdrop), gilt: **ein offenes Sheet
liegt immer über einem Toast**, auch wenn `--z-toast` (30) kleiner ist als
`--z-sheet` (50) — das ist beabsichtigt, nicht ein Zahlendreher.

Ausnahme: `z-index: 1` innerhalb einer Komponente, die ihren eigenen
Stacking-Context nie verlässt (z. B. eine angehobene Karte während des Ziehens,
der aktive Segmented-Control-Button über seinem Indikator), bleibt eine rohe Zahl
mit Kommentar — das ist kein Teil dieser Skala.

Baust du eine neue schwebende Fläche: erst prüfen, ob sie in eine bestehende Stufe
passt. Braucht sie eine eigene, wird die Skala in `tokens.css` erweitert, nicht mit
einer freien Zahl umgangen.

## Motion

Bewegung erklärt Zusammenhänge — woher etwas kam, wohin es geht.

- Dauer: **150–250 ms**. Alles darüber fühlt sich träge an.
- Kurven: Spring (Motion-Default), kein lineares Easing.
- Erlaubt: Layout-Übergänge, Listen-Ein/Ausblenden, Sheet von unten, Erledigt-Häkchen.
- Verboten: Bounce-Effekte ohne Grund, Parallax, Animationen über 400 ms, alles was
  bei jeder Nutzung erneut abgespielt wird und dann nervt.
- **`prefers-reduced-motion: reduce` wird respektiert** — dann nur Opacity-Übergänge.

## Das „Smooth"-Versprechen

Diese vier Regeln sind nicht verhandelbar, sie sind das Produktversprechen:

1. **Optimistic UI.** Jede Aktion ist sofort sichtbar. Der Server holt auf.
2. **Keine Spinner für eigene Daten.** Daten liegen lokal. Skeletons nur beim allerersten Start.
3. **Kein Layout-Shift.** Platz wird vorher reserviert.
4. **60 fps beim Scrollen.** Keine teuren Schatten oder Filter auf Listenelementen.

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

Dieselbe App, kein zweites Design: Bottom-Nav wird zur **Sidebar**, Listen werden mehrspaltig.
Zusätzlich Tastaturkürzel (`n` = neu, `/` = suchen, `j`/`k` = navigieren).

## Zustände

Jede Ansicht braucht vier gestaltete Zustände: **leer**, **ladend**, **Fehler**, **offline**.
Der Offline-Zustand ist kein Fehler, sondern eine ruhige Notiz („Änderungen werden gesendet,
sobald du wieder online bist"). Nichts blinkt rot, nur weil kein Netz da ist.
