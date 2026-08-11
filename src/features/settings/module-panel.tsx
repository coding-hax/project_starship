'use client';

import { archiveJournalHabit, unarchiveJournalHabit } from '@/features/journal/journal-habit';
import { Row } from '@/ui/row';
import { SectionCard } from '@/ui/section-card';
import { Toggle } from '@/ui/toggle';
import { useModules } from './use-modules';

/**
 * Ein Schalter je abwählbarem Modul (ADR-0012, issue #307) — reine Darstellung, nie
 * Datenhaltung: ein abgeschaltetes Modul synchronisiert unverändert weiter, nur Nav
 * (und ab T2/T3 die zugehörigen Bereiche) blenden es aus. `core`-Module (Übersicht,
 * Einstellungen) tauchen hier nie auf.
 *
 * Journal ist die eine Ausnahme (issue #505 AC7): die Journal-Routine wird nur an
 * der Flanke dieses Schalters archiviert/entarchiviert, nie bei jedem Mount — sonst
 * würde ein unterschiedlicher Schalterstand zwischen zwei Geräten über den Sync
 * endlos hin- und herschreiben.
 */
export function ModulePanel() {
  const { modules, isActive, toggle } = useModules();

  function handleToggle(id: string) {
    if (id === 'journal') {
      const willBeActive = !isActive('journal');
      toggle('journal');
      void (willBeActive ? unarchiveJournalHabit() : archiveJournalHabit());
      return;
    }
    toggle(id);
  }

  return (
    <SectionCard title="Module">
      {modules.map((mod) => (
        <Row key={mod.id} label={mod.label}>
          <Toggle
            label={mod.label}
            checked={isActive(mod.id)}
            onChange={() => handleToggle(mod.id)}
          />
        </Row>
      ))}
    </SectionCard>
  );
}
