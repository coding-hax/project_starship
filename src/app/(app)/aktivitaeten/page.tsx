import { ActivityList } from '@/features/activities/activity-list';
import { PageFace } from '@/ui/faces';
import './aktivitaeten-page.css';

export const metadata = { title: 'Aktivitäten · Starship' };

export default function AktivitaetenPage() {
  return (
    <div data-module="aktivitaeten" data-ground="aktivitaeten">
      <div className="page-face-row">
        <h1>Aktivitäten</h1>
        <PageFace face="aktivitaeten" />
      </div>
      <ActivityList />
    </div>
  );
}
