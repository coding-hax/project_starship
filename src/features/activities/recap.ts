export interface RecapSource {
  startedAt: string;
  distanceMeters: number | null;
}

export interface Recap {
  count: number;
  meters: number;
}

/**
 * Rolling window ending at `now` — `days` back, inclusive on both ends. Used for
 * the page's own 30-day recap, distinct from `computeMonthlySummary`'s calendar
 * month (that one backs the /uebersicht strip). An activity without
 * `distanceMeters` still counts toward `count`, just not toward `meters` — Garmin
 * reports this for some strength sessions.
 */
export function computeRecap(activities: RecapSource[], now: Date, days = 30): Recap {
  const windowStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  let count = 0;
  let meters = 0;
  for (const activity of activities) {
    const startedAt = new Date(activity.startedAt);
    if (startedAt < windowStart || startedAt > now) continue;
    count += 1;
    if (activity.distanceMeters != null) meters += activity.distanceMeters;
  }

  return { count, meters };
}
