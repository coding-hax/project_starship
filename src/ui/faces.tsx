import './faces.css';

/**
 * One inline-drawn silhouette per route (S4 of #828, issue #830). Server
 * component, no hooks/state — the blink lives entirely in faces.css keyframes
 * (same split as background-circles.tsx), so this renders on server and
 * client pages alike with zero client JS. Inline paths, not `<symbol>`+`<use>`:
 * CSS can't reach into a `<use>` shadow tree, so a shared `<symbol>` would
 * make every eye on the page blink in lockstep instead of each on its own.
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

export function PageFace({ face }: PageFaceProps) {
  return (
    <svg
      viewBox="0 0 40 40"
      aria-hidden="true"
      data-face={face}
      className={`page-face page-face--${face}`}
    >
      {FACE_CONTENT[face]}
    </svg>
  );
}

const FACE_CONTENT: Record<FaceName, React.ReactNode> = {
  // Rund, offene Augen (blinzeln), Lächeln.
  uebersicht: (
    <>
      <circle className="page-face__body" cx="20" cy="20" r="17" />
      <circle className="page-face__eye page-face__eye--l" cx="14.5" cy="18" r="2.3" />
      <circle className="page-face__eye page-face__eye--r" cx="25.5" cy="18" r="2.3" />
      <path className="page-face__mouth" d="M13 24.5Q20 30 27 24.5" />
    </>
  ),

  // Kiesel, zwinkert (nur das rechte Auge blinzelt, links bleibt zu), breites Grinsen.
  aufgaben: (
    <>
      <path
        className="page-face__body"
        d="M20 5c8 0 14 4 14 12 0 4-1.5 7-3 10-2 4.5-5.5 8-11 8s-9-3.5-11-8c-1.5-3-3-6-3-10 0-8 6-12 14-12Z"
      />
      <path className="page-face__eye page-face__eye--l" d="M12 17Q14.5 18.5 17 17" />
      <circle className="page-face__eye page-face__eye--r" cx="25.5" cy="17" r="2.3" />
      <path
        className="page-face__mouth page-face__mouth--grin"
        d="M11 25Q20 34 29 25Q20 30 11 25Z"
      />
    </>
  ),

  // Kuppel (Entwurf 08), lachende Augen (Bögen, kein Blinzeln), breites Grinsen.
  kalender: (
    <>
      <path
        className="page-face__body"
        d="M5 34C5 17 11 5 20 5S35 17 35 34c0 1.7-1.3 3-3 3H8c-1.7 0-3-1.3-3-3Z"
      />
      <path className="page-face__eye page-face__eye--l" d="M11.5 23Q14 19.5 16.5 23" />
      <path className="page-face__eye page-face__eye--r" d="M23.5 23Q26 19.5 28.5 23" />
      <path
        className="page-face__mouth page-face__mouth--grin"
        d="M12 26Q20 33 28 26Q20 30 12 26Z"
      />
    </>
  ),

  // Flamme, offene Augen (blinzeln), Grinsen.
  routinen: (
    <>
      <path
        className="page-face__body"
        d="M20 4c1 7 5 10.5 8.5 14.5 3 3.5 5.5 7.5 5.5 12a14 14 0 0 1-28 0c0-4.5 2.5-8.5 5.5-12 0.5 2.5 1.5 4.5 3 6-1-7.5 1-14.5 5.5-20.5Z"
      />
      <circle className="page-face__eye page-face__eye--l" cx="15" cy="24" r="2.2" />
      <circle className="page-face__eye page-face__eye--r" cx="25" cy="24" r="2.2" />
      <path
        className="page-face__mouth page-face__mouth--grin"
        d="M13 28Q20 35 27 28Q20 32 13 28Z"
      />
    </>
  ),

  // Kristall, Augen zu, gelassenes Lächeln.
  journal: (
    <>
      <path className="page-face__body" d="M20 4 31 15 26 36 14 36 9 15Z" />
      <path className="page-face__eye page-face__eye--l" d="M12.5 17Q15 19 17.5 17" />
      <path className="page-face__eye page-face__eye--r" d="M22.5 17Q25 19 27.5 17" />
      <path className="page-face__mouth" d="M15 27Q20 29.5 25 27" />
    </>
  ),

  // Tropfen, große Augen (blinzeln), offenes Lachen.
  aktivitaeten: (
    <>
      <path
        className="page-face__body"
        d="M20 4c7 9 12 15.5 12 22a12 12 0 0 1-24 0c0-6.5 5-13 12-22Z"
      />
      <circle className="page-face__eye page-face__eye--l" cx="15" cy="23" r="3" />
      <circle className="page-face__eye page-face__eye--r" cx="25" cy="23" r="3" />
      <path
        className="page-face__mouth page-face__mouth--grin"
        d="M12 27Q20 36 28 27Q20 33 12 27Z"
      />
    </>
  ),

  // Wolke, offene Augen (blinzeln), ruhiges Lächeln.
  wetter: (
    <>
      <path
        className="page-face__body"
        d="M10 32h20a8 8 0 0 0 .7-16 11 11 0 0 0-21.3 2.7A7 7 0 0 0 10 32Z"
      />
      <circle className="page-face__eye page-face__eye--l" cx="16" cy="23" r="2.1" />
      <circle className="page-face__eye page-face__eye--r" cx="24" cy="23" r="2.1" />
      <path className="page-face__mouth" d="M15 27Q20 29 25 27" />
    </>
  ),

  // Blüte (Entwurf 13), lachende Augen (Bögen, kein Blinzeln), Lächeln.
  einstellungen: (
    <>
      <g className="page-face__body">
        <circle cx="20" cy="20" r="8" />
        <circle cx="20" cy="12" r="8" />
        <circle cx="27.6" cy="17.5" r="8" />
        <circle cx="24.7" cy="26.5" r="8" />
        <circle cx="15.3" cy="26.5" r="8" />
        <circle cx="12.4" cy="17.5" r="8" />
      </g>
      <path className="page-face__eye page-face__eye--l" d="M13.5 20Q16 17 18.5 20" />
      <path className="page-face__eye page-face__eye--r" d="M21.5 20Q24 17 26.5 20" />
      <path className="page-face__mouth" d="M15 25Q20 28 25 25" />
    </>
  ),

  // Stern, offene Augen (blinzeln), Lächeln.
  anmelden: (
    <>
      <path
        className="page-face__body"
        d="M20 3 24.1 14.3 36.2 14.7 26.7 22.2 30 33.8 20 27 10 33.8 13.3 22.2 3.8 14.7 15.9 14.3Z"
      />
      <circle className="page-face__eye page-face__eye--l" cx="15" cy="19" r="2.2" />
      <circle className="page-face__eye page-face__eye--r" cx="25" cy="19" r="2.2" />
      <path className="page-face__mouth" d="M14 24Q20 27.5 26 24" />
    </>
  ),
};
