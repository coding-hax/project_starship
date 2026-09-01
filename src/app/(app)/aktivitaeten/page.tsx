import type { Viewport } from 'next';
import { ActivityList } from '@/features/activities/activity-list';
import './aktivitaeten-page.css';

export const metadata = { title: 'Aktivitäten · Starship' };

// Android status bar colour (issue #882, AK4) — see uebersicht/page.tsx.
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fac881' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1a18' },
  ],
};

export default function AktivitaetenPage() {
  return (
    <div data-module="aktivitaeten" data-ground="aktivitaeten">
      <ActivityList />
    </div>
  );
}
