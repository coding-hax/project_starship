# Form, Ebenen & Motion

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

### Ausnahme: Wetter-Icons (issue #661)

Die sieben Wetter-Icons (`src/features/weather/weather-icon-motion.css`) tragen eine
dauerhafte, sehr kleine Umgebungsbewegung — Sonne pulsiert, Wolken ziehen, Tropfen und
Flocken fallen, der Blitz zuckt. Das weicht bewusst von allen drei Motion-Regeln oben
ab: Dauern liegen zwischen 1,4 s und 7 s statt 150–250 ms, die Kurven sind
`linear`/`ease-in-out` statt Spring, und bei `prefers-reduced-motion`/dem App-Schalter
steht die Bewegung ganz still statt auf einen Opacity-Übergang umzuschwenken (über die
globale Regel in `tokens.css`, die jede `animation-duration` nullt — keine eigene
Opacity-Variante nötig).

Begründung: diese Bewegung erklärt keine Herkunft (Regel „Bewegung erklärt
Zusammenhänge" gilt hier nicht), sie ist Atmosphäre — dasselbe Argument, mit dem ein
Wetter-Widget auf einem Sperrbildschirm ziehende Wolken zeigt. Kein Bounce, kein
Parallax, nichts, was bei jeder Nutzung erneut nervt: die Bewegung ist so klein
(max. 3,5 Einheiten in einer 24er-viewBox), dass sie beim Hinsehen aktiv, beim
Vorbeischauen unauffällig ist.

### Ausnahme: Hintergrundkreise (S3 von #828, issue #829)

Die vier Kreise hinter jeder Route (`src/ui/background-circles.css`) tragen dieselbe
Art Ausnahme wie die Wetter-Icons oben, nur noch trägeren: Dauern liegen zwischen 7 s
und 40 s statt 150–250 ms, die Kurven sind `linear`/`ease-in-out` statt Spring. Bei
`prefers-reduced-motion`/dem App-Schalter steht die Bewegung ganz still (`animation:
none !important`, eigene Regel statt der globalen Duration-Nullung — AK4 prüft
`animationName === 'none'`, nicht nur eine Dauer nahe null).

Begründung: dieselbe Atmosphäre-Ausnahme wie bei den Wetter-Icons — die Kreise
erklären keine Herkunft, sie geben der vollflächigen Seitenfarbe (S1 von #828) Tiefe.
Kein Bounce, kein Parallax: die Töne weichen nur wenig vom Seitengrund ab
(`color-mix` auf `var(--ground)`), die Bewegung bleibt langsam genug, um beim
Vorbeischauen unauffällig zu sein.

## Das „Smooth"-Versprechen

Diese vier Regeln sind nicht verhandelbar, sie sind das Produktversprechen:

1. **Optimistic UI.** Jede Aktion ist sofort sichtbar. Der Server holt auf.
2. **Keine Spinner für eigene Daten.** Daten liegen lokal. Skeletons nur beim allerersten Start.
3. **Kein Layout-Shift.** Platz wird vorher reserviert.
4. **60 fps beim Scrollen.** Keine teuren Schatten oder Filter auf Listenelementen.
