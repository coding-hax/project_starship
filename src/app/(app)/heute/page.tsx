import { HabitToday } from '@/features/habits/habit-today';
import { TaskList } from '@/features/tasks/task-list';
import { WeatherForecast } from '@/features/weather/weather-forecast';
import { AppHeader } from '@/ui/app-header';

export const metadata = { title: 'Heute · Starship' };

export default function HeutePage() {
  return (
    <>
      <div className="heute__title-row">
        <h1>Heute</h1>
        <AppHeader variant="inline" />
      </div>
      <WeatherForecast />
      <h2 id="heute-aufgaben-heading">Aufgaben</h2>
      <TaskList dueTodayOnly headingId="heute-aufgaben-heading" />
      <h2>Gewohnheiten</h2>
      <HabitToday />
    </>
  );
}
