# ADR-0027: Zweite Schrift — Rundschrift für Titel und Zahlen

Status: angenommen · Datum: 2026-08-27 · Bezug: #859 (S1 von #828)

## Kontext

Das Vollfarb-Entwurfsblatt (#828) trägt zwei Schriftrollen: eine gerundete für
Titel, Kartenüberschriften, große Zahlen und die Knopfbeschriftung, eine
neutrale für Fließtext und Listenzeilen. Der gebaute Stand fuhr bislang Inter
auf allem. Mit einer einzigen neutralen Schrift bleibt der Vollfarb-Grund ein
Farbwechsel, aber kein Formwechsel — die Seiten sehen bunt aus, nicht weich.

`docs/design/farben-typografie.md:123` sagte bisher wörtlich: „Ein Font:
**Inter Variable** (oder Geist). **Kein zweiter Font ohne ADR.**" Diese Zeile
ist der Grund, warum sechs gemergte Stufen von #828 die Schrift nicht
angefasst haben.

## Entscheidung

Zwei Rollen statt einer:

- `--font-ui` → **Inter** (unverändert, trägt weiter allen Fließtext).
- `--font-display` → `ui-rounded, 'SF Pro Rounded', <Web-Fallback>, system-ui,
  sans-serif`.

Auf dem Prüfgerät (iPhone 12 mini, Safari/PWA) löst `ui-rounded` auf **SF Pro
Rounded** auf — die Schrift des Blatts, ohne ein einziges übertragenes Byte.
Der Web-Fallback greift nur auf Nicht-Apple-Geräten (Android, Windows,
CI/Linux-Chromium).

**Web-Fallback: Nunito** (variabel, über `next/font/google` wie Inter — beim
Build als woff2 selbst gehostet, **keine** Laufzeit-Anfrage an Google, **keine**
neue npm-Abhängigkeit). Latin-Subset, Gewichte 400/600, ~30 KB.

**Wo die Rundschrift trägt** (AK3 aus #859): `h1` aller neun Routen,
`.section-card__title`, die großen Zahlen (Fortschrittsring, Wetter-Temperatur,
Aktivitäten-Kennzahl, Uhrzeit in der Kalender-Agenda), die Beschriftung des
FAB. Rezept überall dieselben vier Zeilen: `font-family: var(--font-display)`,
`font-weight: var(--weight-emphasis)` (600), `letter-spacing: -0.025em`,
`line-height: 1.1`. Fließtext, Listenzeilen, Nav-Labels, Eingabefelder,
Journal-Einträge, `h2`/`h3` bleiben `--font-ui` (AK4).

## Alternativen, die wir nicht genommen haben

- *Nur `ui-rounded`, kein Web-Fallback.* Billiger, aber Android/Windows fallen
  auf Inter zurück und sehen das Blatt nie. Verworfen: der Desktop ist zwar
  nicht der Maßstab, soll aber nicht anders aussehen.
- *Alles auf die Rundschrift.* Verworfen: lange Journal-Einträge lesen sich in
  einer gerundeten Groteske schlechter; das Blatt trennt die Rollen selbst.
- *Quicksand / Varela Round / Comfortaa.* Geometrischer und eigenwilliger,
  passen schlechter zu SF Pro Rounded — der Bruch zwischen Apple und Rest wäre
  sichtbar.
- *Avenir Next als `--font-ui` (wie im Blatt).* Verworfen: Systemschrift von
  Apple, nicht frei lizenziert, brächte eine dritte Schrift. Inter bleibt.

## Konsequenzen

- Eine zweite Schriftdatei im Build (~30 KB, Nunito 400/600 Latin).
- Das Token-System bekommt eine Rollenachse mehr (`--font-ui`/`--font-display`
  in `src/ui/tokens.css`, als Tailwind-Rolle in `globals.css` `@theme inline`
  verfügbar) — keine Datei greift die Schriftfamilie mehr roh ab, dieselbe
  Regel wie bei den Schriftgraden (#591/#592).
- `docs/design/farben-typografie.md` wird von „ein Font" auf „zwei Rollen"
  umgeschrieben.
- Kein Vendor-Lock-in, kein Schema, kein Sync, keine neue Dependency.
- `.section-card__title` kehrt das „leicht gesperrte" `letter-spacing: 0.02em`
  aus #653 auf `-0.025em` um — AK3 nennt den Selektor explizit und ist die
  neuere, ausdrückliche Ansage.
- `.event-agenda__item-time` bekommt `font-weight: 600` (vorher normal/gedämpft)
  — Spannung zu „Eine Betonung je Fläche" (der Titel in derselben Zeile trägt
  sie schon), aber AK3 verlangt das Rezept dort ausdrücklich.
