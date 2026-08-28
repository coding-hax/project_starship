import type { Viewport } from 'next';
import { AddHabitFab } from '@/features/habits/add-habit-fab';
import { HabitList } from '@/features/habits/habit-list';
import { StreakSummaryCard } from '@/features/habits/streak-summary-card';
import { PageFace } from '@/ui/faces';

export const metadata = { title: 'Routinen verwalten · Starship' };

// Android status bar colour (issue #882, AK4) — see uebersicht/page.tsx.
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#12a67a' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1a18' },
  ],
};

export default function RoutinenPage() {
  return (
    <div data-module="routinen" data-ground="routinen">
      <div className="page-face-row">
        <h1>Routinen verwalten</h1>
        <PageFace face="routinen" />
      </div>
      {/* Umgezogen von /uebersicht (issue #652) — die tägliche Übersicht bekommt
          fünf einheitliche Modulköpfe und wird sonst zu voll; die Karte
          bleibt hier direkt bei der Verwaltung erreichbar. */}
      <StreakSummaryCard />
      <HabitList />
      <AddHabitFab />
    </div>
  );
}
