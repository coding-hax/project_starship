import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Starship',
  description: 'Termine, Aufgaben, Journal und Gewohnheiten an einem Ort.',
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
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#faf8f5' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1a18' },
  ],
};

// Runs before the first paint so the chosen theme/text-scale apply immediately —
// without it, the page would flash light before this script's own React tree mounts
// and reads the same localStorage keys (`use-appearance.ts`, ADR-0006).
const THEME_BOOTSTRAP_SCRIPT = `(function () {
  try {
    var html = document.documentElement;
    var theme = localStorage.getItem('starship:theme');
    var reduceMotion = localStorage.getItem('starship:reduce-motion');
    var textScale = localStorage.getItem('starship:text-scale');
    if (theme === 'hell' || theme === 'dunkel') html.setAttribute('data-theme', theme);
    if (reduceMotion === 'true') html.setAttribute('data-reduce-motion', 'true');
    if (textScale) html.style.setProperty('--font-scale', textScale);
  } catch (e) {}
})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de" className={inter.variable}>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
