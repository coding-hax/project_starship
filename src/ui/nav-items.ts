import { IconActivity, IconCalendar, IconHabits, IconJournal, IconTasks, IconToday } from './icons';
import type { ComponentType } from 'react';

export interface NavItem {
  id: string;
  href: string;
  label: string;
  accent: string;
  Icon: ComponentType<{ className?: string }>;
}

/**
 * One source for every nav entry — `nav.tsx` and the settings order panel both read
 * from here (issue #205). `id` is the stable key the stored order (`use-nav-order.ts`)
 * points at; it must never change once shipped, or every device's saved order silently
 * drops that entry. #180 adds its Garmin tab as one more line here, nothing else.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'uebersicht', href: '/uebersicht', label: 'Übersicht', accent: 'var(--accent)', Icon: IconToday },
  { id: 'aufgaben', href: '/aufgaben', label: 'Aufgaben', accent: 'var(--area-tasks)', Icon: IconTasks },
  { id: 'gewohnheiten', href: '/gewohnheiten', label: 'Gewohnheiten', accent: 'var(--area-habits)', Icon: IconHabits },
  { id: 'kalender', href: '/kalender', label: 'Kalender', accent: 'var(--area-events)', Icon: IconCalendar },
  { id: 'journal', href: '/journal', label: 'Journal', accent: 'var(--area-journal)', Icon: IconJournal },
  { id: 'aktivitaeten', href: '/aktivitaeten', label: 'Aktivitäten', accent: 'var(--area-activities)', Icon: IconActivity },
] as const;
