import { TaskList } from '@/features/tasks/task-list';

export const metadata = { title: 'Heute · Starship' };

export default function HeutePage() {
  return (
    <>
      <h1>Heute</h1>
      <TaskList dueTodayOnly />
    </>
  );
}
