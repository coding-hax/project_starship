'use client';

import Link from 'next/link';
import { IconChevronRight } from '@/ui/icons';
import { SectionCard } from '@/ui/section-card';
import './verwaltung-panel.css';

/**
 * The one entry point to /admin from inside the app (S4, #1203 AK10) — only
 * ever rendered for an admin account, see `einstellungen-sections.tsx`'s own
 * `useIsAdmin()` check, which keeps a `user` account from finding this whole
 * group in the DOM at all (same reasoning as AK1: the existence of /admin is
 * not information a non-admin account gets to have).
 */
export function VerwaltungPanel() {
  return (
    <SectionCard title="Verwaltung" className="verwaltung-panel">
      <Link href="/admin" className="verwaltung-panel__link">
        <span>Admin-Bereich</span>
        <IconChevronRight className="verwaltung-panel__chevron" />
      </Link>
    </SectionCard>
  );
}
