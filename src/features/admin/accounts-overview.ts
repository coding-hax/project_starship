import { cache } from 'react';
import { desc, sql } from 'drizzle-orm';
import { db } from '@/db';
import { adminAudit, credentials, invites, sessions, userActivityDays, users } from '@/db/schema';

export type AccountStatus = 'eingeladen' | 'aktiv' | 'gesperrt';

export interface ModuleUsage {
  rows: number;
  bytes: number;
}

export interface AccountOverviewRow {
  id: string;
  label: string | null;
  status: AccountStatus;
  createdAt: string;
  lastSeenAt: string | null;
  activeDays30: number;
  bytes: number;
  modules: {
    aufgaben: ModuleUsage;
    termine: ModuleUsage;
    routinen: ModuleUsage;
    journal: ModuleUsage;
  };
  devices: number;
  sessions: number;
}

export interface InviteOverviewRow {
  id: string;
  label: string | null;
  expiresAt: string;
}

export type AdminAuditAction = 'block' | 'unblock' | 'reissue' | 'delete-journal' | 'delete-account';

export interface AuditOverviewRow {
  id: string;
  action: AdminAuditAction;
  actorLabel: string | null;
  targetLabel: string | null;
  createdAt: string;
}

export interface AccountsOverview {
  summary: {
    totalAccounts: number;
    activeIn7: number;
    activeIn30: number;
    blocked: number;
    openInvites: number;
    totalBytes: number;
  };
  accounts: AccountOverviewRow[];
  invites: InviteOverviewRow[];
  audit: AuditOverviewRow[];
}

/** How far back the admin UI shows the log (AK8: "sichtbar"), not a retention limit. */
const AUDIT_DISPLAY_LIMIT = 200;

type ModuleKey = 'aufgaben' | 'termine' | 'routinen' | 'journal';

function emptyModules(): AccountOverviewRow['modules'] {
  return {
    aufgaben: { rows: 0, bytes: 0 },
    termine: { rows: 0, bytes: 0 },
    routinen: { rows: 0, bytes: 0 },
    journal: { rows: 0, bytes: 0 },
  };
}

/**
 * Rows + `pg_column_size` bytes per account, grouped by the four modules AK4/AK5
 * ask for — plus `_sonstiges` (sync_state/reminder_prefs/category_colors), which
 * counts toward a modul-less "belegter Speicher gesamt" but has no column of its
 * own (decision 1 of the plan comment on #1203). One `UNION ALL` per synchronised
 * table with a `user_id` column, re-grouped by `(user_id, modul)` in the outer
 * query so a module spanning several tables (e.g. Termine = events +
 * event_exceptions) collapses to one row per account.
 */
const USAGE_QUERY = sql`
  select user_id, modul, sum(rows)::bigint as rows, sum(bytes)::bigint as bytes
  from (
    select user_id, 'aufgaben' as modul, count(*) as rows, coalesce(sum(pg_column_size(t.*)), 0) as bytes from tasks t group by user_id
    union all
    select user_id, 'termine' as modul, count(*) as rows, coalesce(sum(pg_column_size(t.*)), 0) as bytes from events t group by user_id
    union all
    select user_id, 'termine' as modul, count(*) as rows, coalesce(sum(pg_column_size(t.*)), 0) as bytes from event_exceptions t group by user_id
    union all
    select user_id, 'routinen' as modul, count(*) as rows, coalesce(sum(pg_column_size(t.*)), 0) as bytes from habits t group by user_id
    union all
    select user_id, 'routinen' as modul, count(*) as rows, coalesce(sum(pg_column_size(t.*)), 0) as bytes from habit_logs t group by user_id
    union all
    select user_id, 'routinen' as modul, count(*) as rows, coalesce(sum(pg_column_size(t.*)), 0) as bytes from habit_freezes t group by user_id
    union all
    select user_id, 'journal' as modul, count(*) as rows, coalesce(sum(pg_column_size(t.*)), 0) as bytes from journal_entries t group by user_id
    union all
    select user_id, 'journal' as modul, count(*) as rows, coalesce(sum(pg_column_size(t.*)), 0) as bytes from journal_keys t group by user_id
    union all
    select user_id, '_sonstiges' as modul, count(*) as rows, coalesce(sum(pg_column_size(t.*)), 0) as bytes from sync_state t group by user_id
    union all
    select user_id, '_sonstiges' as modul, count(*) as rows, coalesce(sum(pg_column_size(t.*)), 0) as bytes from reminder_prefs t group by user_id
    union all
    select user_id, '_sonstiges' as modul, count(*) as rows, coalesce(sum(pg_column_size(t.*)), 0) as bytes from category_colors t group by user_id
  ) sub
  group by user_id, modul
`;

interface UsageRow {
  [key: string]: unknown;
  user_id: string;
  modul: ModuleKey | '_sonstiges';
  rows: string;
  bytes: string;
}

/**
 * The full `/api/admin/accounts` payload (AK2-AK7) — never a user content field
 * (AK8, see `src/app/api/admin/accounts/route.ts`'s own test). `cache()` (react)
 * memoises this for the lifetime of one request (AK4 "für die Dauer eines
 * Seitenaufrufs zwischengespeichert"), so a page render that also fetches the
 * route handler's own copy never runs the aggregation twice.
 */
export const getAccountsOverview = cache(async (): Promise<AccountsOverview> => {
  const [accountRows, usageRows, inviteRows, auditRows] = await Promise.all([
    db
      .select({
        id: users.id,
        label: users.displayName,
        createdAt: users.createdAt,
        lastSeenAt: users.lastSeenAt,
        blockedAt: users.blockedAt,
        // `"users"."id"` is hand-qualified, not `${users.id}`: drizzle's `sql` template
        // prints a bare `Column` as just `"id"`, with no table prefix, even inside a
        // correlated subquery — and `credentials`/`sessions` each have their *own*
        // `id` column, so the unqualified reference silently bound to the wrong table
        // (`credentials.id`/`sessions.id` instead of the outer `users.id`), making every
        // count always 0 instead of actually correlating. `user_activity_days` has no
        // `id` column of its own, which is why that one subquery happened to still work.
        credentialCount: sql<string>`(select count(*) from ${credentials} where ${credentials.userId} = "users"."id")`,
        sessionCount: sql<string>`(select count(*) from ${sessions} where ${sessions.userId} = "users"."id" and ${sessions.expiresAt} > now())`,
        activeDays30: sql<string>`(select count(*) from ${userActivityDays} where ${userActivityDays.userId} = "users"."id" and ${userActivityDays.day} >= current_date - 30)`,
      })
      .from(users)
      .orderBy(users.createdAt),
    db.execute<UsageRow>(USAGE_QUERY),
    db
      .select({ id: invites.id, label: invites.label, expiresAt: invites.expiresAt })
      .from(invites)
      .where(sql`${invites.usedAt} is null and ${invites.expiresAt} > now()`),
    db
      .select({
        id: adminAudit.id,
        action: adminAudit.action,
        actorLabel: adminAudit.actorLabel,
        targetLabel: adminAudit.targetLabel,
        createdAt: adminAudit.createdAt,
      })
      .from(adminAudit)
      .orderBy(desc(adminAudit.createdAt))
      .limit(AUDIT_DISPLAY_LIMIT),
  ]);

  const usageByAccount = new Map<string, { modules: AccountOverviewRow['modules']; totalBytes: number }>();
  for (const row of usageRows.rows) {
    const entry = usageByAccount.get(row.user_id) ?? { modules: emptyModules(), totalBytes: 0 };
    const rows = Number(row.rows);
    const bytes = Number(row.bytes);
    entry.totalBytes += bytes;
    if (row.modul !== '_sonstiges') entry.modules[row.modul] = { rows, bytes };
    usageByAccount.set(row.user_id, entry);
  }

  const now = Date.now();
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

  let activeIn7 = 0;
  let activeIn30 = 0;
  let blocked = 0;
  let totalBytes = 0;

  const accounts: AccountOverviewRow[] = accountRows.map((row) => {
    const usage = usageByAccount.get(row.id) ?? { modules: emptyModules(), totalBytes: 0 };
    const credentialCount = Number(row.credentialCount);
    const status: AccountStatus = row.blockedAt ? 'gesperrt' : credentialCount === 0 ? 'eingeladen' : 'aktiv';

    if (row.blockedAt) blocked += 1;
    if (row.lastSeenAt && row.lastSeenAt >= sevenDaysAgo) activeIn7 += 1;
    if (row.lastSeenAt && row.lastSeenAt >= thirtyDaysAgo) activeIn30 += 1;
    totalBytes += usage.totalBytes;

    return {
      id: row.id,
      label: row.label,
      status,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
      activeDays30: Number(row.activeDays30),
      bytes: usage.totalBytes,
      modules: usage.modules,
      devices: credentialCount,
      sessions: Number(row.sessionCount),
    };
  });

  return {
    summary: {
      totalAccounts: accounts.length,
      activeIn7,
      activeIn30,
      blocked,
      openInvites: inviteRows.length,
      totalBytes,
    },
    accounts,
    invites: inviteRows.map((invite) => ({
      id: invite.id,
      label: invite.label,
      expiresAt: invite.expiresAt.toISOString(),
    })),
    audit: auditRows.map((row) => ({
      id: row.id,
      action: row.action,
      actorLabel: row.actorLabel,
      targetLabel: row.targetLabel,
      createdAt: row.createdAt.toISOString(),
    })),
  };
});
