# Farben, Typografie & Komposition

## Farben

Warmes Off-White statt reinem Weiß, warmes Anthrazit statt Schwarz: das bleibt
— unabhängig vom Leitsatz (`docs/DESIGN_SYSTEM.md`), der „simpel, modern" statt
„lebensfroh" verlangt. Die warmen Neutralen sind eine Eigenschaft der Palette,
kein Ableger einer Stimmung. Bereichs- und Kategoriefarben ändern sich dadurch
nicht.

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

## Komposition

Typografie ist über Rollennamen tokenisiert, nicht über Größen — eine
Aufrufstelle greift zu `--text-body`, nie zu `--text-1` (`src/ui/tokens.css`,
issue #591):

| Token | Größe | Rolle |
|---|---|---|
| `--text-title` | 32px | Seitentitel |
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
