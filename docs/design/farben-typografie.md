# Farben, Typografie & Komposition

## Farben

Warmes Off-White statt reinem Weiß, warmes Anthrazit statt Schwarz: das bleibt
— unabhängig vom Leitsatz (`docs/DESIGN_SYSTEM.md`), der „simpel, modern" statt
„lebensfroh" verlangt. Die warmen Neutralen sind eine Eigenschaft der Palette,
kein Ableger einer Stimmung. Bereichs- und Kategoriefarben ändern sich dadurch
nicht.

Alle Farben in **OKLCH**, damit Helligkeit über die Farbtöne hinweg konsistent bleibt.

### Bereichsfarben (tragen die Orientierung)

| Bereich     | Farbe           | Rolle                             |
| ----------- | --------------- | --------------------------------- |
| Aufgaben    | Koralle / Mango | Primärfarbe der App               |
| Termine     | Teal            | ruhig, strukturiert               |
| Journal     | Warmes Violett  | persönlich, introspektiv          |
| Routinen    | Sattes Grün     | Wachstum, Streaks                 |
| Aktivitäten | Blau            | Garmin, Strecke/Puls (issue #180) |
| Wetter      | Teal-Cyan       | Vorhersage (issue #652)           |

Jeder Bereich hat genau eine Akzentfarbe. Ein Element trägt genau eine Bedeutung.

### Frei wählbare Nutzerfarben (`--swatch-*`, issue #658)

Wo eine Person aus mehreren gleichrangigen Optionen wählt — aktuell die
Routinen-Farbe, ab #660 auch Kategoriefarben in den Einstellungen — reichen
die fünf Bereichsfarben nicht: sie tragen woanders schon eine feste Bedeutung
und stünden zur Auswahl in Konkurrenz zu sich selbst. Die zehn Optionen des
Routinen-Farbwählers sind deshalb die fünf Bereichsfarben (`--area-tasks`,
`--area-events`, `--area-journal`, `--area-habits`, `--area-activities`) plus
fünf neue `--swatch-*`-Tokens, die es sonst nirgends in der App gibt:

| Token | Label | Farbton (hell) |
| --- | --- | --- |
| `--swatch-rose` | Rosé | 12 |
| `--swatch-amber` | Bernstein | 75 |
| `--swatch-lime` | Limette | 118 |
| `--swatch-sky` | Himmelblau | 228 |
| `--swatch-magenta` | Magenta | 335 |

Die fünf Farbtöne füllen die Lücken zwischen den Bereichsfarben (Hue-Abstände
30–47°, keine zwei Nachbarn verwechselbar) — bezogen auf genau diese zehn
Optionen des Farbwählers. `--area-weather` (issue #652) ist kein Teil dieser
zehn, teilt sich den Farbkreis aber mit ihnen: die naheliegende Lücke zwischen
Termine (195) und Aktivitäten (260) ist von `--swatch-sky` (228) schon fast
mittig besetzt, jeder Hue dort bliebe unter 20° Abstand. `--area-weather`
sitzt deshalb stattdessen in der größten freien Lücke, 148→195
(Gewohnheiten → Termine), bei 171 — ~23° zu beiden Seiten, knapper als die
30–47°-Regel der zehn Wähler-Optionen, aber die beste verfügbare Trennung.
`--swatch-*` unterscheidet sich von
`--area-*` (eine Farbe pro Bereich, trägt Orientierung) und von `--cat-*`
(Akzente ausschließlich innerhalb des Bereichs Termine): eine `--swatch-*`-Farbe
bedeutet nichts von sich aus — sie ist eine von zehn gleichwertigen Optionen,
die eine Person einer Zeile zuweist, um sie von anderen Zeilen derselben Art zu
unterscheiden.

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
`--accent`, `--accent-fg`, `--on-accent`, `--success`, `--warning`, `--danger`.

`--on-accent` (issue #709) ist speziell für Text/Icons auf einer mit `--accent`
oder einer `--area-*`-Farbe gefüllten Fläche gedacht (FAB, Submit-Knöpfe) — anders
als `--accent-fg` bleibt es in beiden Themes dunkel, weil die Bereichsfarben in
beiden Themes hell genug für WCAG AA (4,5:1) mit dunkler Schrift sind.

Dark Mode ist keine Nachrüstung: jedes Token existiert in beiden Modi von Anfang an.

### Seitengrund (`--ground*`, issue #832)

Jede der neun Hauptrouten steht vollflächig auf ihrer eigenen Grundfarbe
(`--ground-uebersicht` … `--ground-anmelden`, je Route per `data-ground`-Attribut
über `html:has([data-ground='…'])` gesetzt, `src/app/globals.css`) — orthogonal zu
`--area-*`: der Grund trägt die Seite, die Bereichsfarbe bleibt auf den
Bedienelementen (Aufgaben ist bewusst Petrol statt `--area-tasks`, sonst wären
Übersicht und Aufgaben beide orange). `--text`/`--text-muted` werden dadurch zur
**Kontext-Variable**: der Grund überschreibt sie auf `--on-accent` (dunkel) oder
`--on-ground-light` (hell, ein warmes Fast-Weiß) — Wahl per gemessenem Kontrast,
nie geraten. Jede Fläche mit eigenem `--surface`/`--surface-raised` setzt beide
auf die fixen Anker `--text-base`/`--text-muted-base` zurück, damit dieselbe Klasse
auf Grund und auf Karte richtig liegt. Dark Mode dunkelt jeden Grund über
`color-mix(in oklab, …, --ground-base-dark)` ab (~62 %, Aktivitäten 50 % für den
4,5:1-Grenzwert) statt die satte Farbe grell auf Schwarz zu zeigen.

## Typografie

- Ein Font: **Inter Variable** (oder Geist). Kein zweiter Font ohne ADR.
- Zahlen immer mit `font-variant-numeric: tabular-nums` — sonst zappeln Uhrzeiten und Streaks.
- Skala: 12 / 14 / 16 / 20 / 24 / 32. Fließtext 16px, nie kleiner als 14px auf Mobile.
  Drei Rollen liegen bewusst außerhalb dieser Skala — `--text-page-title` (22),
  `--text-page-title-lg` (26), `--text-temp` (40), halbhoher Seitenkopf, issue
  #833 — weil sie einen eigenen, schmaleren Kopf tragen statt der bisherigen
  Sprossen.
- Zeilenhöhe großzügig (1.5 für Text, 1.2 für Überschriften).

## Komposition

Typografie ist über Rollennamen tokenisiert, nicht über Größen — eine
Aufrufstelle greift zu `--text-body`, nie zu `--text-1` (`src/ui/tokens.css`,
issue #591):

| Token | Größe | Rolle |
|---|---|---|
| `--text-title` | 32px | FAB-/Erfassungs-Glyphe, Termin-Detail-Titel |
| `--text-page-title` | 22px | Seitentitel, h1 (8 der 9 Routen — halbhoher Kopf, issue #833) |
| `--text-page-title-lg` | 26px | Seitentitel Aktivitäten (issue #833) |
| `--text-temp` | 40px | Wetter, große Tages-Temperatur (issue #833) |
| `--text-section` | 20px | Abschnittsüberschrift |
| `--text-body` | 16px | Fließtext |
| `--text-secondary` | 14px | Sekundärtext, Labels |
| `--text-meta` | 12px | Metadaten (Zeitstempel, Zähler) |

Dazu `--weight-normal` (400) / `--weight-emphasis` (600) und je eine
Zeilenhöhe: `--leading-heading` (1.2) für Überschriften, `--leading-body`
(1.5) für Fließtext.

**Struktur ist immer leiser als Inhalt.** Ein Raster, eine Achse, eine
Trennlinie transportiert keine Bedeutung — sie ordnet nur. Solche Elemente
nehmen `--border-faint`, deutlich schwächer als `--border`. `--border` bleibt
Kanten vorbehalten, die selbst etwas bedeuten (eine Karte, ein aktiver
Zustand, eine Kategoriefarbe).

**Eine Betonung je Fläche.** Pro Karte oder Zeile trägt genau ein Element
`--weight-emphasis` oder eine Akzentfarbe — nie beides gleichzeitig auf
mehreren Elementen derselben Fläche. Konkurrierende Betonungen heben sich
gegenseitig auf; die Hierarchie geht verloren, die Fläche wird laut.
