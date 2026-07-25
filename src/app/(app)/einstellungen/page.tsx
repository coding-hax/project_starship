import { ExportPanel } from '@/features/export/export-panel';
import { AppearancePanel } from '@/features/settings/appearance-panel';
import { CapturePanel } from '@/features/settings/capture-panel';
import { WeatherPanel } from '@/features/settings/weather-panel';

export const metadata = { title: 'Einstellungen · Starship' };

export default function EinstellungenPage() {
  return (
    <>
      <h1>Einstellungen</h1>
      <AppearancePanel />
      <CapturePanel />
      <WeatherPanel />
      <ExportPanel />
    </>
  );
}
