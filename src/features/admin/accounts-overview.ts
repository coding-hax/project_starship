import { cache } from 'react';
import { desc, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  adminAudit,
  credentials,
  invites,
  pushSubscriptions,
  recoveryCodes,
  reminderSends,
  sessions,
  userActivityDays,
  users,
} from '@/db/schema';

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
  lastSyncAt: string | null;
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
  recovery: { unused: number; total: number };
  push: { subscriptions: number; reminders30: number };
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
 * Every table carrying `syncColumns` (AK1: "alle Tabellen mit `...syncColumns`"),
 * hand-typed like `USAGE_QUERY` above rather than derived from `SYNC_REGISTRY`
 * (`@/db/sync-tables`): `habit_freezes` has the full `syncColumns` set (schema.ts)
 * but no write path reaches it through the generic outbox, so it is absent from
 * `SYNC_REGISTRY`/`SYNC_TABLES`. Deriving from the registry would silently drop it
 * from "alle Tabellen mit syncColumns". Harmless either way today — nothing ever
 * sets its `synced_at`, so it never wins the `max` below — but listing it keeps
 * this query matching the literal schema invariant, not the client-write allowlist.
 */
const LAST_SYNC_QUERY = sql`
  select user_id, max(synced_at) as last_sync_at
  from (
    select user_id, synced_at from sync_state
    union all
    select user_id, synced_at from tasks
    union all
    select user_id, synced_at from habits
    union all
    select user_id, synced_at from habit_logs
    union all
    select user_id, synced_at from habit_freezes
    union all
    select user_id, synced_at from reminder_prefs
    union all
    select user_id, synced_at from category_colors
    union all
    select user_id, synced_at from journal_entries
    union all
    select user_id, synced_at from journal_keys
    union all
    select user_id, synced_at from events
    union all
    select user_id, synced_at from event_exceptions
  ) sub
  group by user_id
`;

interface LastSyncRow {
  [key: string]: unknown;
  user_id: string;
  last_sync_at: Date | null;
}

/**
 * The full `/api/admin/accounts` payload (AK2-AK7) — never a user content field
 * (AK8, see `src/app/api/admin/accounts/route.ts`'s own test). `cache()` (react)
 * memoises this for the lifetime of one request (AK4 "für die Dauer eines
 * Seitenaufrufs zwischengespeichert"), so a page render that also fetches the
 * route handler's own copy never runs the aggregation twice.
 */
export const getAccountsOverview = cache(async (): Promise<AccountsOverview> => {
  const [accountRows, usageRows, lastSyncRows, inviteRows, auditRows] = await Promise.all([
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
        // `recovery_codes`/`push_subscriptions`/`reminder_sends` each have their own
        // `id` column too, same trap, same fix.
        credentialCount: sql<string>`(select count(*) from ${credentials} where ${credentials.userId} = "users"."id")`,
        sessionCount: sql<string>`(select count(*) from ${sessions} where ${sessions.userId} = "users"."id" and ${sessions.expiresAt} > now())`,
        activeDays30: sql<string>`(select count(*) from ${userActivityDays} where ${userActivityDays.userId} = "users"."id" and ${userActivityDays.day} >= current_date - 30)`,
        recoveryUnused: sql<string>`(select count(*) from ${recoveryCodes} where ${recoveryCodes.userId} = "users"."id" and ${recoveryCodes.usedAt} is null)`,
        recoveryTotal: sql<string>`(select count(*) from ${recoveryCodes} where ${recoveryCodes.userId} = "users"."id")`,
        pushSubs: sql<string>`(select count(*) from ${pushSubscriptions} where ${pushSubscriptions.userId} = "users"."id")`,
        reminders30: sql<string>`(select count(*) from ${reminderSends} where ${reminderSends.userId} = "users"."id" and ${reminderSends.sentAt} >= now() - interval '30 days')`,
      })
      .from(users)
      .orderBy(users.createdAt),
    db.execute<UsageRow>(USAGE_QUERY),
    db.execute<LastSyncRow>(LAST_SYNC_QUERY),
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

  const lastSyncByAccount = new Map<string, Date | null>();
  for (const row of lastSyncRows.rows) {
    lastSyncByAccount.set(row.user_id, row.last_sync_at);
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

    const lastSyncAt = lastSyncByAccount.get(row.id) ?? null;

    return {
      id: row.id,
      label: row.label,
      status,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
      lastSyncAt: lastSyncAt ? lastSyncAt.toISOString() : null,
      activeDays30: Number(row.activeDays30),
      bytes: usage.totalBytes,
      modules: usage.modules,
      devices: credentialCount,
      sessions: Number(row.sessionCount),
      recovery: { unused: Number(row.recoveryUnused), total: Number(row.recoveryTotal) },
      push: { subscriptions: Number(row.pushSubs), reminders30: Number(row.reminders30) },
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
