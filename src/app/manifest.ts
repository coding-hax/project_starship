import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Starship',
    short_name: 'Starship',
    description: 'Termine, Aufgaben, Journal und Gewohnheiten an einem Ort.',
    start_url: '/heute',
    // Home-screen launch must open standalone, not in a Safari tab.
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#faf8f5',
    theme_color: '#faf8f5',
    lang: 'de',
    dir: 'ltr',
    categories: ['productivity'],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
