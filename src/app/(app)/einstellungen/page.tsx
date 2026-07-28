import Link from 'next/link';
import { ExportPanel } from '@/features/export/export-panel';
import { AppearancePanel } from '@/features/settings/appearance-panel';
import { CapturePanel } from '@/features/settings/capture-panel';
import { ModulePanel } from '@/features/settings/module-panel';
import { NavOrderPanel } from '@/features/settings/nav-order-panel';
import { PushPanel } from '@/features/settings/push-panel';
import { WeatherPanel } from '@/features/settings/weather-panel';
import { IconChevronLeft } from '@/ui/icons';

export const metadata = { title: 'Einstellungen · Starship' };

export default function EinstellungenPage() {
  return (
    <>
      <header className="einstellungen__topbar">
        <Link href="/uebersicht" className="einstellungen__back">
          <IconChevronLeft />
          Übersicht
        </Link>
        <h1 className="einstellungen__title">Einstellungen</h1>
      </header>
      <AppearancePanel />
      <NavOrderPanel />
      <ModulePanel />
      <CapturePanel />
      <PushPanel />
      <WeatherPanel />
      <ExportPanel />
    </>
  );
}
