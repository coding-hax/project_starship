import './faces.css';

/**
 * One inline-drawn silhouette per route (S4 of #828, issue #830; redrawn to
 * match the design sheet in issue #850). Server component, no hooks/state —
 * blink and bob live entirely in faces.css keyframes (same split as
 * background-circles.tsx), so this renders on server and client pages alike
 * with zero client JS. Inline paths, not `<symbol>`+`<use>`: CSS can't reach
 * into a `<use>` shadow tree, and `.face__eyes--late` must tick per figure.
 */

type FaceName =
  | 'uebersicht'
  | 'aufgaben'
  | 'kalender'
  | 'routinen'
  | 'journal'
  | 'aktivitaeten'
  | 'wetter'
  | 'einstellungen'
  | 'anmelden';

type PageFaceProps = {
  face: FaceName;
};

// Bob wippt langsamer (issue #850, Entwurfsblatt): Übersicht, Journal, Anmelden.
const SLOW_BOB: ReadonlySet<FaceName> = new Set(['uebersicht', 'journal', 'anmelden']);

export function PageFace({ face }: PageFaceProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden="true"
      data-face={face}
      className={`face${SLOW_BOB.has(face) ? ' face--slow' : ''}`}
    >
      {FACE_CONTENT[face]}
    </svg>
  );
}

const FACE_CONTENT: Record<FaceName, React.ReactNode> = {
  uebersicht: (
    <>
      <path
        className="face__body"
        d="M32 3c15.5 0 26 10.5 26 26.5C58 47.5 46.5 61 32 61S6 47.5 6 29.5C6 13.5 16.5 3 32 3z"
      />
      <g className="face__eyes">
        <circle cx="23" cy="28" r="3.8" />
        <circle cx="41" cy="28" r="3.8" />
      </g>
      <path className="face__line" d="M22 39.5c2.8 5.2 6.6 7.8 10 7.8s7.2-2.6 10-7.8" />
    </>
  ),

  aufgaben: (
    <>
      <path
        className="face__body"
        d="M32 5c19.5 0 27 7.5 27 27s-7.5 27-27 27S5 51.5 5 32 12.5 5 32 5z"
      />
      <g className="face__eyes">
        <circle cx="23" cy="28" r="3.8" />
      </g>
      <path className="face__line" style={{ strokeWidth: 3.4 }} d="M36.5 28.5c2.4-3.2 6-3.2 8.4 0" />
      <path className="face__line" d="M21 38c3.6 6.8 7.6 10 11 10s7.4-3.2 11-10" />
    </>
  ),

  kalender: (
    <>
      <path
        className="face__body"
        d="M32 6a26 26 0 0126 26v17a5 5 0 01-5 5H11a5 5 0 01-5-5V32A26 26 0 0132 6z"
      />
      <g className="face__line" style={{ strokeWidth: 3.6 }}>
        <path d="M17.5 30q5.5 -7 11 0" />
        <path d="M35.5 30q5.5 -7 11 0" />
      </g>
      <path
        className="face__line"
        style={{ strokeWidth: 4.2 }}
        d="M21 37c5.5 9.459999999999999 12.100000000000001 13.2 22 0"
      />
    </>
  ),

  routinen: (
    <>
      <g className="face__body" transform="scale(2.6667)">
        <path d="M12 2.8c.4 2.6 1.9 4 3.2 5.4C16.7 9.8 18 11.4 18 13.8a6 6 0 0 1-12 0c0-1.9.7-3.3 1.7-4.5.2 1.3.8 2.1 1.6 2.5-.5-3.6.3-6.6 2.7-9z" />
      </g>
      <g className="face__eyes face__eyes--late">
        <circle cx="26" cy="34" r="3.2" />
        <circle cx="40" cy="34" r="3.2" />
      </g>
      <path className="face__line" style={{ strokeWidth: 3.4 }} d="M26 43c1.8 3.4 4.2 5 6 5s4.2-1.6 6-5" />
    </>
  ),

  journal: (
    <>
      <path
        className="face__body"
        style={{ stroke: 'var(--face-body)', strokeWidth: 9, strokeLinejoin: 'round' }}
        d="M32 9l19 12v22L32 55 13 43V21z"
      />
      <g
        className="face__eyes"
        style={{ fill: 'none', stroke: 'var(--face-ink)', strokeWidth: 3.4, strokeLinecap: 'round' }}
      >
        <path d="M19.5 29.5c2.4-3.2 6-3.2 8.4 0" />
        <path d="M35.5 29.5c2.4-3.2 6-3.2 8.4 0" />
      </g>
      <path className="face__line" style={{ strokeWidth: 3.6 }} d="M25 38c2.4 4.4 5.4 6.6 7.5 6.6s5.1-2.2 7.5-6.6" />
    </>
  ),

  aktivitaeten: (
    <>
      <path
        className="face__body"
        d="M32 3c12.5 10.5 22.5 19 22.5 31.5a22.5 22.5 0 11-45 0C9.5 22 19.5 13.5 32 3z"
      />
      <g className="face__eyes">
        <circle cx="24" cy="32" r="4.2" />
        <circle cx="40" cy="32" r="4.2" />
      </g>
      <path
        className="face__line"
        style={{ strokeWidth: 4.4 }}
        d="M22.5 41c3 7.2 6.6 10.8 9.5 10.8s6.5-3.6 9.5-10.8"
      />
    </>
  ),

  wetter: (
    <>
      <g className="face__body">
        <circle cx="21" cy="34" r="14" />
        <circle cx="41" cy="30" r="17" />
        <rect x="9" y="35" width="46" height="18" rx="9" />
      </g>
      <g className="face__eyes">
        <circle cx="26" cy="33" r="3.4" />
        <circle cx="42" cy="31" r="3.4" />
      </g>
      <path className="face__line" style={{ strokeWidth: 3.6 }} d="M28 41c2.6 4.4 5.8 6.6 8.5 6.6s5.9-2.2 8.5-6.6" />
    </>
  ),

  einstellungen: (
    <>
      <g className="face__body">
        <circle cx="32.0" cy="15.0" r="12.5" />
        <circle cx="46.7" cy="23.5" r="12.5" />
        <circle cx="46.7" cy="40.5" r="12.5" />
        <circle cx="32.0" cy="49.0" r="12.5" />
        <circle cx="17.3" cy="40.5" r="12.5" />
        <circle cx="17.3" cy="23.5" r="12.5" />
        <circle cx="32" cy="32" r="17" />
      </g>
      <g className="face__line" style={{ strokeWidth: 3.6 }}>
        <path d="M18.5 31q5.5 -7 11 0" />
        <path d="M34.5 31q5.5 -7 11 0" />
      </g>
      <path className="face__line" style={{ strokeWidth: 3.4 }} d="M24.5 38.5c3.15 4.65 7.95 6.75 15 0" />
    </>
  ),

  anmelden: (
    <>
      <path
        className="face__body"
        style={{ stroke: 'var(--face-body)', strokeWidth: 10, strokeLinejoin: 'round' }}
        d="M32.0 7.0L39.6 21.5L55.8 24.3L44.4 36.0L46.7 52.2L32.0 45.0L17.3 52.2L19.6 36.0L8.2 24.3L24.4 21.5Z"
      />
      <g className="face__eyes">
        <circle cx="25" cy="29" r="3.6" />
        <circle cx="39" cy="29" r="3.6" />
      </g>
      <path className="face__line" d="M24 38.5c2.8 5 6.2 7.4 8 7.4s5.2-2.4 8-7.4" />
    </>
  ),
};
