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
  /** Minutes of Neon wake-time this account caused in the last 30 days, and its
   * share (0–100) of the total across all accounts + system sources (#1233 AK5). */
  wakeMinutes30: number;
  wakeShare: number;
  /** 30-day sums from `account_sync_counters` (#1235 AK1-AK3) — only numbers,
   * never a mutation id, table name, endpoint, or error text (AK8). */
  sync: {
    rejections: { malformed: number; missingRequired: number; constraint: number; quota: number };
    conflicts: number;
    fullPulls: number;
    pushDropped: number;
    pushFailed: number;
  };
  /** Active sessions whose last reported `app_version` differs from the
   * server's own build (#1235 AK4). */
  staleDevices: number;
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
    /** Neon wake-time of the last 30 days, split by who caused it (#1233 AK6). */
    wake: { totalMinutes: number; cronMinutes: number; deployProbeMinutes: number };
  };
  accounts: AccountOverviewRow[];
  invites: InviteOverviewRow[];
  audit: AuditOverviewRow[];
}

/** How far back the admin UI shows the log (AK8: "sichtbar"), not a retention limit. */
const AUDIT_DISPLAY_LIMIT = 200;

type ModuleKey = 'aufgaben' | 'termine' | 'routinen' | 'journal';

function emptySync(): AccountOverviewRow['sync'] {
  return {
    rejections: { malformed: 0, missingRequired: 0, constraint: 0, quota: 0 },
    conflicts: 0,
    fullPulls: 0,
    pushDropped: 0,
    pushFailed: 0,
  };
}

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
  // Raw driver value, not a `Date`: `db.execute()` returns timestamptz columns as
  // the Postgres text representation (e.g. `2026-10-19 20:41:08.817+02`), unlike
  // `db.select()`, which maps them through the schema's column type.
  last_sync_at: string | null;
}

/**
 * Recovery/push health (AK1-AK3 of #1234) — three small grouped aggregates, one
 * row per account, not four correlated subqueries evaluated once per account
 * row the way `credentialCount`/`sessionCount`/`activeDays30` below still are.
 * Same reasoning as `LAST_SYNC_QUERY` above: a plan that correlates once in
 * total, not once per row, so the main `accountRows` select below stays at its
 * original (S4, #1203) cost regardless of how many accounts exist.
 */
const HEALTH_QUERY = sql`
  with recovery as (
    select user_id,
      count(*) filter (where used_at is null) as unused,
      count(*) as total
    from recovery_codes
    group by user_id
  ),
  push as (
    select user_id, count(*) as subscriptions
    from push_subscriptions
    group by user_id
  ),
  reminders as (
    select user_id, count(*) as reminders30
    from reminder_sends
    where sent_at >= now() - interval '30 days'
    group by user_id
  )
  select
    coalesce(recovery.user_id, push.user_id, reminders.user_id) as user_id,
    coalesce(recovery.unused, 0) as unused,
    coalesce(recovery.total, 0) as total,
    coalesce(push.subscriptions, 0) as subscriptions,
    coalesce(reminders.reminders30, 0) as reminders30
  from recovery
  full outer join push on push.user_id = recovery.user_id
  full outer join reminders on reminders.user_id = coalesce(recovery.user_id, push.user_id)
`;

interface HealthRow {
  [key: string]: unknown;
  user_id: string;
  unused: string;
  total: string;
  subscriptions: string;
  reminders30: string;
}

/**
 * Neon wake-time of the last 30 days (#1233 AK4-AK6), split evenly across every
 * source active in each 5-minute window: `win` counts, per `window_start`, how
 * many distinct sources touched it (the partial unique indexes on
 * `user_activity_windows` guarantee at most one row per source per window, so
 * `count(*)` *is* that source count); the outer query then attributes
 * `5.0 / sources` minutes to each row in that window and sums per source. The
 * sum of every row's share this way is exactly `count(distinct window_start) *
 * 5` — the total wake-time (AK4's "Summe aller Anteile ist genau die
 * Gesamtwachzeit") — without a second query to compute that total separately.
 */
const WAKE_QUERY = sql`
  with win as (
    select window_start, count(*)::numeric as sources
    from user_activity_windows
    where window_start >= now() - interval '30 days'
    group by window_start
  )
  select aw.user_id, aw.system_source, sum(5.0 / w.sources) as minutes
  from user_activity_windows aw
  join win w using (window_start)
  where aw.window_start >= now() - interval '30 days'
  group by aw.user_id, aw.system_source
`;

interface WakeRow {
  [key: string]: unknown;
  user_id: string | null;
  system_source: 'cron' | 'deploy-probe' | null;
  minutes: string;
}

/**
 * 30-day sums of `account_sync_counters` (#1235 AK7) — one row per account,
 * summed across days rather than correlated per account row, same reasoning as
 * `LAST_SYNC_QUERY`/`HEALTH_QUERY`/`WAKE_QUERY` above.
 */
const COUNTERS_QUERY = sql`
  select
    user_id,
    sum(rejected_malformed)::bigint as rejected_malformed,
    sum(rejected_missing_required)::bigint as rejected_missing_required,
    sum(rejected_constraint)::bigint as rejected_constraint,
    sum(rejected_quota)::bigint as rejected_quota,
    sum(conflicts)::bigint as conflicts,
    sum(full_pulls)::bigint as full_pulls,
    sum(push_subscriptions_dropped)::bigint as push_subscriptions_dropped,
    sum(push_delivery_failures)::bigint as push_delivery_failures
  from account_sync_counters
  where day >= current_date - 30
  group by user_id
`;

interface CountersRow {
  [key: string]: unknown;
  user_id: string;
  rejected_malformed: string;
  rejected_missing_required: string;
  rejected_constraint: string;
  rejected_quota: string;
  conflicts: string;
  full_pulls: string;
  push_subscriptions_dropped: string;
  push_delivery_failures: string;
}

/**
 * Active sessions reporting a build other than the server's own (#1235 AK4,
 * "andere Geräte"). `is distinct from` also counts a session as stale if the
 * server itself has no known build (`VERCEL_GIT_COMMIT_SHA` unset, e.g. local
 * dev) and the session reports one anyway — null-safe either direction.
 */
const STALE_DEVICES_QUERY = sql`
  select user_id, count(*)::bigint as stale
  from sessions
  where expires_at > now()
    and app_version is not null
    and app_version is distinct from ${process.env.VERCEL_GIT_COMMIT_SHA ?? null}
  group by user_id
`;

interface StaleDevicesRow {
  [key: string]: unknown;
  user_id: string;
  stale: string;
}

/**
 * The full `/api/admin/accounts` payload (AK2-AK7) — never a user content field
 * (AK8, see `src/app/api/admin/accounts/route.ts`'s own test). `cache()` (react)
 * memoises this for the lifetime of one request (AK4 "für die Dauer eines
 * Seitenaufrufs zwischengespeichert"), so a page render that also fetches the
 * route handler's own copy never runs the aggregation twice.
 */
export const getAccountsOverview = cache(async (): Promise<AccountsOverview> => {
  const [
    accountRows,
    usageRows,
    lastSyncRows,
    healthRows,
    wakeRows,
    countersRows,
    staleDevicesRows,
    inviteRows,
    auditRows,
  ] = await Promise.all([
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
    db.execute<LastSyncRow>(LAST_SYNC_QUERY),
    db.execute<HealthRow>(HEALTH_QUERY),
    db.execute<WakeRow>(WAKE_QUERY),
    db.execute<CountersRow>(COUNTERS_QUERY),
    db.execute<StaleDevicesRow>(STALE_DEVICES_QUERY),
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

  const lastSyncByAccount = new Map<string, string | null>();
  for (const row of lastSyncRows.rows) {
    lastSyncByAccount.set(row.user_id, row.last_sync_at ? new Date(row.last_sync_at).toISOString() : null);
  }

  const healthByAccount = new Map<string, AccountOverviewRow['recovery'] & AccountOverviewRow['push']>();
  for (const row of healthRows.rows) {
    healthByAccount.set(row.user_id, {
      unused: Number(row.unused),
      total: Number(row.total),
      subscriptions: Number(row.subscriptions),
      reminders30: Number(row.reminders30),
    });
  }

  const wakeByAccount = new Map<string, number>();
  let cronMinutes = 0;
  let deployProbeMinutes = 0;
  let totalWakeMinutes = 0;
  for (const row of wakeRows.rows) {
    const minutes = Number(row.minutes);
    totalWakeMinutes += minutes;
    if (row.user_id) {
      wakeByAccount.set(row.user_id, (wakeByAccount.get(row.user_id) ?? 0) + minutes);
    } else if (row.system_source === 'cron') {
      cronMinutes += minutes;
    } else if (row.system_source === 'deploy-probe') {
      deployProbeMinutes += minutes;
    }
  }

  const countersByAccount = new Map<string, AccountOverviewRow['sync']>();
  for (const row of countersRows.rows) {
    countersByAccount.set(row.user_id, {
      rejections: {
        malformed: Number(row.rejected_malformed),
        missingRequired: Number(row.rejected_missing_required),
        constraint: Number(row.rejected_constraint),
        quota: Number(row.rejected_quota),
      },
      conflicts: Number(row.conflicts),
      fullPulls: Number(row.full_pulls),
      pushDropped: Number(row.push_subscriptions_dropped),
      pushFailed: Number(row.push_delivery_failures),
    });
  }

  const staleDevicesByAccount = new Map<string, number>();
  for (const row of staleDevicesRows.rows) {
    staleDevicesByAccount.set(row.user_id, Number(row.stale));
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
    const health = healthByAccount.get(row.id) ?? { unused: 0, total: 0, subscriptions: 0, reminders30: 0 };
    const credentialCount = Number(row.credentialCount);
    const status: AccountStatus = row.blockedAt ? 'gesperrt' : credentialCount === 0 ? 'eingeladen' : 'aktiv';

    if (row.blockedAt) blocked += 1;
    if (row.lastSeenAt && row.lastSeenAt >= sevenDaysAgo) activeIn7 += 1;
    if (row.lastSeenAt && row.lastSeenAt >= thirtyDaysAgo) activeIn30 += 1;
    totalBytes += usage.totalBytes;

    const lastSyncAt = lastSyncByAccount.get(row.id) ?? null;
    const wakeMinutes30 = wakeByAccount.get(row.id) ?? 0;
    const wakeShare = totalWakeMinutes > 0 ? (wakeMinutes30 / totalWakeMinutes) * 100 : 0;

    return {
      id: row.id,
      label: row.label,
      status,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
      lastSyncAt,
      activeDays30: Number(row.activeDays30),
      bytes: usage.totalBytes,
      modules: usage.modules,
      devices: credentialCount,
      sessions: Number(row.sessionCount),
      recovery: { unused: health.unused, total: health.total },
      push: { subscriptions: health.subscriptions, reminders30: health.reminders30 },
      wakeMinutes30,
      wakeShare,
      sync: countersByAccount.get(row.id) ?? emptySync(),
      staleDevices: staleDevicesByAccount.get(row.id) ?? 0,
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
      wake: { totalMinutes: totalWakeMinutes, cronMinutes, deployProbeMinutes },
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
