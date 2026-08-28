import type { Viewport } from 'next';
import { WeatherDayScreen } from '@/features/weather/weather-day';

export const metadata = { title: 'Wetter · Starship' };

// Android status bar colour (issue #882, AK4) — see uebersicht/page.tsx.
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#1c86c4' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1a18' },
  ],
};

export default async function WeatherDayPage({ params }: { params: Promise<{ datum: string }> }) {
  const { datum } = await params;

  return <WeatherDayScreen initialDate={datum} />;
}
