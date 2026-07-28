import { ActivityMonthStrip } from '@/features/activities/activity-month-strip';
import { ExportPanel } from '@/features/export/export-panel';
import { HabitsOverviewSection } from '@/features/habits/habits-overview-section';
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
   * shipped, or every device's saved state silently drops that entry. */
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
}

/**
 * Single source per module (ADR-0012, issue #307): `nav-items.ts` derives `NAV_ITEMS`
 * from this, `use-modules.ts` drives the on/off state, `module-panel.tsx` renders one
 * row per non-core entry, `OverviewSection`/`SettingsPanel` gate the matching section
 * on /uebersicht resp. /einstellungen (issue #308). `routes` for entries not yet part
 * of the nav follows in T3 (#216).
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
  },
  {
    id: 'gewohnheiten',
    label: 'Gewohnheiten',
    core: false,
    navItem: {
      id: 'gewohnheiten',
      href: '/gewohnheiten',
      label: 'Gewohnheiten',
      accent: 'var(--area-habits)',
      Icon: IconHabits,
    },
    OverviewSection: HabitsOverviewSection,
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
  },
  { id: 'wetter', label: 'Wetter', core: false, OverviewSection: WeatherForecast, SettingsPanel: WeatherPanel },
  { id: 'export', label: 'Export', core: false, SettingsPanel: ExportPanel },
  { id: 'einstellungen', label: 'Einstellungen', core: true },
] as const;
