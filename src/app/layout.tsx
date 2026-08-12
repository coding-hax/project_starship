import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { LEGACY_MODULE_IDS } from '@/modules/module-ids';
import { KeyboardInset } from '@/ui/keyboard-inset';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  // 'optional' statt 'swap' (issue #652): auch mit next/fonts automatisch
  // metrik-angepasstem Fallback bleibt bei 'swap' eine Spätladung, die den
  // Zeilenkasten der Titelzeile minimal nachzieht — genug, dass die Layout
  // Instability API einen Eintrag meldet (CI-Fund: „h1 +
  // div.uebersicht__title-actions"), auch wenn er lokal, mit warmem
  // Font-Cache, nie auftritt. 'optional' tauscht die Schrift nach dem sehr
  // kurzen Blockfenster nicht mehr nach, sondern bleibt für diesen
  // Seitenaufruf beim Fallback — keine Spätladung, kein Shift.
  display: 'optional',
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
    statusBarStyle: 'default',
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de" className={inter.variable}>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
        <KeyboardInset />
        {children}
      </body>
    </html>
  );
}
