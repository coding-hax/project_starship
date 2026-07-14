import { TaskList } from '@/features/tasks/task-list';

export const metadata = { title: 'Aufgaben · Starship' };

export default function AufgabenPage() {
  return (
    <>
      <h1>Aufgaben</h1>
      <TaskList />
    </>
  );
}
