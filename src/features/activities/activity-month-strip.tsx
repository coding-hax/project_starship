'use client';

import Link from 'next/link';
import { OverviewBlock } from '@/ui/overview-block';
import { useBlockReady } from '@/ui/overview-ready';
import { formatDistance } from './format';
import { activityTypeLabel, computeMonthlySummary } from './monthly-summary';
import { useActivities } from './use-activities';

const MONTH_FORMATTER = new Intl.DateTimeFormat('de-DE', { month: 'long' });

/**
 * Monthly recap strip on /uebersicht, under the task list (issue #180). Reads via
 * the same `useActivities` hook the Aktivitäten page uses — no second read path.
 * Three states, deliberately distinct:
 *
 * - never any activity at all (Garmin never set up, #186 never ran) → renders
 *   nothing. A permanently empty box on the most-visited screen would be noise.
 * - activities exist, just none in the current calendar month → a calm note.
 * - activities this month → the breakdown by type.
 *
 * The whole area is one `<Link>`, not several tap targets next to each other.
 *
 * The skeleton below is why this block joins the overview's reveal point (issue
 * #642) even though it already reserves height: at zero activities it reserves
 * that height and then gives it back (`return null`), which shifts just as hard
 * as popping in. Inside `OverviewReadyProvider` that swap happens while the area
 * is still hidden. The branch stays rather than being deleted — it is the correct
 * behaviour for a host without the provider, and `aktivitaeten.spec.ts` pins its
 * reduced-motion contract.
 */
export function ActivityMonthStrip() {
  const activities = useActivities();

  useBlockReady(activities !== undefined);

  if (activities === undefined) {
    return (
      <div className="activity-month-strip activity-month-strip--skeleton" aria-hidden="true">
        <p className="activity-month-strip__heading">&nbsp;</p>
        <p className="activity-month-strip__row activity-month-strip__row--skeleton">&nbsp;</p>
      </div>
    );
  }

  if (activities.length === 0) return null;

  const now = new Date();
  const summary = computeMonthlySummary(activities, now);
  const monthLabel = MONTH_FORMATTER.format(now);

  if (summary.totalCount === 0) {
    return (
      <OverviewBlock title="Aktivitäten" area="var(--area-activities)">
        <Link href="/aktivitaeten" className="activity-month-strip">
          <p className="activity-month-strip__heading">{monthLabel}</p>
          <p className="activity-month-strip__empty">Diesen Monat noch nichts aufgezeichnet.</p>
        </Link>
      </OverviewBlock>
    );
  }

  return (
    <OverviewBlock title="Aktivitäten" area="var(--area-activities)">
      <Link href="/aktivitaeten" className="activity-month-strip">
        <p className="activity-month-strip__heading">{monthLabel}</p>
        <ul className="activity-month-strip__list">
          {summary.byType.map((row) => (
            <li key={row.type} className="activity-month-strip__row">
              {row.count}× {activityTypeLabel(row.type)} · {formatDistance(row.meters)}
            </li>
          ))}
        </ul>
      </Link>
    </OverviewBlock>
  );
}
