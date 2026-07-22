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
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2.5" />
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
      <circle cx="12" cy="12" r="3.5" />
      <path
        d="M18 12h3M3 12h3M12 18v3M12 3v3M18.36 18.36l-2.12-2.12M7.76 7.76 5.64 5.64M18.36 5.64l-2.12 2.12M7.76 16.24l-2.12 2.12"
      />
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
