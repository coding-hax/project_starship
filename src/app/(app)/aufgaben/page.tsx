import type { Viewport } from 'next';
import { AufgabenCount } from '@/features/tasks/aufgaben-count';
import { QuickAddTask } from '@/features/tasks/quick-add';
import { TaskList } from '@/features/tasks/task-list';
import { PageFace } from '@/ui/faces';
import { PageHead } from '@/ui/page-head';
import './aufgaben-page.css';

export const metadata = { title: 'Aufgaben · Starship' };

// Android status bar colour (issue #882, AK4) — see uebersicht/page.tsx.
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#70a3a8' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1a18' },
  ],
};

export default function AufgabenPage() {
  return (
    <div data-module="aufgaben" data-ground="aufgaben">
      <PageHead rowClassName="aufgaben-page__title-row" eyebrow={<AufgabenCount />}>
        <h1>Aufgaben</h1>
        <PageFace face="aufgaben" />
      </PageHead>
      <TaskList />
      <QuickAddTask />
    </div>
  );
}
