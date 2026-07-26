export interface MonthlySummarySource {
  activityType: string;
  startedAt: string;
  distanceMeters: number | null;
}

export interface ActivityTypeSummary {
  type: string;
  count: number;
  meters: number;
}

export interface MonthlySummary {
  byType: ActivityTypeSummary[];
  totalCount: number;
  totalMeters: number;
}

const TYPE_LABELS: Record<string, string> = {
  running: 'Laufen',
  cycling: 'Radfahren',
  walking: 'Gehen',
  hiking: 'Wandern',
  swimming: 'Schwimmen',
};

/**
 * Garmin has dozens of `activityType.typeKey` values — keeping this list complete
 * would be a never-ending task, so an unknown key falls back to "Sonstiges" instead
 * of being swallowed, same pattern as `wmo-icon.ts` for weather codes.
 */
export function activityTypeLabel(typeKey: string): string {
  return TYPE_LABELS[typeKey] ?? 'Sonstiges';
}

/**
 * The current calendar month (local time, month-first 00:00 through `now`) — the
 * /uebersicht strip's window, distinct from `computeRecap`'s rolling 30 days on the
 * Aktivitäten page itself; both are shown side by side, each naming its own span.
 * Sorted by count desc, then km desc, so the order never jitters on re-render as
 * the same totals arrive in a different row order from IndexedDB.
 */
export function computeMonthlySummary(activities: MonthlySummarySource[], now: Date): MonthlySummary {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);

  const byType = new Map<string, ActivityTypeSummary>();
  let totalCount = 0;
  let totalMeters = 0;

  for (const activity of activities) {
    const startedAt = new Date(activity.startedAt);
    if (startedAt < monthStart || startedAt > now) continue;

    const existing = byType.get(activity.activityType) ?? {
      type: activity.activityType,
      count: 0,
      meters: 0,
    };
    existing.count += 1;
    if (activity.distanceMeters != null) existing.meters += activity.distanceMeters;
    byType.set(activity.activityType, existing);

    totalCount += 1;
    if (activity.distanceMeters != null) totalMeters += activity.distanceMeters;
  }

  const sorted = [...byType.values()].sort((a, b) => b.count - a.count || b.meters - a.meters);

  return { byType: sorted, totalCount, totalMeters };
}
