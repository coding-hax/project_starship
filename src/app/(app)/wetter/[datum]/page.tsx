import Link from 'next/link';
import { formatDayHeading } from '@/features/weather/forecast';
import { WeatherDayDetail } from '@/features/weather/weather-day';
import { IconChevronLeft } from '@/ui/icons';

export const metadata = { title: 'Wetter · Starship' };

export default async function WeatherDayPage({ params }: { params: Promise<{ datum: string }> }) {
  const { datum } = await params;

  return (
    <>
      {/* Der Weg zurück ist offensichtlich (issue #156 AC7) — die Bottom-Nav aus dem
          Shell-Layout bleibt zusätzlich bedienbar, dieser Screen fügt sich nur ein. */}
      <Link href="/uebersicht" className="weather-day__back">
        <IconChevronLeft />
        Heute
      </Link>
      <h1>{formatDayHeading(datum)}</h1>
      <WeatherDayDetail date={datum} />
    </>
  );
}
