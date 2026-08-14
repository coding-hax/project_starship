/**
 * Hand-drawn icon set for the navigation (issue #125). One file so the set stays
 * visible as a set — no icon library, just SVGs matching DESIGN_SYSTEM.md's
 * "großzügige Radien, weiche Schatten, nichts wirkt kantig": 24×24, stroke 1.5,
 * round caps/joins, contour only. `stroke="currentColor"` so active-tab accent
 * and dark mode fall out of CSS, no second color path.
 */

type IconProps = {
  className?: string;
};

const svgProps = {
  width: 24,
  height: 24,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
};

export function IconToday({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      {/* Sun (issue #157): distinct from IconWeatherClear via few, long rays and a
          filled core (open ring there) — the one deliberate exception to "Kontur
          statt Fläche", called for in the ticket so the core reads as solid rather
          than as a crosshair. */}
      <circle cx="12" cy="12" r="2.25" fill="currentColor" stroke="none" />
      <path d="M12 6V2M12 18v4M18 12h4M6 12H2" />
    </svg>
  );
}

export function IconTasks({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      <rect x="4" y="4" width="16" height="16" rx="5" />
      <path d="M8.5 12.5l2.5 2.5 5-5.5" />
    </svg>
  );
}

export function IconHabits({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      <path d="M18.5 8.5A7 7 0 1 0 19 12" />
      <path d="M19 4v5h-5" />
    </svg>
  );
}

export function IconCalendar({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      <rect x="3.5" y="5" width="17" height="15" rx="3" />
      <path d="M3.5 10h17" />
      <path d="M8 3.5v3" />
      <path d="M16 3.5v3" />
    </svg>
  );
}

export function IconJournal({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      <path d="M14.5 4.5l5 5L9 20H4v-5z" />
      <path d="M12.5 6.5l5 5" />
    </svg>
  );
}

export function IconSettings({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      {/* Two horizontal sliders with handles (issue #157) — replaces the old
          gear-as-radial-strokes shape, which read as IconWeatherClear's sun once
          the forecast landed on the same screen. */}
      <path d="M3.5 8h6.5M15.5 8h5" />
      <circle cx="12.5" cy="8" r="2" />
      <path d="M3.5 16h4.5M13.5 16h7" />
      <circle cx="10.5" cy="16" r="2" />
    </svg>
  );
}

// --- Wetter (issue #139): dieselbe Sprache, sieben WMO-Kategorien (wmo-icon.ts) ---
// Jedes Icon trägt zusätzlich `weather-icon weather-icon--<kategorie>` plus
// BEM-artige Teil-Klassen (issue #661) — die Basis, an der
// weather-icon-motion.css die dauerhafte Umgebungsbewegung je Kategorie
// ansetzt. Die `className`-Prop wird angehängt, nie ersetzt.

function weatherIconClassName(category: string, className?: string): string {
  const base = `weather-icon weather-icon--${category}`;
  return className ? `${base} ${className}` : base;
}

export function IconWeatherClear({ className }: IconProps) {
  return (
    <svg {...svgProps} className={weatherIconClassName('clear', className)}>
      <g className="weather-icon__rays">
        <path className="weather-icon__ray" d="M12 3v2.5" />
        <path className="weather-icon__ray" d="M12 18.5V21" />
        <path className="weather-icon__ray" d="M4.4 4.4l1.8 1.8" />
        <path className="weather-icon__ray" d="M17.8 17.8l1.8 1.8" />
        <path className="weather-icon__ray" d="M3 12h2.5" />
        <path className="weather-icon__ray" d="M18.5 12H21" />
        <path className="weather-icon__ray" d="M4.4 19.6l1.8-1.8" />
        <path className="weather-icon__ray" d="M17.8 6.2l1.8-1.8" />
      </g>
      <circle className="weather-icon__disc" cx="12" cy="12" r="4.5" />
    </svg>
  );
}

export function IconWeatherPartlyCloudy({ className }: IconProps) {
  return (
    <svg {...svgProps} className={weatherIconClassName('partly-cloudy', className)}>
      <g className="weather-icon__sun">
        <path d="M9.5 9.5a4 4 0 0 1 7.6 1.8" />
        <path d="M9.5 9.5v-.1M9.5 5.5v1.5M6 8l1.2 1M13.5 5l-.7 1.3" />
      </g>
      <path
        className="weather-icon__cloud"
        d="M7 20h10a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.7 1.2A3.5 3.5 0 0 0 7 20z"
      />
    </svg>
  );
}

export function IconWeatherCloudy({ className }: IconProps) {
  return (
    <svg {...svgProps} className={weatherIconClassName('cloudy', className)}>
      <path
        className="weather-icon__cloud"
        d="M6.5 19h11a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.5A3.5 3.5 0 0 0 6.5 19z"
      />
    </svg>
  );
}

export function IconWeatherFog({ className }: IconProps) {
  return (
    <svg {...svgProps} className={weatherIconClassName('fog', className)}>
      {/* Kleinere, tiefere Wolke (issue #661): die alte ragte oben aus der viewBox
          (Bogenscheitel bei y≈-1,1) — derselbe Fehler, den #330 am Gewitter-Icon
          behoben hat, hier übersehen. */}
      <path
        className="weather-icon__cloud"
        d="M6.5 11h11a3.4 3.4 0 0 0 .1-6.6 5.2 5.2 0 0 0-10 1.5"
      />
      <path className="weather-icon__fog-line weather-icon__fog-line--1" d="M4 14.5h16" />
      <path className="weather-icon__fog-line weather-icon__fog-line--2" d="M4 18h16" />
    </svg>
  );
}

export function IconWeatherRain({ className }: IconProps) {
  return (
    <svg {...svgProps} className={weatherIconClassName('rain', className)}>
      <path
        className="weather-icon__cloud"
        d="M6.5 13h11a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.5A3.5 3.5 0 0 0 6.5 13z"
      />
      <path className="weather-icon__drop weather-icon__drop--1" d="M8.5 16.5l-1 3" />
      <path className="weather-icon__drop weather-icon__drop--2" d="M12.5 16.5l-1 3" />
      <path className="weather-icon__drop weather-icon__drop--3" d="M16.5 16.5l-1 3" />
    </svg>
  );
}

export function IconWeatherSnow({ className }: IconProps) {
  return (
    <svg {...svgProps} className={weatherIconClassName('snow', className)}>
      <path
        className="weather-icon__cloud"
        d="M6.5 12h11a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.5A3.5 3.5 0 0 0 6.5 12z"
      />
      <g className="weather-icon__flake weather-icon__flake--1">
        <path d="M9 17v4" />
        <path d="M7 18.2l4 1.6" />
        {/* Fix (issue #661): war M13 18.2l-4 1.6, Mitte bei (11,19) statt (9,19) wie
            die beiden anderen Arme — die Flocke stand schief. */}
        <path d="M11 18.2l-4 1.6" />
      </g>
      <g className="weather-icon__flake weather-icon__flake--2">
        <path d="M15 17v4" />
        <path d="M13 18.2l4 1.6" />
        <path d="M17 18.2l-4 1.6" />
      </g>
    </svg>
  );
}

export function IconWeatherThunderstorm({ className }: IconProps) {
  // Wolken-Unterkante bei 13 (wie IconWeatherRain), nicht höher: die Schablone ist
  // ~11,9 Einheiten hoch, bei 11 ragt die Oberkante über die viewBox hinaus und
  // wird abgeschnitten (issue #330).
  return (
    <svg {...svgProps} className={weatherIconClassName('thunderstorm', className)}>
      <path
        className="weather-icon__cloud"
        d="M6.5 13h11a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.5A3.5 3.5 0 0 0 6.5 13z"
      />
      <path className="weather-icon__bolt" d="M13 14l-3 4.5h3L11 22" />
    </svg>
  );
}

export function IconActivity({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      {/* Heart-rate trace (issue #180) — distinct from IconHabits' streak-arrow. */}
      <path d="M3 13h4l2 5 4-11 2 6h6" />
    </svg>
  );
}

// --- Wetterdetails-Kopf (issue #269): Höchst-/Nachtwert, klein neben der Zahl ---

export function IconSunSimple({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      {/* Schlichter als IconWeatherClear (das große Kategorie-Icon direkt daneben) —
          nur der Kern, keine Strahlen, sonst stünde zweimal dieselbe Sonne nebeneinander. */}
      <circle cx="12" cy="12" r="5" />
    </svg>
  );
}

export function IconMoon({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      <path d="M15.5 4.5a8 8 0 1 0 4 12.5 6.5 6.5 0 0 1-4-12.5z" />
    </svg>
  );
}

export function IconReset({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      {/* Gegen-den-Uhrzeigersinn-Pfeil (Journal-Suchfilter zurücksetzen, issue #455) —
          gespiegelt zu IconHabits' Streak-Pfeil, damit beide trotz ähnlicher Form nicht
          wie dasselbe Icon wirken. */}
      <path d="M5.5 8.5A7 7 0 1 1 5 12" />
      <path d="M5 4v5h5" />
    </svg>
  );
}

export function IconSearch({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      {/* Lupe (Journal-Suche, issue #700): Kreis-Linse + kurzer Griff, dieselbe
          Kontur-Sprache wie die übrigen Icons. */}
      <circle cx="11" cy="11" r="6.5" />
      <path d="M15.8 15.8L20 20" />
    </svg>
  );
}

export function IconChevronLeft({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}

export function IconChevronRight({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

// --- Gewohnheiten: Streak-Zähler und Joker in habit-today.tsx ---

export function IconStreak({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      {/* Einteilige Flamme mit angedeuteter Zunge — bewusst ohne Innenkontur:
          der Streak steht bei --text-secondary (14px), dort läuft eine zweite
          Linie in die Außenkante. Ersetzt das 🔥-Emoji (patterns.md,
          "Nie ein Unicode-Glyph"). */}
      <path d="M12 2.8c.4 2.6 1.9 4 3.2 5.4C16.7 9.8 18 11.4 18 13.8a6 6 0 0 1-12 0c0-1.9.7-3.3 1.7-4.5.2 1.3.8 2.1 1.6 2.5-.5-3.6.3-6.6 2.7-9z" />
    </svg>
  );
}

// --- Aufgaben: erledigte ausblenden (issue #654) ---

export function IconHideCompleted({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      <path d="M2.75 12S6.5 6 12 6s9.25 6 9.25 6-3.75 6-9.25 6-9.25-6-9.25-6Z" />
      <circle cx="12" cy="12" r="2.75" />
      <path d="M5 19 19 5" />
    </svg>
  );
}

// --- Chip-Bauteil: Verwerfen-Ziel eines geratenen Chips (issue #711) ---

export function IconClose({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function IconFreeze({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      {/* Schild statt Schneeflocke: der Nutzertext sagt "Serie mit Joker retten",
          die Funktion schützt die Serie. Eine Flocke wäre zudem dieselbe Form,
          die IconWeatherSnow schon trägt. Ersetzt das ❄️-Emoji. */}
      <path d="M12 3.2l6.5 2.6v5.4c0 4.2-2.7 7.5-6.5 9.1-3.8-1.6-6.5-4.9-6.5-9.1V5.8z" />
    </svg>
  );
}
