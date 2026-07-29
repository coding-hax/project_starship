'use client';

import { useActiveSections } from '@/modules/module-sections';

/** Panel order after the core ones: Aufgaben → Wetter → Journal → Export (issue #308, #339). */
const ORDER = ['aufgaben', 'wetter', 'journal', 'export'];

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
