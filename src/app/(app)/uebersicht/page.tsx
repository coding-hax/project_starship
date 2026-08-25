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
      <div className="uebersicht__title-row" data-ground="uebersicht">
        <h1>Übersicht</h1>
        <div className="uebersicht__title-actions">
          <div className="uebersicht__capture-group">
            <UebersichtCapture />
            {/* Fest bemessener Slot (48×48px), unabhängig vom Ladezustand des Rings
                gerendert — er hält die Titelzeile stabil, nicht ein Beitritt zum
                Enthüllungspunkt (issue #652, siehe daily-progress-ring.tsx). */}
            <div className="daily-progress-ring-slot">
              <DailyProgressRing />
            </div>
          </div>
          <AppHeader variant="inline" />
        </div>
      </div>
      <OverviewReadyProvider>
        <UebersichtSections />
      </OverviewReadyProvider>
    </>
  );
}
