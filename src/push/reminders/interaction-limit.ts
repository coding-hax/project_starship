import type { PushPayload } from '@/push/send';
import type { ReminderKind } from './index';

/**
 * Ablaufdatum des Interaction Limit (`collaborators_only`, Issue #70) — einzige
 * Stelle, die dieses Datum trägt (vormals Konstante `EXPIRY` in
 * .github/workflows/interaction-limit-reminder.yml, das dieses Ticket ablöst).
 * Bei Verlängerung (`gh api --method PUT repos/coding-hax/project_starship/interaction-limits
 * -f limit=collaborators_only -f expiry=six_months`) hier nachziehen.
 */
const EXPIRY = new Date('2027-01-17T11:36:24.000Z');
const WARNING_WINDOW_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function formatExpiry(): string {
  return EXPIRY.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });
}

function buildBody(daysLeft: number): string {
  const date = formatExpiry();
  if (daysLeft < 0) return `Bereits abgelaufen am ${date} — siehe Issue #70.`;
  if (daysLeft === 0) return `Läuft heute ab (${date}) — siehe Issue #70.`;
  if (daysLeft === 1) return `Läuft morgen ab (${date}) — siehe Issue #70.`;
  return `Läuft in ${daysLeft} Tagen ab (${date}) — siehe Issue #70.`;
}

export async function build(now: Date): Promise<PushPayload | null> {
  const daysLeft = Math.floor((EXPIRY.getTime() - now.getTime()) / MS_PER_DAY);
  if (daysLeft >= WARNING_WINDOW_DAYS) return null;

  return { title: 'Interaction Limit läuft bald ab', body: buildBody(daysLeft), url: '/' };
}

export const interactionLimit: ReminderKind = { kind: 'interaction-limit', times: ['09:00'], build };
