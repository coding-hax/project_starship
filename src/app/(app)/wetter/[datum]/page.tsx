import Link from 'next/link';
import { formatDayHeading } from '@/features/weather/forecast';
import { WeatherDayDetail } from '@/features/weather/weather-day';
import { IconChevronLeft } from '@/ui/icons';

export const metadata = { title: 'Wetter · Starship' };

export default async function WeatherDayPage({ params }: { params: Promise<{ datum: string }> }) {
  const { datum } = await params;

  return (
    <>
      {/*
       * Der Weg zurück ist offensichtlich (issue #156 AC7) — die Bottom-Nav aus dem
       * Shell-Layout bleibt zusätzlich bedienbar, dieser Screen fügt sich nur ein.
       * Das Datum sitzt auf derselben Höhe rechts.
       *
       * Dieses <header> ist zugleich der Fokus-Fix: nach einer Client-Navigation
       * ruft der App-Router `focus()` auf dem ersten Element des neuen Segments auf
       * (next/dist/client/components/layout-router.js). War das der Zurück-Link,
       * lag danach dessen Akzent-Fokusring auf dem Bildschirm, bis irgendwo anders
       * hin geklickt wurde. Ein <header> ist nicht fokussierbar — der Aufruf verpufft.
       */}
      <header className="weather-day__topbar">
        <Link href="/uebersicht" className="weather-day__back">
          <IconChevronLeft />
          Heute
        </Link>
        <h1 className="weather-day__date">{formatDayHeading(datum)}</h1>
      </header>
      <WeatherDayDetail date={datum} />
    </>
  );
}
