import Link from 'next/link';
import { IconChevronLeft } from '@/ui/icons';
import { EinstellungenSections } from './einstellungen-sections';

export const metadata = { title: 'Einstellungen · Starship' };

export default function EinstellungenPage() {
  return (
    <>
      <header className="einstellungen__topbar" data-ground="einstellungen">
        <Link href="/uebersicht" className="einstellungen__back">
          <IconChevronLeft />
          Übersicht
        </Link>
        <h1 className="einstellungen__title">Einstellungen</h1>
      </header>
      <EinstellungenSections />
    </>
  );
}
