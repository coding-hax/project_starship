import { ActivityList } from '@/features/activities/activity-list';

export const metadata = { title: 'Aktivitäten · Starship' };

export default function AktivitaetenPage() {
  return (
    <>
      <h1>Aktivitäten</h1>
      <ActivityList />
    </>
  );
}
