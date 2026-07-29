'use client';

import { useActiveSections } from '@/modules/module-sections';

/** Today's order: Wetter → Aufgaben → Aktivitäten-Streifen → Gewohnheiten → Journal
 * (issue #308, Journal-Sektion issue #342). Journal sits last — the two gap
 * assertions in tests/uebersicht.spec.ts (issue #228 AC6) measure the space
 * between Aufgaben and Gewohnheiten specifically, so anything after Gewohnheiten
 * cannot disturb them. */
const ORDER = ['wetter', 'aufgaben', 'aktivitaeten', 'gewohnheiten', 'journal'];

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
