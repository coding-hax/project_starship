import type { Viewport } from 'next';

// `page.tsx` in this segment is a Client Component (`'use client'`), where a
// `viewport` export is a Next build error — this layout exists only to carry
// it (issue #882, AK4). Dark colour is a flat tone, not the route's mixed
// dark ground: keeps this driftfree with the other eight routes' Server
// Component exports without recomputing their `color-mix()`.
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fda577' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1a18' },
  ],
};

export default function AnmeldenLayout({ children }: { children: React.ReactNode }) {
  return children;
}
