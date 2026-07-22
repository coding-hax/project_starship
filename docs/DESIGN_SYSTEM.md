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

Jeder Bereich hat genau eine Akzentfarbe. Ein Element trägt genau eine Bedeutung.

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

- **Bottom-Navigation**, 5 Tabs: Heute · Aufgaben · Gewohnheiten · Kalender · Journal. Einstellungen ist kein Tab — der Einstieg sitzt im Header.
- Touch-Ziele mindestens **44 × 44 px**.
- `env(safe-area-inset-*)` überall — die Navigation darf nicht unter dem Home-Indicator kleben.
- **Swipe-Gesten:** nach rechts = erledigen, nach links = verschieben/löschen. Immer mit Undo-Toast.
- Neuer Eintrag über einen **Floating Action Button**, der ein Bottom-Sheet öffnet.
- Der Cursor springt beim Öffnen ins Textfeld. Erfassen darf keine Navigation kosten.

## Desktop

Dieselbe App, kein zweites Design: Bottom-Nav wird zur **Sidebar**, Listen werden mehrspaltig.
Zusätzlich Tastaturkürzel (`n` = neu, `/` = suchen, `j`/`k` = navigieren).

## Zustände

Jede Ansicht braucht vier gestaltete Zustände: **leer**, **ladend**, **Fehler**, **offline**.
Der Offline-Zustand ist kein Fehler, sondern eine ruhige Notiz („Änderungen werden gesendet,
sobald du wieder online bist"). Nichts blinkt rot, nur weil kein Netz da ist.
