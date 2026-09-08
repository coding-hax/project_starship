'use client';

import { useState } from 'react';
import { Row } from '@/ui/row';
import { SectionCard } from '@/ui/section-card';
import { useListPresence } from '@/ui/use-list-presence';
import { useOnline } from '@/ui/use-online';
import { type LiveSession, useSessions } from './use-sessions';
import './logins-panel.css';

function formatLastSeen(iso: string | null): string {
  if (!iso) return 'noch nie';
  const then = new Date(iso);
  if (Date.now() - then.getTime() < 60_000) return 'gerade eben';
  const dateStr = then.toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const timeStr = then.toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${dateStr}, ${timeStr}`;
}

interface LoginRowProps {
  session: LiveSession;
  disabled: boolean;
  busy: boolean;
  onEnd: (id: string) => void;
  entering: boolean;
  leaving: boolean;
  onAnimationEnd: () => void;
}

function LoginRow({ session, disabled, busy, onEnd, entering, leaving, onAnimationEnd }: LoginRowProps) {
  const [confirming, setConfirming] = useState(false);
  const label = session.current ? (
    <>
      Diese Anmeldung <span className="logins-panel__current-badge">Dieses Gerät</span>
    </>
  ) : (
    'Anmeldung'
  );
  const description = `zuletzt gesehen ${formatLastSeen(session.lastSeenAt)}`;

  return (
    <li
      className="logins-panel__item list-motion-item"
      data-entering={entering}
      data-leaving={leaving}
      onAnimationEnd={onAnimationEnd}
    >
      {confirming ? (
        <Row label="Diese Anmeldung wirklich beenden?">
          <div className="logins-panel__confirm">
            <button
              type="button"
              className="logins-panel__button"
              onClick={() => onEnd(session.id)}
              disabled={busy}
            >
              Beenden
            </button>
            <button
              type="button"
              className="logins-panel__button logins-panel__button--secondary"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              Abbrechen
            </button>
          </div>
        </Row>
      ) : (
        <Row label={label} description={description}>
          {session.current ? (
            <span className="logins-panel__hint">{'Beenden über „App sperren"'}</span>
          ) : (
            <button
              type="button"
              className="logins-panel__button logins-panel__button--secondary"
              onClick={() => setConfirming(true)}
              disabled={disabled}
            >
              Beenden
            </button>
          )}
        </Row>
      )}
    </li>
  );
}

export function LoginsPanel() {
  const online = useOnline();
  const { phase, sessions, busy, endSession } = useSessions();
  const rows = useListPresence(sessions, (session) => session.id);

  if (phase === 'loading') return null;

  return (
    <SectionCard title="Anmeldungen" className="logins-panel">
      {!online && <p className="logins-panel__hint">Geht nur online.</p>}
      <ul className="logins-panel__list">
        {rows.map((row) => (
          <LoginRow
            key={row.key}
            session={row.item}
            disabled={!online}
            busy={busy}
            onEnd={endSession}
            entering={row.status === 'entering'}
            leaving={row.status === 'leaving'}
            onAnimationEnd={row.onAnimationEnd}
          />
        ))}
      </ul>
    </SectionCard>
  );
}
