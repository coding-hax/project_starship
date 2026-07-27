import { WeatherDayScreen } from '@/features/weather/weather-day';

export const metadata = { title: 'Wetter · Starship' };

export default async function WeatherDayPage({ params }: { params: Promise<{ datum: string }> }) {
  const { datum } = await params;

  return <WeatherDayScreen initialDate={datum} />;
}
