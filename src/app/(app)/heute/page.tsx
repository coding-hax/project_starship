import Link from 'next/link';
import { HabitToday } from '@/features/habits/habit-today';
import { TaskList } from '@/features/tasks/task-list';

export const metadata = { title: 'Heute · Starship' };

export default function HeutePage() {
  return (
    <>
      <h1>Heute</h1>
      <TaskList dueTodayOnly />
      <h2>Gewohnheiten</h2>
      <HabitToday />
      <Link href="/gewohnheiten" className="heute__habits-link">
        Gewohnheiten verwalten
      </Link>
    </>
  );
}
