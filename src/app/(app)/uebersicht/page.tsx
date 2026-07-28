import { AppHeader } from '@/ui/app-header';
import { UebersichtSections } from './uebersicht-sections';

export const metadata = { title: 'Übersicht · Starship' };

export default function UebersichtPage() {
  return (
    <>
      <div className="uebersicht__title-row">
        <h1>Übersicht</h1>
        <AppHeader variant="inline" />
      </div>
      <UebersichtSections />
    </>
  );
}
