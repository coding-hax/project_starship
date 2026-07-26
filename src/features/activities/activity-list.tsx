'use client';

import { formatStaleSince, isStaleWarning } from '@/ui/stale';
import { ActivityBlock } from './activity-block';
import { formatDistance } from './format';
import { computeRecap } from './recap';
import { useActivities } from './use-activities';
import { useActivitySync } from './use-activity-sync';

/**
 * `/aktivitaeten` (issue #180): a 30-day recap on top, then one block per
 * activity, newest first. `undefined` from `useActivities` means the first read
 * is still in flight (skeleton), `[]` means there really are none (empty state) —
 * these are never conflated, see `use-live-table.ts`.
 *
 * `useActivitySync` (issue #230) keeps the underlying rows current; it is a side
 * effect only — everything rendered here still comes from IndexedDB.
 */
export function ActivityList() {
  const activities = useActivities();
  const lastSyncAt = useActivitySync();

  // Only ever a warning, never routine housekeeping: below the threshold the page
  // says nothing at all (issue #230 AC4).
  const caption =
    lastSyncAt && isStaleWarning(lastSyncAt) ? (
      <p className="activity-list__caption">Stand: {formatStaleSince(lastSyncAt)}</p>
    ) : null;

  if (activities === undefined) {
    return (
      <section className="activity-list" aria-busy="true">
        <p className="activity-list__recap activity-list__recap--skeleton">&nbsp;</p>
        <div className="activity-block activity-block--skeleton" aria-hidden="true" />
      </section>
    );
  }

  if (activities.length === 0) {
    return (
      <section className="activity-list">
        <p className="activity-list__empty">
          Noch keine Aktivitäten. Sobald der Abgleich gelaufen ist, erscheinen sie hier.
        </p>
        {caption}
      </section>
    );
  }

  const recap = computeRecap(activities, new Date());

  return (
    <section className="activity-list">
      <p className="activity-list__recap">
        Letzte 30 Tage: {recap.count} {recap.count === 1 ? 'Aktivität' : 'Aktivitäten'} ·{' '}
        {formatDistance(recap.meters)}
      </p>
      {activities.map((activity) => (
        <ActivityBlock key={activity.id} activity={activity} />
      ))}
      {caption}
    </section>
  );
}
