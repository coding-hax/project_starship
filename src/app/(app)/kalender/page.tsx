import type { Viewport } from 'next';
import { CalendarView } from '@/features/events/calendar-view';

export const metadata = { title: 'Kalender · Starship' };

// Android status bar colour (issue #882, AK4) — see uebersicht/page.tsx.
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#0d55d8' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1a18' },
  ],
};

export default function KalenderPage() {
  return (
    <div data-module="kalender" data-ground="kalender">
      <CalendarView />
    </div>
  );
}
