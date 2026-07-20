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
      {/* Habits have no tab of their own (DESIGN_SYSTEM.md) — this is their entry
          point into the management screen, per issue #102. */}
      <Link href="/heute/gewohnheiten" className="heute__habits-link">
        Gewohnheiten verwalten
      </Link>
    </>
  );
}
