import { CalendarView } from '@/features/events/calendar-view';

export const metadata = { title: 'Kalender · Starship' };

export default function KalenderPage() {
  return (
    <div data-module="kalender" data-ground="kalender">
      <CalendarView />
    </div>
  );
}
