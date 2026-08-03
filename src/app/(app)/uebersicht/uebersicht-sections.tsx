'use client';

import { useActiveSections } from '@/modules/module-sections';

/** Today's order: Wetter → Aufgaben → Aktivitäten-Streifen → Gewohnheiten
 * (issue #308). Journal has no OverviewSection anymore (issue #506) — its
 * habit-state is covered by the Gewohnheiten-Sektion since issue #505. */
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
