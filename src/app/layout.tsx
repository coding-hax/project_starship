import type { Metadata, Viewport } from 'next';
import { Inter, Nunito } from 'next/font/google';
import { headers } from 'next/headers';
import './globals.css';
import { LEGACY_MODULE_IDS } from '@/modules/module-ids';
import { BackgroundCircles } from '@/ui/background-circles';
import { KeyboardInset } from '@/ui/keyboard-inset';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  // 'block' statt 'swap'/'optional' (issue #652). 'swap' blockte fast gar
  // nicht, zeigte die Titelzeile also fast immer zuerst im Fallback und tauschte
  // später sichtbar nach — genug, dass die Layout Instability API einen Eintrag
  // meldete (CI-Fund: „h1 + div.uebersicht__title-actions"). 'optional' behob
  // das, tauschte dafür nach seinem sehr kurzen Blockfenster gar nicht mehr
  // nach — geriet die erste Anfrage einer CI-Shard unter Last (Dev-Server
  // kompiliert die Route + lädt die selbstgehostete Schrift), blieb die
  // Titelzeile für den ganzen Seitenaufruf beim (breiteren) Fallback und riss
  // die 32px-Einzeiligkeit bei 375px (AC4, issue #651). 'block' hält die
  // Schrift bis zu 3s unsichtbar, statt sichtbar im Fallback zu starten — ein
  // Wechsel während dieses Fensters ist kein „Shift", weil vorher nichts zu
  // sehen war (Layout Instability API zählt nur bereits gemaltes). Bei einer
  // selbstgehosteten Schrift liegt das Laden weit unter 3s, auch unter
  // CI-Last, also landet praktisch immer Inter im ersten sichtbaren Frame —
  // nicht der Fallback.
  display: 'block',
});

// Web-Fallback für `--font-display` (issue #859, ADR-0027): trägt nur, wo
// `ui-rounded`/`'SF Pro Rounded'` nicht auflösen (CI/Linux-Chromium, Android,
// Windows) — auf dem Prüfgerät (Apple, Safari/PWA) wird diese Datei nie
// angefragt. `swap` statt `block`: anders als Inter (oben, #652) ist dieser
// Font nie die einzig sichtbare Schrift, `next/font`s Fallback-Metriken
// (`adjustFontFallback`, Default an) halten den Wechsel shift-frei (AK6).
const nunito = Nunito({
  subsets: ['latin'],
  weight: ['400', '600'],
  variable: '--font-nunito',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Starship',
  description: 'Termine, Aufgaben, Journal und Routinen an einem Ort.',
  applicationName: 'Starship',
  manifest: '/manifest.webmanifest',
  // iOS ignores the manifest for the home-screen icon and the standalone flag;
  // it reads these. Without them "Zum Home-Bildschirm" opens a Safari tab.
  appleWebApp: {
    capable: true,
    title: 'Starship',
    // 'black-translucent' (issue #882): lets the body's own background paint
    // under the status bar instead of iOS drawing an opaque bar of its own —
    // the only way to colour that strip at all. Trade-off iOS forces: the
    // glyphs (clock/battery/signal) are then always white and not themeable
    // per route, which is why globals.css darkens the safe-area band under
    // them (`--ground-notch`) instead of leaving the raw route colour there.
    statusBarStyle: 'black-translucent',
  },
  icons: {
    icon: [
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // Chrome/Android then resizes the layout to the keyboard natively; other engines
  // ignore it and lean on `keyboard-inset.tsx` instead. Harmless where unsupported.
  interactiveWidget: 'resizes-content',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#faf8f5' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1a18' },
  ],
};

// Runs before the first paint so the chosen theme/text-scale apply immediately —
// without it, the page would flash light before this script's own React tree mounts
// and reads the same localStorage keys (`use-appearance.ts`, ADR-0006). `data-modules-off`
// follows the same idea for an off module's route (issue #309): globals.css hides its
// `[data-module]` wrapper the instant this attribute lands, before the route guard
// (`module-route-guard.tsx`) even mounts.
//
// The legacy-id mapping is inlined from `LEGACY_MODULE_IDS` rather than imported,
// because this runs as a plain string before any bundle exists — but it is generated
// from the same constant `use-modules.ts` maps with, so the two can never drift. Without
// it, a module switched off under its old id would be visible for exactly one frame
// (issue #655): React would hide it on mount, which is the flash this script exists to
// prevent.
const LEGACY_MODULE_IDS_JSON = JSON.stringify(Object.fromEntries(LEGACY_MODULE_IDS));

const THEME_BOOTSTRAP_SCRIPT = `(function () {
  try {
    var html = document.documentElement;
    var theme = localStorage.getItem('starship:theme');
    var reduceMotion = localStorage.getItem('starship:reduce-motion');
    var textScale = localStorage.getItem('starship:text-scale');
    var modulesOff = localStorage.getItem('starship:modules-off');
    if (theme === 'hell' || theme === 'dunkel') html.setAttribute('data-theme', theme);
    if (reduceMotion === 'true') html.setAttribute('data-reduce-motion', 'true');
    if (textScale) html.style.setProperty('--font-scale', textScale);
    if (modulesOff) {
      var legacy = ${LEGACY_MODULE_IDS_JSON};
      var off = JSON.parse(modulesOff);
      if (Array.isArray(off) && off.length) {
        var mapped = [];
        for (var i = 0; i < off.length; i++) {
          var id = Object.prototype.hasOwnProperty.call(legacy, off[i]) ? legacy[off[i]] : off[i];
          if (mapped.indexOf(id) === -1) mapped.push(id);
        }
        html.setAttribute('data-modules-off', mapped.join(' '));
      }
    }
  } catch (e) {}
})();`;

// `headers()` makes the tree dynamic — the price of a per-response nonce (issue #753):
// the nonce must match the one on the CSP header middleware.ts just sent, so this
// can no longer be prerendered statically (reverses the optimisation from #599).
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    <html lang="de" className={`${inter.variable} ${nunito.variable}`}>
      <body>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
        <KeyboardInset />
        <BackgroundCircles />
        {children}
      </body>
    </html>
  );
}
