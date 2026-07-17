'use client';

import { Row } from '@/ui/row';
import { SectionCard } from '@/ui/section-card';
import { Toggle } from '@/ui/toggle';
import { useCapturePrefs } from './use-capture-prefs';

/**
 * Getrennt von AppearancePanel (ADR-0006-Referenz für Darstellung) — dieser Schalter
 * steuert Erfassungsverhalten, nicht Präsentation.
 */
export function CapturePanel() {
  const { directCapture, setDirectCapture } = useCapturePrefs();

  return (
    <SectionCard title="Spracherfassung">
      <Row
        label="Ohne Bestätigung direkt anlegen"
        description="Erkennt der Text ein Datum, wird die Aufgabe sofort angelegt statt zur Bestätigung angezeigt."
      >
        <Toggle
          label="Ohne Bestätigung direkt anlegen"
          checked={directCapture}
          onChange={setDirectCapture}
        />
      </Row>
    </SectionCard>
  );
}
