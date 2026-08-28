import type { Viewport } from 'next';
import { QuickAddTask } from '@/features/tasks/quick-add';
import { TaskList } from '@/features/tasks/task-list';
import { PageFace } from '@/ui/faces';
import './aufgaben-page.css';

export const metadata = { title: 'Aufgaben · Starship' };

// Android status bar colour (issue #882, AK4) — see uebersicht/page.tsx.
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#0e7c84' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1a18' },
  ],
};

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
