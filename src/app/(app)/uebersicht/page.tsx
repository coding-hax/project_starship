import type { Viewport } from 'next';
import { UebersichtCapture } from '@/features/tasks/uebersicht-capture';
import { AppHeader } from '@/ui/app-header';
import { PageFace } from '@/ui/faces';
import { OverviewReadyProvider } from '@/ui/overview-ready';
import { PageHead } from '@/ui/page-head';
import { TodayLongDate } from '@/ui/today-long-date';
import { DailyProgressRing } from './daily-progress-ring';
import { GreetingHeading } from './greeting-heading';
import { UebersichtSections } from './uebersicht-sections';
import { UebersichtSubline } from './uebersicht-subline';

export const metadata = { title: 'Übersicht · Starship' };

// Android status bar colour (issue #882, AK4) — Chrome picks the glyph
// colour itself. Dark is a flat tone, not this route's mixed dark ground:
// keeps every route's export driftfree, no `color-mix()` to duplicate here.
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ff6a00' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1a18' },
  ],
};

export default function UebersichtPage() {
  return (
    <>
      {/* Stays outside the provider on purpose: it is the fixed anchor everything
          else appears below, and the reveal shifts nothing only as long as it is
          already standing (issue #642). */}
      <PageHead
        rowClassName="uebersicht__title-row"
        dataGround="uebersicht"
        eyebrow={<TodayLongDate />}
        extra={<UebersichtSubline />}
      >
        <div className="uebersicht__title-cluster">
          <GreetingHeading />
          <PageFace face="uebersicht" />
        </div>
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
      </PageHead>
      <OverviewReadyProvider>
        <UebersichtSections />
      </OverviewReadyProvider>
    </>
  );
}
