'use client';

import { Row } from '@/ui/row';
import { SectionCard } from '@/ui/section-card';
import { Toggle } from '@/ui/toggle';
import { useJournalPersistPref } from './use-journal-persist-pref';

export function JournalSettingsPanel() {
  const { enabled, setEnabled } = useJournalPersistPref();

  return (
    <SectionCard title="Journal">
      <Row
        label="Auf diesem Gerät entsperrt lassen"
        description="Der Schlüssel bleibt nach einem Neustart auf diesem Gerät gespeichert (nicht extrahierbar) — sonst wird nach jedem Kaltstart erneut nach der Passphrase gefragt."
      >
        <Toggle
          label="Auf diesem Gerät entsperrt lassen"
          checked={enabled}
          onChange={setEnabled}
        />
      </Row>
    </SectionCard>
  );
}
