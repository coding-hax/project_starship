import type { Viewport } from 'next';
import { AddHabitFab } from '@/features/habits/add-habit-fab';
import { HabitHistoryCard } from '@/features/habits/habit-history-card';
import { HabitTable } from '@/features/habits/habit-table';
import { HabitTiles } from '@/features/habits/habit-tiles';
import { PageFace } from '@/ui/faces';
import { PageHead } from '@/ui/page-head';
import { TodayLongDate } from '@/ui/today-long-date';
import './routinen-page.css';

export const metadata = { title: 'Routinen · Starship' };

// Android status bar colour (issue #882, AK4) — see uebersicht/page.tsx.
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#7cc0a3' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1a18' },
  ],
};

export default function RoutinenPage() {
  return (
    <div data-module="routinen" data-ground="routinen">
      <PageHead rowClassName="page-face-row" eyebrow={<TodayLongDate />}>
        <h1>Routinen</h1>
        <PageFace face="routinen" />
      </PageHead>
      <HabitTiles />
      {/* Eigener Wrapper statt `HabitTable` direkt (issue #1125): die
          Komponente rendert je nach Zustand mehrere Geschwister auf
          oberster Ebene (Offline-Hinweis, Tabelle/Leertext, archivierter
          Bereich als eigene SectionCard) — dieser Block macht daraus
          verlässlich EIN Grid-Item für routinen-page.css, ab 1440px. */}
      <div className="routinen-page__table">
        <HabitTable />
      </div>
      <HabitHistoryCard />
      <AddHabitFab />
    </div>
  );
}
