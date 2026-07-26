'use client';

import { ActivityBlock } from './activity-block';
import { formatDistance } from './format';
import { computeRecap } from './recap';
import { useActivities } from './use-activities';

/**
 * `/aktivitaeten` (issue #180): a 30-day recap on top, then one block per
 * activity, newest first. `undefined` from `useActivities` means the first read
 * is still in flight (skeleton), `[]` means there really are none (empty state) —
 * these are never conflated, see `use-live-table.ts`.
 */
export function ActivityList() {
  const activities = useActivities();

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
          Noch keine Aktivitäten. Sobald der nächtliche Abgleich gelaufen ist, erscheinen sie hier.
        </p>
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
    </section>
  );
}
