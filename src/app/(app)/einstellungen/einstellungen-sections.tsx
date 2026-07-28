'use client';

import { useActiveSections } from '@/modules/module-sections';

/** Panel order after the core ones: Aufgaben → Wetter → Export (issue #308). */
const ORDER = ['aufgaben', 'wetter', 'export'];

export function EinstellungenSections() {
  const sections = useActiveSections(ORDER, (m) => m.SettingsPanel);

  return (
    <>
      {sections.map(({ id, Component }) => (
        <Component key={id} />
      ))}
    </>
  );
}
