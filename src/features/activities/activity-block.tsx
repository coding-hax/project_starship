import { ActivityChart } from './activity-chart';
import { ActivityMap } from './activity-map';
import {
  formatDistance,
  formatElevation,
  formatHr,
  formatPace,
  formatPaceSecondsPerKm,
  formatPause,
} from './format';
import { paceSeries } from './line-path';
import type { ActivityView } from './use-activities';

const DATE_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

interface StatRow {
  label: string;
  value: string;
}

/**
 * Missing head numbers drop their row entirely rather than showing a dash — the
 * dash in `format.ts` is for a value that must always render something (a chart
 * axis label); a whole missing line here is just missing, not worth the space.
 * Pauses are computed here, never stored (elapsed − moving), and only shown when
 * both inputs exist.
 */
function buildStats(activity: ActivityView): StatRow[] {
  const rows: StatRow[] = [];
  if (activity.distanceMeters != null) {
    rows.push({ label: 'Distanz', value: formatDistance(activity.distanceMeters) });
  }
  if (activity.averageSpeed != null) {
    rows.push({ label: 'Ø-Pace', value: formatPace(activity.averageSpeed) });
  }
  if (activity.elevationGain != null) {
    rows.push({ label: 'Höhenmeter', value: formatElevation(activity.elevationGain) });
  }
  if (activity.averageHr != null) {
    rows.push({ label: 'Ø-HF', value: formatHr(activity.averageHr) });
  }
  if (activity.elapsedSeconds != null && activity.durationSeconds != null) {
    rows.push({
      label: 'Pausen',
      value: formatPause(activity.elapsedSeconds - activity.durationSeconds),
    });
  }
  return rows;
}

/**
 * One activity, newest block first (issue #180). Card order is deliberate: map,
 * then head numbers, then the three curves, exactly as specified in the ticket.
 */
export function ActivityBlock({ activity }: { activity: ActivityView }) {
  const title = activity.name ?? activity.activityType;
  const stats = buildStats(activity);
  const track = activity.track;

  return (
    <article className="activity-block">
      <ActivityMap activity={activity} />
      <h2 className="activity-block__title">{title}</h2>
      <p className="activity-block__date">{DATE_FORMATTER.format(new Date(activity.startedAt))}</p>
      {stats.length > 0 ? (
        <dl className="activity-block__stats">
          {stats.map((row) => (
            <div className="activity-block__stat" key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {track ? (
        <>
          <ActivityChart
            label="Herzfrequenz"
            values={track.hr ?? []}
            formatValue={(v) => `${Math.round(v)} bpm`}
          />
          <ActivityChart
            label="Pace"
            values={paceSeries(track.speed ?? [])}
            formatValue={formatPaceSecondsPerKm}
          />
          <ActivityChart
            label="Höhenprofil"
            values={track.elevation ?? []}
            formatValue={(v) => `${Math.round(v)} m`}
          />
        </>
      ) : null}
    </article>
  );
}
