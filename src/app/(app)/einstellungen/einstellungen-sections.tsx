'use client';

import { useActiveSections } from '@/modules/module-sections';

/** Panel order after the core ones: Aufgaben → Kalender → Wetter → Journal → Export (issue #308, #339, #560). */
const ORDER = ['aufgaben', 'kalender', 'wetter', 'journal', 'export'];

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
