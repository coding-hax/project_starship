'use client';

import { useEffect } from 'react';
import { IconSearch } from '@/ui/icons';
import { useJournalLock } from './lock-store';
import { useJournalSearchMode } from './journal-view-mode';

/**
 * Die Lupe in der Journal-Augenbrauenzeile (issue #700 AK5, umgezogen in
 * #928 AK1): öffnet den Suchmodus. Sitzt in `page.tsx`s
 * `.journal-page__eyebrow-row`, also außerhalb des Gates.
 *
 * Rendert `null`, solange das Journal nicht entsperrt ist (AK7: gesperrt keine
 * Lupe) und im Suchmodus selbst (AK6: dort nur Suchfeld, „Abbrechen" und
 * Treffer). Weil das Suchfeld dieselbe `aria-label` trägt, dürfen Lupe und Feld
 * nie gleichzeitig im DOM stehen — genau das stellt die `active`-Bedingung
 * sicher.
 *
 * Der Reset des Suchmodus beim Sperren gehört hierher, nicht in den Editor: der
 * Editor unmountet beim Sperren, ein Effekt dort sähe den Übergang also nie.
 * Diese Komponente bleibt dagegen stets gemountet (nur ihr sichtbares Element
 * verschwindet), ihr Effekt beobachtet den Lock-Übergang zuverlässig.
 */
export function JournalSearchToggle() {
  const { state } = useJournalLock();
  const { active, open, close } = useJournalSearchMode();

  useEffect(() => {
    if (state !== 'unlocked') close();
  }, [state, close]);

  if (state !== 'unlocked' || active) return null;

  return (
    <button
      type="button"
      className="journal-page__search-toggle"
      aria-label="Journal durchsuchen"
      onClick={open}
    >
      <IconSearch />
    </button>
  );
}
