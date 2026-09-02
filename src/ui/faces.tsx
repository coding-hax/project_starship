import './faces.css';

/**
 * One inline-drawn silhouette per route (S4 of #828, issue #830; redrawn to
 * match the design sheet in issue #850). Server component, no hooks/state —
 * blink and bob live entirely in faces.css keyframes (same split as
 * background-arcs.tsx), so this renders on server and client pages alike
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

/**
 * Tagesgesicht (issue #864, AK1): 32 Varianten der Übersicht-Figur, acht je
 * Tageszeit-Block, aus denselben Bausteinen wie oben (Körper/Zubehör/Augen/
 * Mund) zusammengesetzt — Zuordnung und Reihenfolge (Index 0…7 je Block)
 * wortgleich zum Bauplan in #864. Welche der acht Figuren an einem Tag
 * gezogen wird, entscheidet `tagesgesicht.ts` (eigene Datei, reine Funktion);
 * diese Datei liefert nur die Bausteine.
 */

export type TagesgesichtBlock = 'morgen' | 'mittag' | 'abend' | 'nacht';

type Koerper = 'rund' | 'kiesel' | 'kuppel' | 'tropfen' | 'ei' | 'breit' | 'wolke' | 'sichel';

const KOERPER: Record<Koerper, React.ReactNode> = {
  rund: (
    <path
      className="face__body"
      d="M32 3c15.5 0 26 10.5 26 26.5C58 47.5 46.5 61 32 61S6 47.5 6 29.5C6 13.5 16.5 3 32 3z"
    />
  ),
  kiesel: <path className="face__body" d="M32 5c19.5 0 27 7.5 27 27s-7.5 27-27 27S5 51.5 5 32 12.5 5 32 5z" />,
  kuppel: (
    <path className="face__body" d="M32 6a26 26 0 0126 26v17a5 5 0 01-5 5H11a5 5 0 01-5-5V32A26 26 0 0132 6z" />
  ),
  tropfen: (
    <path
      className="face__body"
      d="M32 3c12.5 10.5 22.5 19 22.5 31.5a22.5 22.5 0 11-45 0C9.5 22 19.5 13.5 32 3z"
    />
  ),
  ei: <ellipse className="face__body" cx="32" cy="32" rx="23" ry="27" />,
  breit: <ellipse className="face__body" cx="32" cy="35" rx="27" ry="20" />,
  wolke: (
    <g className="face__body">
      <circle cx="21" cy="34" r="14" />
      <circle cx="41" cy="30" r="17" />
      <rect x="9" y="35" width="46" height="18" rx="9" />
    </g>
  ),
  sichel: <path className="face__body" d="M44 13.2A24 24 0 1 0 44 54.8A26 26 0 0 1 44 13.2Z" />,
};

function augenOffen(lx: number, rx: number, y: number, r = 3.8) {
  return (
    <g className="face__eyes">
      <circle cx={lx} cy={y} r={r} />
      <circle cx={rx} cy={y} r={r} />
    </g>
  );
}

function augenZu(lx: number, rx: number, y: number) {
  return (
    <g className="face__eyes face__eyes--drawn">
      <path d={`M${lx} ${y}c2.4-3.2 6-3.2 8.4 0`} />
      <path d={`M${rx} ${y}c2.4-3.2 6-3.2 8.4 0`} />
    </g>
  );
}

function augenFlach(lx: number, rx: number, y: number) {
  return (
    <g className="face__line" style={{ strokeWidth: 3.6 }}>
      <path d={`M${lx} ${y}h10`} />
      <path d={`M${rx} ${y}h10`} />
    </g>
  );
}

function augenSchlitz(lx: number, rx: number, y: number) {
  return (
    <g className="face__line" style={{ strokeWidth: 3.2 }}>
      <path d={`M${lx} ${y}q5 2.2 10 0`} />
      <path d={`M${rx} ${y}q5 2.2 10 0`} />
    </g>
  );
}

function augenLachend(lx: number, rx: number, y: number) {
  return (
    <g className="face__line" style={{ strokeWidth: 3.6 }}>
      <path d={`M${lx} ${y}q5.5 -7 11 0`} />
      <path d={`M${rx} ${y}q5.5 -7 11 0`} />
    </g>
  );
}

function augenZwinkernd(lx: number, rx: number, y: number, r = 3.8) {
  return (
    <>
      <g className="face__eyes">
        <circle cx={lx} cy={y} r={r} />
      </g>
      <path className="face__line" style={{ strokeWidth: 3.4 }} d={`M${rx} ${y + 0.5}c2.4-3.2 6-3.2 8.4 0`} />
    </>
  );
}

function augenHalb(lx: number, rx: number, y: number, r = 5) {
  return (
    <g className="face__eyes">
      <path d={`M${lx} ${y}a${r} ${r} 0 0 1 10 0z`} />
      <path d={`M${rx} ${y}a${r} ${r} 0 0 1 10 0z`} />
    </g>
  );
}

function augenStern(lx: number, rx: number, y: number) {
  const stern = (x: number) => `M${x} ${y - 5.4}l1.7 3.7 3.7 1.7-3.7 1.7L${x} ${y + 5.4}l-1.7-3.7-3.7-1.7 3.7-1.7z`;
  return (
    <g className="face__eyes">
      <path d={stern(lx)} />
      <path d={stern(rx)} />
    </g>
  );
}

function mundLaecheln(cx: number, cy: number, amplitude = 7.6) {
  return <path className="face__line" d={`M${cx - 8} ${cy}Q${cx} ${cy + amplitude} ${cx + 8} ${cy}`} />;
}

function mundGrinsen(cx: number, cy: number, amplitude = 14.85) {
  return <path className="face__line" d={`M${cx - 11} ${cy}Q${cx} ${cy + amplitude} ${cx + 11} ${cy}`} />;
}

function mundStrich(cx: number, cy: number, halbbreite: number) {
  return <path className="face__line" d={`M${cx - halbbreite} ${cy}h${halbbreite * 2}`} />;
}

function mundWelle(cx: number, cy: number) {
  return <path className="face__line" style={{ strokeWidth: 3.6 }} d={`M${cx - 6} ${cy}q3 -3.6 6 0t6 0`} />;
}

function mundRund(cx: number, cy: number, r = 4) {
  return <circle className="face__ink" cx={cx} cy={cy} r={r} />;
}

function mundOffen(cx: number, cy: number, rx = 6.5, ry = 9) {
  return <ellipse className="face__ink" cx={cx} cy={cy} rx={rx} ry={ry} />;
}

type Zubehoer = 'bueschel' | 'muetze' | 'maske' | 'z1' | 'z2' | 'funken' | 'sterne' | 'dampf' | 'brauen';

const ZUBEHOER: Record<Zubehoer, React.ReactNode> = {
  bueschel: <path className="face__body" d="M29 5c1.5-4.5 6.5-5.5 9.5-3.5-3.5 1-4.5 3.5-3 6z" />,
  muetze: (
    <>
      <path className="face__ink" d="M11 21C15 7 30 0 45 7l-5 13z" />
      <circle className="face__ink" cx="47" cy="6" r="4.5" />
    </>
  ),
  maske: (
    <>
      <rect className="face__ink" x="9" y="23" width="46" height="13" rx="6.5" />
      <path className="face__line" style={{ strokeWidth: 2.6 }} d="M9 27c-3 1-4 3-4 5M55 27c3 1 4 3 4 5" />
    </>
  ),
  z1: <path className="face__line" style={{ strokeWidth: 2.8 }} d="M53 1h7l-7 8h7" />,
  z2: (
    <>
      <path className="face__line" style={{ strokeWidth: 3.2 }} d="M50 0h9l-9 10h9" />
      <path className="face__line" style={{ strokeWidth: 2.4 }} d="M62 13h5l-5 6h5" />
    </>
  ),
  funken: (
    <>
      <path className="face__ink" d="M52 8l1.7 4.6L58 14l-4.3 1.4L52 20l-1.7-4.6L46 14l4.3-1.4z" />
      <path className="face__ink" d="M4 12l1.2 3.2L8 16.5l-2.8 1L4 21l-1.2-3.5L0 16.5l2.8-1.3z" />
    </>
  ),
  sterne: (
    <>
      <path className="face__ink" d="M5 8l1.3 3.4L10 12.7l-3.7 1.2L5 18l-1.3-4.1L0 12.7l3.7-1.3z" />
      <path className="face__ink" d="M59 14l1 2.8 2.9 1-2.9 1L59 22l-1-2.2-2.9-1 2.9-1z" />
    </>
  ),
  dampf: <path className="face__line" style={{ strokeWidth: 2.6 }} d="M32 5c-3.5-3 3.5-5.5 0-9" />,
  brauen: <path className="face__line" style={{ strokeWidth: 3.2 }} d="M15 21l10 4M49 21l-10 4" />,
};

interface TagesgesichtFigur {
  koerper: Koerper;
  zubehoer?: Zubehoer;
  augen: React.ReactNode | null;
  mund: React.ReactNode;
  rotateDeg?: number;
}

// Bauplan aus #864, Reihenfolge Mo/Mi/Ab/Na 01…08 = Index 0…7 je Block.
const TAGESGESICHT_FIGUREN: Record<TagesgesichtBlock, TagesgesichtFigur[]> = {
  morgen: [
    { koerper: 'rund', augen: augenZu(23, 41, 26), mund: mundOffen(32, 43) }, // Gähnt
    { koerper: 'rund', augen: augenHalb(23, 41, 28), mund: mundStrich(32, 44, 5) }, // Halb wach
    { koerper: 'kiesel', augen: augenSchlitz(23, 41, 29), mund: mundLaecheln(32, 41, 7) }, // Schlitzaugen
    { koerper: 'rund', zubehoer: 'bueschel', augen: augenHalb(23, 41, 29), mund: mundWelle(32, 44) }, // Zerzaust
    { koerper: 'ei', augen: augenZwinkernd(24, 40, 29), mund: mundStrich(32, 44, 4.5) }, // Ein Auge auf
    { koerper: 'kuppel', augen: augenHalb(23, 41, 28, 6), mund: mundRund(32, 44, 3.6) }, // Verquollen
    { koerper: 'breit', zubehoer: 'z1', augen: augenZu(22, 42, 32), mund: mundLaecheln(32, 42, 6) }, // Döst noch
    { koerper: 'tropfen', augen: augenSchlitz(24, 40, 32), mund: mundLaecheln(32, 43, 7) }, // Blinzelt
  ],
  mittag: [
    { koerper: 'rund', augen: augenOffen(23, 41, 27), mund: mundGrinsen(32, 38) }, // Grinst
    { koerper: 'kiesel', augen: augenZwinkernd(23, 41, 28), mund: mundGrinsen(32, 39) }, // Zwinkert
    { koerper: 'rund', augen: augenLachend(23, 41, 27), mund: mundGrinsen(32, 38) }, // Lacht
    { koerper: 'kuppel', augen: augenOffen(23, 41, 26, 4.4), mund: mundOffen(32, 42, 5.5, 7) }, // Ruft
    { koerper: 'ei', augen: augenStern(24, 40, 29), mund: mundLaecheln(32, 43, 8) }, // Funkelt
    { koerper: 'tropfen', zubehoer: 'funken', augen: augenOffen(24, 40, 31, 4.2), mund: mundGrinsen(32, 41, 10) }, // Voller Schwung
    { koerper: 'kiesel', zubehoer: 'brauen', augen: augenOffen(23, 41, 30), mund: mundStrich(32, 44, 6) }, // Entschlossen
    { koerper: 'ei', augen: augenOffen(24, 40, 28, 4.2), mund: mundGrinsen(32, 40, 10) }, // Springt
  ],
  abend: [
    { koerper: 'rund', augen: augenLachend(23, 41, 28), mund: mundLaecheln(32, 40, 9) }, // Zufrieden
    { koerper: 'breit', augen: augenHalb(22, 42, 32), mund: mundLaecheln(32, 42, 8) }, // Entspannt
    { koerper: 'ei', augen: augenZu(24, 40, 29), mund: mundRund(32, 43, 3.4) }, // Seufzt
    { koerper: 'rund', augen: augenLachend(23, 41, 28), mund: mundLaecheln(32, 40, 8), rotateDeg: 9 }, // Kopf schief
    { koerper: 'kuppel', zubehoer: 'dampf', augen: augenZu(23, 41, 29), mund: mundLaecheln(32, 42, 7) }, // Träumt
    { koerper: 'kiesel', augen: augenHalb(23, 41, 29), mund: mundGrinsen(32, 40, 9) }, // Warm
    { koerper: 'tropfen', augen: augenZu(24, 40, 32), mund: mundLaecheln(32, 43, 7) }, // Ruhig
    { koerper: 'wolke', augen: augenLachend(26, 42, 32), mund: mundLaecheln(34, 42, 8) }, // Weich
  ],
  nacht: [
    { koerper: 'rund', zubehoer: 'z2', augen: augenZu(23, 41, 29), mund: mundLaecheln(32, 42, 6) }, // Schläft
    { koerper: 'rund', zubehoer: 'maske', augen: null, mund: mundLaecheln(32, 44, 6) }, // Schlafmaske
    { koerper: 'breit', augen: augenZu(22, 42, 33), mund: mundStrich(32, 43, 4.5) }, // Eingerollt
    { koerper: 'sichel', augen: augenZu(16, 27, 31), mund: mundLaecheln(21, 40, 5.5) }, // Mond
    { koerper: 'kiesel', zubehoer: 'z1', augen: augenZu(23, 41, 29), mund: mundRund(32, 43, 4.2) }, // Schnarcht
    { koerper: 'rund', zubehoer: 'muetze', augen: augenZu(23, 41, 31), mund: mundLaecheln(32, 43, 6) }, // Zipfelmütze
    { koerper: 'ei', augen: augenFlach(24, 40, 30), mund: mundStrich(32, 43, 4) }, // Tiefschlaf
    { koerper: 'kuppel', zubehoer: 'sterne', augen: augenZu(23, 41, 30), mund: mundLaecheln(32, 43, 6.5) }, // Sternennacht
  ],
};

type TagesgesichtFaceProps = {
  block: TagesgesichtBlock;
  index: number;
};

/** Eine der 32 Tagesgesicht-Varianten (issue #864, AK1) — welcher `index` (0…7) je `block` gezeigt wird, entscheidet `tagesgesicht.ts`. */
export function TagesgesichtFace({ block, index }: TagesgesichtFaceProps) {
  const figur = TAGESGESICHT_FIGUREN[block][index];
  const inhalt = (
    <>
      {KOERPER[figur.koerper]}
      {figur.zubehoer ? ZUBEHOER[figur.zubehoer] : null}
      {figur.augen}
      {figur.mund}
    </>
  );

  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" data-face="uebersicht" className="face face--slow">
      {figur.rotateDeg ? <g transform={`rotate(${figur.rotateDeg} 32 32)`}>{inhalt}</g> : inhalt}
    </svg>
  );
}
