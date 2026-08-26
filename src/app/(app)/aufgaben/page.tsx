import { QuickAddTask } from '@/features/tasks/quick-add';
import { TaskList } from '@/features/tasks/task-list';
import { PageFace } from '@/ui/faces';
import './aufgaben-page.css';

export const metadata = { title: 'Aufgaben · Starship' };

export default function AufgabenPage() {
  return (
    <div data-module="aufgaben" data-ground="aufgaben">
      <div className="aufgaben-page__title-row">
        <h1>Aufgaben</h1>
        <PageFace face="aufgaben" />
      </div>
      <TaskList />
      <QuickAddTask />
    </div>
  );
}
