'use client';

import { Row } from '@/ui/row';
import { SectionCard } from '@/ui/section-card';
import { Toggle } from '@/ui/toggle';
import { useModules } from './use-modules';

/**
 * Ein Schalter je abwählbarem Modul (ADR-0012, issue #307) — reine Darstellung, nie
 * Datenhaltung: ein abgeschaltetes Modul synchronisiert unverändert weiter, nur Nav
 * (und ab T2/T3 die zugehörigen Bereiche) blenden es aus. `core`-Module (Übersicht,
 * Einstellungen) tauchen hier nie auf.
 */
export function ModulePanel() {
  const { modules, isActive, toggle } = useModules();

  return (
    <SectionCard title="Module">
      {modules.map((mod) => (
        <Row key={mod.id} label={mod.label}>
          <Toggle label={mod.label} checked={isActive(mod.id)} onChange={() => toggle(mod.id)} />
        </Row>
      ))}
    </SectionCard>
  );
}
