import { UebersichtCapture } from '@/features/tasks/uebersicht-capture';
import { AppHeader } from '@/ui/app-header';
import { DailyProgressRing } from './daily-progress-ring';
import { UebersichtSections } from './uebersicht-sections';

export const metadata = { title: 'Übersicht · Starship' };

export default function UebersichtPage() {
  return (
    <>
      <div className="uebersicht__title-row">
        <h1>Übersicht</h1>
        <UebersichtCapture />
        <AppHeader variant="inline" />
      </div>
      <DailyProgressRing />
      <UebersichtSections />
    </>
  );
}
