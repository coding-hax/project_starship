import { ActivityMonthStrip } from '@/features/activities/activity-month-strip';
import { HabitToday } from '@/features/habits/habit-today';
import { TaskList } from '@/features/tasks/task-list';
import { WeatherForecast } from '@/features/weather/weather-forecast';
import { AppHeader } from '@/ui/app-header';

export const metadata = { title: 'Übersicht · Starship' };

export default function UebersichtPage() {
  return (
    <>
      <div className="uebersicht__title-row">
        <h1>Übersicht</h1>
        <AppHeader variant="inline" />
      </div>
      <WeatherForecast />
      <h2 id="uebersicht-aufgaben-heading">Aufgaben</h2>
      <TaskList dueTodayOnly headingId="uebersicht-aufgaben-heading" />
      <ActivityMonthStrip />
      <h2>Gewohnheiten</h2>
      <HabitToday />
    </>
  );
}
