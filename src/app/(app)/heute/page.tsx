import Link from 'next/link';
import { TaskList } from '@/features/tasks/task-list';

export const metadata = { title: 'Heute · Starship' };

export default function HeutePage() {
  return (
    <>
      <h1>Heute</h1>
      <TaskList dueTodayOnly />
      {/* Habits have no tab of their own (DESIGN_SYSTEM.md) — this is their entry
          point, per issue #102. */}
      <Link href="/heute/gewohnheiten" className="heute__habits-link">
        Gewohnheiten verwalten
      </Link>
    </>
  );
}
