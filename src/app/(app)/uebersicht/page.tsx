import { UebersichtCapture } from '@/features/tasks/uebersicht-capture';
import { AppHeader } from '@/ui/app-header';
import { OverviewReadyProvider } from '@/ui/overview-ready';
import { DailyProgressRing } from './daily-progress-ring';
import { UebersichtSections } from './uebersicht-sections';

export const metadata = { title: 'Übersicht · Starship' };

export default function UebersichtPage() {
  return (
    <>
      {/* Stays outside the provider on purpose: it is the fixed anchor everything
          else appears below, and the reveal shifts nothing only as long as it is
          already standing (issue #642). */}
      <div className="uebersicht__title-row">
        <h1>Übersicht</h1>
        <UebersichtCapture />
        <AppHeader variant="inline" />
      </div>
      <OverviewReadyProvider>
        <DailyProgressRing />
        <UebersichtSections />
      </OverviewReadyProvider>
    </>
  );
}
