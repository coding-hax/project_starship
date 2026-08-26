import { ActivityList } from '@/features/activities/activity-list';
import './aktivitaeten-page.css';

export const metadata = { title: 'Aktivitäten · Starship' };

export default function AktivitaetenPage() {
  return (
    <div data-module="aktivitaeten" data-ground="aktivitaeten">
      <h1>Aktivitäten</h1>
      <ActivityList />
    </div>
  );
}
