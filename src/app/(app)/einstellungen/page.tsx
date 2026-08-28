import type { Viewport } from 'next';
import Link from 'next/link';
import { IconChevronLeft } from '@/ui/icons';
import { PageFace } from '@/ui/faces';
import { EinstellungenSections } from './einstellungen-sections';

export const metadata = { title: 'Einstellungen · Starship' };

// Android status bar colour (issue #882, AK4) — see uebersicht/page.tsx.
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#46525e' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1a18' },
  ],
};

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
