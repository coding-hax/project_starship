import { AddHabitFab } from '@/features/habits/add-habit-fab';
import { HabitList } from '@/features/habits/habit-list';
import { WeeklyRecapCard } from '@/features/habits/weekly-recap-card';

export const metadata = { title: 'Routinen verwalten · Starship' };

export default function RoutinenPage() {
  return (
    <div data-module="routinen">
      <h1>Routinen verwalten</h1>
      {/* Umgezogen von /uebersicht (issue #652) — die tägliche Übersicht bekommt
          fünf einheitliche Modulköpfe und wird sonst zu voll; der Rückblick
          bleibt hier direkt bei der Verwaltung erreichbar. */}
      <WeeklyRecapCard />
      <HabitList />
      <AddHabitFab />
    </div>
  );
}
