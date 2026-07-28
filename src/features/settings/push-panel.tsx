'use client';

import { useState } from 'react';
import { Row } from '@/ui/row';
import { SectionCard } from '@/ui/section-card';
import { Toggle } from '@/ui/toggle';
import { usePush } from './use-push';
import { useReminderPrefs, type ReminderPrefView } from './use-reminder-prefs';
import './push-panel.css';

interface ReminderKindPanelProps {
  pref: ReminderPrefView;
  onToggle: (kind: string) => void;
  onSetTime: (kind: string, index: number, time: string) => void;
  onAddTime: (kind: string, time: string) => void;
  onRemoveTime: (kind: string, time: string) => void;
}

/**
 * One reminder kind's switch + time list (issue #244, "M3-T5"). `times` stays
 * visible while disabled — turning a kind off must not lose its configured times
 * (plan decision: only `enabled` is cleared, never `times`).
 */
function ReminderKindPanel({ pref, onToggle, onSetTime, onAddTime, onRemoveTime }: ReminderKindPanelProps) {
  const [newTime, setNewTime] = useState('12:00');

  return (
    <div className="push-panel__kind">
      <Row label={pref.label}>
        <Toggle label={`${pref.label} abschalten`} checked={pref.enabled} onChange={() => onToggle(pref.kind)} />
      </Row>
      {pref.times.length > 0 && (
        <ul className="push-panel__times">
          {pref.times.map((time, index) => (
            <li key={`${time}-${index}`} className="push-panel__time-row">
              <input
                type="time"
                className="push-panel__time-input"
                value={time}
                onChange={(event) => onSetTime(pref.kind, index, event.target.value)}
                aria-label={`${pref.label}: Uhrzeit ${index + 1}`}
              />
              <button
                type="button"
                className="push-panel__remove-time"
                onClick={() => onRemoveTime(pref.kind, time)}
                aria-label={`${pref.label}: Uhrzeit ${time} entfernen`}
              >
                Entfernen
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="push-panel__add-time">
        <input
          type="time"
          className="push-panel__time-input"
          value={newTime}
          onChange={(event) => setNewTime(event.target.value)}
          aria-label={`${pref.label}: neue Uhrzeit`}
        />
        <button
          type="button"
          className="push-panel__add-time-button"
          onClick={() => onAddTime(pref.kind, newTime)}
          aria-label={`${pref.label}: Zeit hinzufügen`}
        >
          Zeit hinzufügen
        </button>
      </div>
    </div>
  );
}

/**
 * M3-Grundgerüst (issue #122): die Leitung (Abo an/aus, Testversand). Seit #244
 * zusätzlich je Erinnerungsart ein Schalter + Zeitenliste — nur im `granted`-Zweig,
 * denn ohne aktives Abo kommt ohnehin keine Benachrichtigung an.
 */
export function PushPanel() {
  const { phase, busy, testSent, activate, deactivate, sendTest } = usePush();
  const { prefs, toggle, setTimeAt, addTime, removeTime } = useReminderPrefs();

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
          {prefs?.map((pref) => (
            <ReminderKindPanel
              key={pref.kind}
              pref={pref}
              onToggle={toggle}
              onSetTime={setTimeAt}
              onAddTime={addTime}
              onRemoveTime={removeTime}
            />
          ))}
        </>
      )}
    </SectionCard>
  );
}
