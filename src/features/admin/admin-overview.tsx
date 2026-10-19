'use client';

import { useState } from 'react';
import { Row } from '@/ui/row';
import { SectionCard } from '@/ui/section-card';
import { useOnline } from '@/ui/use-online';
import { useOwnAccountId } from '@/features/settings/use-admin-role';
import type { AccountOverviewRow, AccountStatus, AdminAuditAction, AuditOverviewRow } from './accounts-overview';
import { useAdminActions } from './use-admin-actions';
import { useAdminOverview } from './use-admin-overview';
import './admin-overview.css';

const STATUS_LABEL: Record<AccountStatus, string> = {
  eingeladen: 'eingeladen',
  aktiv: 'aktiv',
  gesperrt: 'gesperrt',
};

const MODULE_LABEL = {
  aufgaben: 'Aufgaben',
  termine: 'Termine',
  routinen: 'Routinen',
  journal: 'Journal',
} as const;

const AUDIT_ACTION_LABEL: Record<AdminAuditAction, string> = {
  block: 'gesperrt',
  unblock: 'entsperrt',
  reissue: 'Zugang neu ausgestellt für',
  'delete-journal': 'Journal gelöscht von',
  'delete-account': 'Konto gelöscht von',
};

const ERROR_LABEL: Record<string, string> = {
  self: 'Nicht am eigenen Konto möglich.',
  'not-found': 'Konto nicht gefunden — vermutlich schon gelöscht.',
  'last-admin': 'Das letzte Admin-Konto kann nicht gelöscht werden.',
  failed: 'Aktion fehlgeschlagen.',
};

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let n = value / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return 'noch nie';
  return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

type Confirming = 'journal' | 'journal-confirm' | 'delete';

interface AccountCardProps {
  account: AccountOverviewRow;
  isOwn: boolean;
  actions: ReturnType<typeof useAdminActions>;
}

function AccountCard({ account, isOwn, actions }: AccountCardProps) {
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [deleteInput, setDeleteInput] = useState('');
  const busy = actions.busyId === account.id;
  const linkForThisAccount = actions.reissueLink?.id === account.id ? actions.reissueLink.link : null;
  const errorForThisAccount = actions.error?.id === account.id ? actions.error.code : null;
  const deleteLabel = account.label ?? 'Ohne Etikett';

  function cancel() {
    setConfirming(null);
    setDeleteInput('');
  }

  return (
    <li className="admin-overview__account">
      <div className="admin-overview__account-head">
        <span className="admin-overview__account-label">{account.label ?? 'Ohne Etikett'}</span>
        <span className="admin-overview__status" data-status={account.status}>
          {STATUS_LABEL[account.status]}
        </span>
      </div>
      <Row label="Angelegt am">
        <span>{formatDate(account.createdAt)}</span>
      </Row>
      <Row label="Zuletzt aktiv">
        <span>{formatDate(account.lastSeenAt)}</span>
      </Row>
      <Row label="Aktive Tage (30)">
        <span>{account.activeDays30}</span>
      </Row>
      <Row label="Speicher">
        <span>{formatBytes(account.bytes)}</span>
      </Row>
      <Row label="Geräte">
        <span>{account.devices}</span>
      </Row>
      <Row label="Sitzungen">
        <span>{account.sessions}</span>
      </Row>
      <ul className="admin-overview__modules">
        {(Object.keys(MODULE_LABEL) as Array<keyof typeof MODULE_LABEL>).map((key) => (
          <li key={key} className="admin-overview__module">
            <span>{MODULE_LABEL[key]}</span>
            <span>
              {account.modules[key].rows} Zeilen · {formatBytes(account.modules[key].bytes)}
            </span>
          </li>
        ))}
      </ul>

      {!isOwn && (
        <div className="admin-overview__actions">
          {errorForThisAccount && <p className="admin-overview__error">{ERROR_LABEL[errorForThisAccount]}</p>}

          <Row label={account.status === 'gesperrt' ? 'Entsperren' : 'Sperren'}>
            <button
              type="button"
              className="admin-overview__button admin-overview__button--secondary"
              disabled={busy}
              onClick={() => (account.status === 'gesperrt' ? actions.unblock(account.id) : actions.block(account.id))}
            >
              {account.status === 'gesperrt' ? 'Entsperren' : 'Sperren'}
            </button>
          </Row>

          {linkForThisAccount ? (
            <Row label="Neuer Einladungs-Link" description="Verschwindet beim Neuladen der Seite.">
              <div className="admin-overview__link">
                <code className="admin-overview__link-value">{linkForThisAccount}</code>
                <button
                  type="button"
                  className="admin-overview__button admin-overview__button--secondary"
                  onClick={() => navigator.clipboard?.writeText(linkForThisAccount)}
                >
                  Kopieren
                </button>
              </div>
            </Row>
          ) : (
            <Row
              label="Zugang neu ausstellen"
              description="Widerruft alle Geräte dieses Kontos und erzeugt einen neuen Einladungs-Link."
            >
              <button
                type="button"
                className="admin-overview__button admin-overview__button--secondary"
                disabled={busy}
                onClick={() => actions.reissue(account.id)}
              >
                Neu ausstellen
              </button>
            </Row>
          )}

          {confirming === 'journal' ? (
            <Row label="Journal wirklich löschen?">
              <div className="admin-overview__confirm">
                <button
                  type="button"
                  className="admin-overview__button admin-overview__button--danger"
                  disabled={busy}
                  onClick={() => setConfirming('journal-confirm')}
                >
                  Ja, weiter
                </button>
                <button
                  type="button"
                  className="admin-overview__button admin-overview__button--secondary"
                  onClick={cancel}
                >
                  Abbrechen
                </button>
              </div>
            </Row>
          ) : confirming === 'journal-confirm' ? (
            <Row label="Endgültig löschen — nicht zurücksetzbar">
              <div className="admin-overview__confirm">
                <p className="admin-overview__hint">
                  Die Journal-Passphrase kann nicht zurückgesetzt werden, weil der Server den Klartext nie kennt.
                </p>
                <button
                  type="button"
                  className="admin-overview__button admin-overview__button--danger"
                  disabled={busy}
                  onClick={() => {
                    cancel();
                    actions.deleteJournal(account.id);
                  }}
                >
                  Journal endgültig löschen
                </button>
                <button
                  type="button"
                  className="admin-overview__button admin-overview__button--secondary"
                  onClick={cancel}
                >
                  Abbrechen
                </button>
              </div>
            </Row>
          ) : (
            <Row label="Journal löschen" description="Getrennt vom Zugang — löscht nur die Journal-Einträge.">
              <button
                type="button"
                className="admin-overview__button admin-overview__button--danger"
                disabled={busy}
                onClick={() => setConfirming('journal')}
              >
                Löschen
              </button>
            </Row>
          )}

          {confirming === 'delete' ? (
            <Row label={`Zum Löschen „${deleteLabel}“ eintippen`}>
              <div className="admin-overview__confirm">
                <input
                  type="text"
                  className="admin-overview__field"
                  value={deleteInput}
                  onChange={(event) => setDeleteInput(event.target.value)}
                  placeholder={deleteLabel}
                />
                <button
                  type="button"
                  className="admin-overview__button admin-overview__button--danger"
                  disabled={busy || deleteInput !== deleteLabel}
                  onClick={() => {
                    cancel();
                    actions.deleteAccount(account.id);
                  }}
                >
                  Konto endgültig löschen
                </button>
                <button
                  type="button"
                  className="admin-overview__button admin-overview__button--secondary"
                  onClick={cancel}
                >
                  Abbrechen
                </button>
              </div>
            </Row>
          ) : (
            <Row label="Konto löschen" description="Alle Daten dieses Kontos verschwinden unwiderruflich.">
              <button
                type="button"
                className="admin-overview__button admin-overview__button--danger"
                disabled={busy}
                onClick={() => setConfirming('delete')}
              >
                Löschen
              </button>
            </Row>
          )}
        </div>
      )}
    </li>
  );
}

function AuditRow({ entry }: { entry: AuditOverviewRow }) {
  return (
    <li className="admin-overview__audit-item">
      <span>
        {entry.actorLabel ?? 'Unbekannt'} hat {entry.targetLabel ?? 'Unbekannt'} {AUDIT_ACTION_LABEL[entry.action]}
      </span>
      <span className="admin-overview__audit-time">{formatDateTime(entry.createdAt)}</span>
    </li>
  );
}

/**
 * Admin-Übersicht (S4, #1203) + Aktionen (S5, #1204): Sperren/Entsperren,
 * Zugang neu ausstellen, Journal löschen, Konto löschen. Die eigene Zeile
 * (AK6) bekommt keine Knöpfe — `isOwn` blendet den ganzen Aktionsblock aus.
 */
export function AdminOverview() {
  const online = useOnline();
  const ownId = useOwnAccountId();
  const { phase, overview, reload } = useAdminOverview();
  const actions = useAdminActions(reload);

  if (phase === 'loading') return null;

  if (phase === 'error' || !overview) {
    return (
      <SectionCard title="Verwaltung" className="admin-overview">
        <p className="admin-overview__hint">{online ? 'Laden fehlgeschlagen.' : 'Geht nur online.'}</p>
      </SectionCard>
    );
  }

  const { summary, accounts, invites, audit } = overview;

  return (
    <div className="admin-overview">
      <SectionCard title="Kennzahlen">
        <Row label="Konten gesamt">
          <span>{summary.totalAccounts}</span>
        </Row>
        <Row label="Aktiv in 7 Tagen">
          <span>{summary.activeIn7}</span>
        </Row>
        <Row label="Aktiv in 30 Tagen">
          <span>{summary.activeIn30}</span>
        </Row>
        <Row label="Gesperrt">
          <span>{summary.blocked}</span>
        </Row>
        <Row label="Offene Einladungen">
          <span>{summary.openInvites}</span>
        </Row>
        <Row label="Gesamtgröße">
          <span>{formatBytes(summary.totalBytes)}</span>
        </Row>
      </SectionCard>

      <SectionCard title="Konten">
        {!online && <p className="admin-overview__hint">Geht nur online.</p>}
        <ul className="admin-overview__accounts">
          {accounts.map((account) => (
            <AccountCard key={account.id} account={account} isOwn={account.id === ownId} actions={actions} />
          ))}
        </ul>
      </SectionCard>

      <SectionCard title="Offene Einladungen">
        {invites.length === 0 ? (
          <p className="admin-overview__hint">Keine offenen Einladungen.</p>
        ) : (
          <ul className="admin-overview__invites">
            {invites.map((invite) => (
              <li key={invite.id} className="admin-overview__invite">
                <span>{invite.label ?? 'Ohne Etikett'}</span>
                <span>läuft ab am {formatDate(invite.expiresAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Protokoll">
        {audit.length === 0 ? (
          <p className="admin-overview__hint">Noch keine Aktionen.</p>
        ) : (
          <ul className="admin-overview__audit">
            {audit.map((entry) => (
              <AuditRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
