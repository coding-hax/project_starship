import { ActivityMonthStrip } from '@/features/activities/activity-month-strip';
import { EventsOverviewSection } from '@/features/events/events-overview-section';
import { ExportPanel } from '@/features/export/export-panel';
import { HabitsOverviewSection } from '@/features/habits/habits-overview-section';
import { JournalSettingsPanel } from '@/features/journal/journal-settings-panel';
import { CalendarSettingsPanel } from '@/features/settings/calendar-settings-panel';
import { CapturePanel } from '@/features/settings/capture-panel';
import { WeatherPanel } from '@/features/settings/weather-panel';
import { TasksOverviewSection } from '@/features/tasks/tasks-overview-section';
import { WeatherForecast } from '@/features/weather/weather-forecast';
import { IconActivity, IconCalendar, IconHabits, IconJournal, IconTasks, IconToday } from '@/ui/icons';
import type { ComponentType } from 'react';

export interface NavItem {
  id: string;
  href: string;
  label: string;
  accent: string;
  Icon: ComponentType<{ className?: string }>;
}

export interface ModuleDefinition {
  /** Stable key — the on/off exclusion list (`use-modules.ts`) and, for nav modules,
   * the stored nav order (`use-nav-order.ts`) both point at it. Never change once
   * shipped, or every device's saved state silently drops that entry. Changing one
   * anyway means adding a rename pair to `LEGACY_MODULE_IDS` (`module-ids.ts`) in the
   * same commit — that is what carries stored state across, see issue #655. */
  id: string;
  label: string;
  /** `core` modules have no toggle and are always active (ADR-0012). */
  core: boolean;
  /** Present only for modules with their own nav tab — `nav-items.ts` derives
   * `NAV_ITEMS` from these. */
  navItem?: NavItem;
  /** Rendered on /uebersicht when the module is active (issue #308) — self-contained,
   * including its own heading where it has one. */
  OverviewSection?: ComponentType;
  /** Rendered on /einstellungen when the module is active (issue #308). */
  SettingsPanel?: ComponentType;
  /** Path prefixes owned by this module — `module-route-guard.tsx` redirects a direct
   * call to any of these to /uebersicht while the module is off (issue #309, T3). Only
   * set for modules with a dedicated top-level route. */
  routes?: string[];
}

/**
 * Single source per module (ADR-0012, issue #307): `nav-items.ts` derives `NAV_ITEMS`
 * from this, `use-modules.ts` drives the on/off state, `module-panel.tsx` renders one
 * row per non-core entry, `OverviewSection`/`SettingsPanel` gate the matching section
 * on /uebersicht resp. /einstellungen (issue #308). `routes` gates direct navigation
 * to an off module's dedicated page via `module-route-guard.tsx` (issue #309).
 */
export const MODULES: readonly ModuleDefinition[] = [
  {
    id: 'uebersicht',
    label: 'Übersicht',
    core: true,
    navItem: { id: 'uebersicht', href: '/uebersicht', label: 'Übersicht', accent: 'var(--accent)', Icon: IconToday },
  },
  {
    id: 'aufgaben',
    label: 'Aufgaben',
    core: false,
    navItem: { id: 'aufgaben', href: '/aufgaben', label: 'Aufgaben', accent: 'var(--area-tasks)', Icon: IconTasks },
    OverviewSection: TasksOverviewSection,
    SettingsPanel: CapturePanel,
    routes: ['/aufgaben'],
  },
  {
    id: 'routinen',
    label: 'Routinen',
    core: false,
    navItem: {
      id: 'routinen',
      href: '/routinen',
      label: 'Routinen',
      accent: 'var(--area-habits)',
      Icon: IconHabits,
    },
    OverviewSection: HabitsOverviewSection,
    routes: ['/routinen'],
  },
  {
    id: 'kalender',
    label: 'Kalender',
    core: false,
    navItem: {
      id: 'kalender',
      href: '/kalender',
      label: 'Kalender',
      accent: 'var(--area-events)',
      Icon: IconCalendar,
    },
    OverviewSection: EventsOverviewSection,
    SettingsPanel: CalendarSettingsPanel,
    routes: ['/kalender'],
  },
  {
    id: 'journal',
    label: 'Journal',
    core: false,
    navItem: {
      id: 'journal',
      href: '/journal',
      label: 'Journal',
      accent: 'var(--area-journal)',
      Icon: IconJournal,
    },
    SettingsPanel: JournalSettingsPanel,
    routes: ['/journal'],
  },
  {
    id: 'aktivitaeten',
    label: 'Aktivitäten',
    core: false,
    navItem: {
      id: 'aktivitaeten',
      href: '/aktivitaeten',
      label: 'Aktivitäten',
      accent: 'var(--area-activities)',
      Icon: IconActivity,
    },
    OverviewSection: ActivityMonthStrip,
    routes: ['/aktivitaeten'],
  },
  { id: 'wetter', label: 'Wetter', core: false, OverviewSection: WeatherForecast, SettingsPanel: WeatherPanel },
  { id: 'export', label: 'Export', core: false, SettingsPanel: ExportPanel },
  { id: 'einstellungen', label: 'Einstellungen', core: true },
] as const;
