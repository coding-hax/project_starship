import Link from 'next/link';
import { IconChevronLeft } from '@/ui/icons';
import { PageFace } from '@/ui/faces';
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
        <div className="einstellungen__title-cluster">
          <h1 className="einstellungen__title">Einstellungen</h1>
          <PageFace face="einstellungen" />
        </div>
      </header>
      <EinstellungenSections />
    </>
  );
}
