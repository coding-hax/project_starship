import { AddHabitFab } from '@/features/habits/add-habit-fab';
import { HabitList } from '@/features/habits/habit-list';

export const metadata = { title: 'Gewohnheiten verwalten · Starship' };

export default function GewohnheitenPage() {
  return (
    <>
      <h1>Gewohnheiten verwalten</h1>
      <HabitList />
      <AddHabitFab />
    </>
  );
}
