import Link from 'next/link';
import { AppearancePanel } from '@/features/settings/appearance-panel';
import { ModulePanel } from '@/features/settings/module-panel';
import { NavOrderPanel } from '@/features/settings/nav-order-panel';
import { PushPanel } from '@/features/settings/push-panel';
import { IconChevronLeft } from '@/ui/icons';
import { EinstellungenSections } from './einstellungen-sections';

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
      <PushPanel />
      <EinstellungenSections />
    </>
  );
}
