'use client';

import { Row } from '@/ui/row';
import { SectionCard } from '@/ui/section-card';
import { useOnline } from '@/ui/use-online';
import type { AccountOverviewRow, AccountStatus } from './accounts-overview';
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

function AccountCard({ account }: { account: AccountOverviewRow }) {
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
    </li>
  );
}

/**
 * Read-only account overview (S4, #1203). Nothing here writes — the admin
 * actions (sperren/löschen/Konto umbenennen) come in S5 (#1204 ff.).
 */
export function AdminOverview() {
  const online = useOnline();
  const { phase, overview } = useAdminOverview();

  if (phase === 'loading') return null;

  if (phase === 'error' || !overview) {
    return (
      <SectionCard title="Verwaltung" className="admin-overview">
        <p className="admin-overview__hint">{online ? 'Laden fehlgeschlagen.' : 'Geht nur online.'}</p>
      </SectionCard>
    );
  }

  const { summary, accounts, invites } = overview;

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
            <AccountCard key={account.id} account={account} />
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
    </div>
  );
}
