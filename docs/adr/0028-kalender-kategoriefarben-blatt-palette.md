# ADR-0028: Kalender-Kategoriefarben — Blatt-Palette statt Blaugrün-Cluster

Status: angenommen · Datum: 2026-08-31 · Bezug: #955

## Kontext

Menschliche Entscheidung im Chat (31.08.2026): die Palette des
Entwurfsblatts gilt für die fünf `--cat-*`-Vorgaben, die Regel aus #553 wird
abgelöst.

`src/ui/tokens.css` hielt seit #553 (11.08., vor dem Vollfarb-Umbau) fest,
dass die Kategoriefarben Akzente *innerhalb* der Termine-Fläche sind, nicht
eine zweite Primärfarben-Familie — alle geclustert um `--area-events`' Hue
(195). Gebaut waren die fünf Vorgaben als `oklch(66% 0.11 H)` mit
H = 155/170/185/210/230: gleiche Helligkeit, gleiche Sättigung, ein 75°
schmales Blaugrün-Fenster. Das Entwurfsblatt spannt dagegen den vollen
Farbkreis auf. Deshalb wirkte die Kalenderseite trotz stimmender Maße
(Kopfaufbau, Agenda-Zeile, Radien, Schatten, FAB-Pille — #898/#921/#923/
#924/#865/#867) einfarbig.

Die Farben sind seit #660 zusätzlich konfigurierbar: `category-colors-boot.tsx`
schattet `--cat-<kategorie>` auf `<html>` mit `var(--swatch-*)`, sobald eine
Person eine Kategorie von Hand umfärbt. `--cat-*` in `tokens.css` ist also nur
noch der **Vorgabewert** — wer schon umgefärbt hat, sieht diese Änderung
nicht (gewollt, #660 AC5).

## Entscheidung

Fünf eigene `oklch()`-Literale, aus den fünf Blatt-Hex-Werten (Grün `#12a67a`,
Himmel `#3aa7e0`, Blau `#0061ef`, Pflaume `#6b2fa0`, Orange `#ff7300`) exakt
nach OKLCH gewandelt (sRGB→OKLab-Standardformel, nicht geschätzt) — Nachbarn
liegen mindestens 40° auseinander (derselbe Maßstab wie `--swatch-*`,
30–47°). Kein `var(--area-*)`/`var(--swatch-*)`-Verweis: kein vorhandenes
Tokenpaar liegt gleichzeitig ≥40° von beiden Nachbarn entfernt, und der
AK1-Hue-Test liest den Farbton aus dem deklarierten `oklch(L C H)`-Literal
selbst (`getComputedStyle(...).getPropertyValue('--cat-…')`) — ein `var()`
wäre dort nicht als Literal parsebar.

Kategorie-Zuordnung (1:1 aus der Ticket-Tabelle, jede „heute"-Hex-Spalte
identisch mit einem bestehenden `--cat-*`-Hex):

| Kategorie | Blatt-Farbe | Blatt-Hex | Hue (gemessen) |
| --- | --- | --- | --- |
| gesundheit | Grün | `#12a67a` | 165.5° |
| privat | Pflaume | `#6b2fa0` | 304.5° |
| sport | Orange | `#ff7300` | 47.9° |
| arbeit | Blau | `#0061ef` | 260.5° |
| familie | Himmel | `#3aa7e0` | 236.1° → **220°** |

Zwei Nudges gegenüber dem reinen Blatt-Hex, beide gemessen statt geraten:

1. **`--cat-familie` (Himmel): Hue 236°→220°.** Himmel und Blau liegen im
   Blatt nur 24,5° auseinander, unter der 40°-Schwelle. 220° bleibt klar
   Himmelblau und erreicht 40,5° Abstand zu `--cat-arbeit`.
2. **`--cat-arbeit`/`--cat-privat`: Lightness angehoben (Blau 54%→68%,
   Pflaume 44,6%→68%).** Kalender-Grund und -Punkte brauchen 3:1 gegen
   `--ground-kalender` (AK2); Punkte werden dafür wie im Ganztägig-Band
   (#924) mit `color-mix(in oklab, var(--cat-*) 60%, var(--on-ground))`
   aufgehellt. Am reinen Blatt-Hex reicht selbst dieser 60%-Mix nicht
   (gemessen 2,54:1 / 1,99:1 hell). Bei 68% Lightness klärt sich das auf
   3,33:1 (beide) — mit Marge, nicht auf der Kippe. Hue bleibt exakt der
   Blatt-Wert.

Dark-Werte folgen demselben Muster wie die bestehenden `--area-*`-Dark-Werte:
Lightness auf ein 72–77%-Band angehoben, Chroma um ~12–15% reduziert (gegen
Neon auf dunklem Grund), Hue unverändert.

Zwei Render-Kontexte, ein Token je Kategorie:

- **6px-Kante der Agenda-Zeile** (`categoryEdgeVar`, `event-time.ts`): roher,
  satter Token-Wert.
- **Punkt auf dem Grund** (Wochenstreifen, Monatsraster, Ganztägig-Band):
  `color-mix(in oklab, var(--cat-*) 60%, var(--on-ground))` — dasselbe
  Rezept überall, keine kategorie-spezifischen Mix-Prozente.

## Alternativen, die wir nicht genommen haben

- *Vorhandene `--area-*`/`--swatch-*`-Tokens wiederverwenden (#906).* Geprüft
  und verworfen: die zwei Blau-Töne des Blatts (Himmel ≈237°, Blau ≈262°)
  liegen näher an ihren jeweils nächsten Tokens (`--swatch-sky` 228°,
  `--area-activities` 260°, nur 32° Abstand) als die 40°-Schwelle erlaubt.
  Grün (163°) und Himmel (237°) haben zusätzlich keinen exakten Token-Treffer.
- *Höheren Mix-Anteil für alle fünf Kategorien statt Lightness der zwei
  betroffenen Tokens anzuheben.* Ein einheitlich niedrigerer Mix-Prozentsatz
  (z. B. 40% statt 60%) hätte auch die drei bereits konformen Kategorien
  unnötig verwaschen und wäre inkonsistent zum bestehenden #924-Rezept für
  das Ganztägig-Band gewesen, das fest bei 60% liegt.
- *Separates, zusätzliches Token je Kategorie für den aufgehellten Punkt
  (`--cat-arbeit-dot` o. ä.).* Mehr Tokens, mehr Pflegeaufwand, bricht mit
  dem bestehenden Ein-Token-pro-Kategorie-Muster — der `color-mix` am
  Render-Ort reicht.

## Konsequenzen

- `src/ui/tokens.css`: fünf `--cat-*`-Literale (hell + dunkel, beide
  Dark-Blöcke synchron), Kommentar ersetzt die #553-Cluster-Regel.
- `src/features/events/calendar-strip.tsx`/`.css`: Punkt im Wochenstreifen
  und Monatsraster bekommt dasselbe `color-mix`-Rezept wie das
  Ganztägig-Band, über eine neue `--dot-cat`-Custom-Property statt direktem
  `background`.
- `design-system`-Agent und künftige Läufe erzwingen die #553-Cluster-Regel
  nicht mehr — `docs/design/farben-typografie.md` ist entsprechend
  nachgezogen.
- `category-colors-boot.tsx`/`SWATCH_PALETTE`/`use-category-colors.ts`
  unverändert: die Umfärb-Maschinerie ist namens-, nicht wertgebunden.
- Kein Schema, kein Sync, keine Krypto, keine neue Dependency. Wer eine
  Kategorie bereits von Hand umgefärbt hat, sieht die neue Vorgabe nicht
  (#660 AC5, unverändert) — keine Datenwanderung nötig.
