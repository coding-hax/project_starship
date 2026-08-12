import { HideCompletedToggle } from '@/features/tasks/hide-completed-toggle';
import { QuickAddTask } from '@/features/tasks/quick-add';
import { TaskList } from '@/features/tasks/task-list';
import './aufgaben-page.css';

export const metadata = { title: 'Aufgaben · Starship' };

export default function AufgabenPage() {
  return (
    <div data-module="aufgaben">
      <div className="aufgaben-page__title-row">
        <h1>Aufgaben</h1>
        <HideCompletedToggle />
      </div>
      <TaskList />
      <QuickAddTask />
    </div>
  );
}
