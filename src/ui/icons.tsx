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
          near-solid core (tiny radius, thick stroke) instead of its eight short
          rays around an open ring. */}
      <circle cx="12" cy="12" r="1.25" />
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

export function IconWeatherClear({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 3v2.5M12 18.5V21M4.4 4.4l1.8 1.8M17.8 17.8l1.8 1.8M3 12h2.5M18.5 12H21M4.4 19.6l1.8-1.8M17.8 6.2l1.8-1.8" />
    </svg>
  );
}

export function IconWeatherPartlyCloudy({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      <path d="M9.5 9.5a4 4 0 0 1 7.6 1.8" />
      <path d="M9.5 9.5v-.1M9.5 5.5v1.5M6 8l1.2 1M13.5 5l-.7 1.3" />
      <path d="M7 20h10a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.7 1.2A3.5 3.5 0 0 0 7 20z" />
    </svg>
  );
}

export function IconWeatherCloudy({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      <path d="M6.5 19h11a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.5A3.5 3.5 0 0 0 6.5 19z" />
    </svg>
  );
}

export function IconWeatherFog({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      <path d="M6.5 10.5h11a4 4 0 0 0 .1-8 6 6 0 0 0-11.5 1.8" />
      <path d="M4 14.5h16M4 18h16" />
    </svg>
  );
}

export function IconWeatherRain({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      <path d="M6.5 13h11a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.5A3.5 3.5 0 0 0 6.5 13z" />
      <path d="M8.5 16.5l-1 3M12.5 16.5l-1 3M16.5 16.5l-1 3" />
    </svg>
  );
}

export function IconWeatherSnow({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      <path d="M6.5 12h11a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.5A3.5 3.5 0 0 0 6.5 12z" />
      <path d="M9 17v4M7 18.2l4 1.6M13 18.2l-4 1.6M15 17v4M13 18.2l4 1.6M17 18.2l-4 1.6" />
    </svg>
  );
}

export function IconWeatherThunderstorm({ className }: IconProps) {
  return (
    <svg {...svgProps} className={className}>
      <path d="M6.5 11h11a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.5A3.5 3.5 0 0 0 6.5 11z" />
      <path d="M13 14l-3 4.5h3L11 22" />
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
