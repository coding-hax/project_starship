# Design System

**Leitbild: simpel, modern, gebaut für ein Gerät.**

Diese App wird auf einem **iPhone 12 mini im Hochformat** benutzt — 375 × 812
CSS-px, nutzbar 375 × 734 nach Safe Area (44 px oben, 34 px unten), abzüglich
Bottom-Nav. Das ist kein Breakpoint unter mehreren, sondern **die Fläche, für
die entworfen wird**. Desktop ist dieselbe App, breiter — nie ein zweiter
Entwurf und nie der Maßstab.

Zur Zahl: Das mini rendert **375 × 812 CSS-px** (iPhone-X-Klasse), skaliert bei
3x herunter. „Physisch 1080 ÷ 3 = 360" ist **falsch** — das ist die 2x-Rechnung
eines anderen iPhone-Modells, keine des mini. Geräte-Datenbanken im Netz sind
hier gespalten; maßgeblich für diese App ist ausschließlich der CSS-Wert
375 × 812.

**Simpel** heißt: weniger Elemente, nicht kleinere. Wer etwas hinzufügt, nennt,
was dafür weggeht.

**Modern** heißt: ruhige Flächen, klare Hierarchie, Bewegung nur dort, wo sie
etwas erklärt.

Daraus folgen harte Regeln:

1. **Der Hauptinhalt eines Screens ist in einer Bildschirmhöhe erfassbar.**
   Scrollen erschließt mehr — es darf nie nötig sein, um das Wesentliche
   überhaupt zu sehen.
2. **Keine Form, die mehr Gerüst als Inhalt zeigt.**
3. **Desktop-Layouts entstehen aus dem Hochformat, nicht umgekehrt.**

Der eigentliche Regeltext lebt seit #596 themenweise in `docs/design/`, damit
jede referenzierte Datei klein und gezielt lesbar bleibt (Token-Disziplin,
CLAUDE.md). Diese Datei ist nur noch das Inhaltsverzeichnis:

| Thema | Datei |
| --- | --- |
| Formwahl (R1–R4: welche Grundform ein Screen bekommt) + die fünf Zustände (leer, spärlich, ladend, Fehler, offline) | `docs/design/formwahl-und-zustaende.md` |
| Farben (Bereichs-/Kategoriefarben, semantische Tokens), Typografie, Komposition | `docs/design/farben-typografie.md` |
| Form & Raum, Ebenen (z-index-Skala), Motion, das „Smooth"-Versprechen | `docs/design/form-und-motion.md` |
| Icon-Sprache, Mobile-Patterns, Desktop | `docs/design/patterns.md` |

Ein Verweis wie „`docs/design/farben-typografie.md`, „Komposition"" meint: Datei
öffnen, zum benannten Absatz springen — nicht die ganze Datei lesen.
