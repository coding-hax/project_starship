'use client';

import { useActiveSections } from '@/modules/module-sections';

/** Today's order: Wetter → Termine → Aufgaben → Aktivitäten-Streifen → Gewohnheiten
 * (issue #308; Termine issue #559, S8 von #473 — "was kommt jetzt?" gehört so
 * weit oben wie das Wetter). Journal has no OverviewSection anymore (issue #506)
 * — its habit-state is covered by the Gewohnheiten-Sektion since issue #505. */
const ORDER = ['wetter', 'kalender', 'aufgaben', 'aktivitaeten', 'routinen'];

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
