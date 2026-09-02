import type { Viewport } from 'next';
import { AddHabitFab } from '@/features/habits/add-habit-fab';
import { HabitHistoryCard } from '@/features/habits/habit-history-card';
import { HabitTable } from '@/features/habits/habit-table';
import { HabitTiles } from '@/features/habits/habit-tiles';
import { PageFace } from '@/ui/faces';
import { PageHead } from '@/ui/page-head';
import { TodayLongDate } from '@/ui/today-long-date';

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
      <HabitTable />
      <HabitHistoryCard />
      <AddHabitFab />
    </div>
  );
}
