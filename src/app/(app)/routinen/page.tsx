import { AddHabitFab } from '@/features/habits/add-habit-fab';
import { HabitList } from '@/features/habits/habit-list';

export const metadata = { title: 'Routinen verwalten · Starship' };

export default function RoutinenPage() {
  return (
    <div data-module="routinen">
      <h1>Routinen verwalten</h1>
      <HabitList />
      <AddHabitFab />
    </div>
  );
}
