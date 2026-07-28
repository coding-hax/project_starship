'use client';

import { useActiveSections } from '@/modules/module-sections';

/** Today's order: Wetter → Aufgaben → Aktivitäten-Streifen → Gewohnheiten (issue #308). */
const ORDER = ['wetter', 'aufgaben', 'aktivitaeten', 'gewohnheiten'];

export function UebersichtSections() {
  const sections = useActiveSections(ORDER, (m) => m.OverviewSection);

  return (
    <>
      {sections.map(({ id, Component }) => (
        <Component key={id} />
      ))}
    </>
  );
}
