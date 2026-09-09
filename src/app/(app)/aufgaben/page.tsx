import type { Viewport } from 'next';
import { AufgabenView } from '@/features/tasks/aufgaben-view';
import './aufgaben-page.css';

export const metadata = { title: 'Aufgaben · Starship' };

// Android status bar colour (issue #882, AK4) — see uebersicht/page.tsx.
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#70a3a8' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1a18' },
  ],
};

export default function AufgabenPage() {
  return (
    <div data-module="aufgaben" data-ground="aufgaben">
      <AufgabenView />
    </div>
  );
}
