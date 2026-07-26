'use client';

import { Row } from '@/ui/row';
import { SectionCard } from '@/ui/section-card';
import { Toggle } from '@/ui/toggle';
import { usePush } from './use-push';
import './push-panel.css';

/**
 * M3-Grundgerüst (issue #122): nur die Leitung (Abo an/aus, Testversand) — die
 * eigentlichen Erinnerungen kommen als eigene Tickets. 'granted' heißt hier
 * "aktives Abo", nicht nur Browser-Erlaubnis (siehe getPushState in src/local/push.ts).
 */
export function PushPanel() {
  const { phase, busy, testSent, activate, deactivate, sendTest } = usePush();

  if (phase === 'unsupported') {
    return (
      <SectionCard title="Benachrichtigungen">
        <p className="push-panel__hint">
          Push-Benachrichtigungen werden auf diesem Gerät nicht unterstützt.
        </p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Benachrichtigungen">
      {phase === 'loading' && <p className="push-panel__hint">Wird geprüft …</p>}

      {phase === 'default' && (
        <Row
          label="Benachrichtigungen erlauben"
          description="Erlaubt Starship, dich per Push zu erinnern."
        >
          <button
            type="button"
            className="push-panel__button"
            onClick={activate}
            disabled={busy}
          >
            Erlauben
          </button>
        </Row>
      )}

      {phase === 'denied' && (
        <p className="push-panel__hint">
          Benachrichtigungen wurden im Browser abgelehnt. Starship kann das nicht selbst
          zurücksetzen — öffne dazu die Website-Einstellungen deines Browsers für diese Seite.
        </p>
      )}

      {phase === 'granted' && (
        <>
          <Row label="Benachrichtigungen" description="Push-Abo ist auf diesem Gerät aktiv.">
            <Toggle label="Benachrichtigungen abschalten" checked onChange={deactivate} />
          </Row>
          <Row label="Testnachricht senden">
            <button
              type="button"
              className="push-panel__button"
              onClick={sendTest}
              disabled={busy}
            >
              Senden
            </button>
          </Row>
          {testSent && <p className="push-panel__hint">Testnachricht gesendet.</p>}
        </>
      )}
    </SectionCard>
  );
}
