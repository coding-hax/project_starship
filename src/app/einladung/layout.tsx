import type { Viewport } from 'next';

// Same reasoning as anmelden/layout.tsx (issue #882 AK4): the page below this
// layout is a Client Component, where a `viewport` export is a Next build
// error. Same colours as `anmelden` — this route reuses its `data-ground`.
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fda577' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1a18' },
  ],
};

export default function EinladungLayout({ children }: { children: React.ReactNode }) {
  return children;
}
