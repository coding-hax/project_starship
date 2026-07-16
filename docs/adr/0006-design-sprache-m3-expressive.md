# ADR-0006: Design-Sprache — Material 3 Expressive als Motion-/Interaktions-Layer

Status: **angenommen** · Datum: 2026-07-16

## Kontext

`docs/DESIGN_SYSTEM.md` legt Farbe, Form und Motion bereits fest: bedeutungstragende
Bereichsfarben, Spring-Motion 150–250 ms, 60-fps-Versprechen, `prefers-reduced-motion`
respektiert. Was fehlt, ist ein Satz wiederverwendbarer, taktiler Primitive (Toggle,
Slider, SegmentedControl, SectionCard, Row) — die App hat noch keinen echten
Einstellungen-Screen, an dem sich diese Primitive erstmals real zeigen.

Zwei aktuelle Design-Strömungen kämen als Vorbild infrage: Googles **Material 3
Expressive** (2025) und Apples **Liquid Glass**.

## Entscheidung

Wir übernehmen die **Prinzipien von Material 3 Expressive** als Motion- und
Interaktions-Layer — aufgesetzt auf das bestehende Leitbild „lebensfroh, warm, ruhig",
**nicht** als Reskin. Konkret bedeutet das:

- **Spring-Physik** als Bewegungsgrundlage für taktile Mikrointeraktionen (Toggle-Knopf,
  Slider-Thumb, Segmented-Indicator, Aufklappen, Häkchen) — das ist bereits unser
  Motion-Default (`--ease-spring` in `tokens.css`), M3 Expressive verlängert ihn nur auf
  mehr Primitive.
- **Lebendige, aber bedeutungstragende Farbe** bleibt: ein Akzent pro Bereich, keine
  dynamische „Material You"-Farbe. Farbe = Orientierung, nicht Deko.
- **Taktile Mikrointeraktionen** (Press-Scale, Overshoot beim Einrasten) als bewusst
  begründetes, subtiles Feedback — kein Bounce ohne Grund.

**Nicht** übernommen: Liquid Glass. Es bricht drei bestehende Regeln statt sie zu
verlängern:

- Blur/Transparenz auf Flächen bricht das 60-fps-Versprechen auf Listen (teure Filter).
- Es dreht sich um Tiefe/Transluzenz statt um Farbsemantik — widerspricht „eine
  Akzentfarbe pro Bereich".
- Kontrast auf Glas ist WCAG-AA/AAA-kritisch; unser Textkontrast-Anspruch ist es nicht
  verhandelbar.

## Reconciliation mit `DESIGN_SYSTEM.md`

`DESIGN_SYSTEM.md` verbietet „Bounce-Effekte ohne Grund". Der Spring-Overshoot aus M3
Expressive ist kein ungerichteter Bounce, sondern **begründetes** taktiles Feedback beim
Einrasten eines Zustands (Toggle kippt um, Segmented-Indicator rastet ein). Damit das
nicht in die verbotene Kategorie rutscht, gilt zusätzlich:

- Overshoot bleibt **subtil** (≤ 5 % Auslenkung) und **≤ 250 ms** — innerhalb der
  ohnehin geltenden Dauer-Obergrenze.
- Unter `prefers-reduced-motion: reduce` wird der Overshoot **vollständig abgeschaltet**,
  nicht nur verkürzt — die globale Regel in `tokens.css` (Zeilen 90–99) übernimmt das
  bereits für jede `transition`/`animation`.
- Kein Zustand wird **ausschließlich** durch Bewegung vermittelt: `aria-checked`,
  Farbwechsel oder Position tragen den Zustand immer auch statisch.

## Technische Umsetzung

**CSS-Springs, keine Motion-Bibliothek.** Alle hier geforderten Interaktionen sind
1D-Übergänge ohne Interruption-Physik (kein Drag, der eine laufende Animation
unterbrechen und geschwindigkeitserhaltend umkehren muss). Das leistet CSS mit
`linear()`-Easing (Spring-Approximation) plus `transition`/`@starting-style` — das
Muster, das `src/ui/sheet.css` bereits nutzt. Damit entsteht **keine neue Dependency**,
also ist nach Regel 3 aus `CLAUDE.md` **kein weiteres ADR nötig**. Eine echte JS-Feder
(z. B. Motion/framer-motion) käme erst infrage, wenn ein Primitive unterbrechbare,
geschwindigkeitserhaltende Physik braucht — das ist hier bei keinem der fünf Primitive
der Fall. Sollte das künftig nötig werden: eigenes Ticket, eigenes ADR.

## Konsequenzen

- `src/ui/motion.css` führt zwei Feder-Presets ein (`--ease-spring-snappy` für
  Toggle/Häkchen, `--ease-spring-smooth` für Aufklappen/Slider), beide als
  `linear()`-Approximation mit `--ease-spring` (cubic-bezier) als Fallback, falls
  `linear()` irgendwo klemmt.
- Die fünf neuen Primitive (`Row`, `SectionCard`, `Toggle`, `SegmentedControl`,
  `Slider`) in `src/ui/` sind ab jetzt die Referenz für taktile Mikrointeraktionen —
  spätere Bereiche (Journal, Kalender, Habits) nutzen sie, statt eigene Zustands-Optik
  zu erfinden.
- Dieses ADR verlängert `DESIGN_SYSTEM.md`, ersetzt es nicht. Bei Widerspruch gewinnt
  `DESIGN_SYSTEM.md`.
