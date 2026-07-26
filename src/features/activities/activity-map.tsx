import { projectTrack } from './track-path';
import type { ActivityView } from './use-activities';

// Fixed 16:9 canvas for the SVG fallback — the container itself carries the
// `aspect-ratio` (activity-map.css), so an <img> and this <svg> always occupy
// exactly the same space and swapping between them never shifts the layout.
const MAP_WIDTH = 400;
const MAP_HEIGHT = 225;

/**
 * Route map for one activity (issue #180). `mapImage` (a data URL, no network in
 * the client — issue #186) wins when present. Otherwise the raw track coordinates
 * are projected into an SVG line (`track-path.ts`) so the map keeps working even
 * with the map service down or `GARMIN_MAP_KEY` unset. With neither, nothing
 * renders — a missing map is a normal partial result from #186, not an error, so
 * there is no empty box to draw.
 */
export function ActivityMap({ activity }: { activity: ActivityView }) {
  if (activity.mapImage) {
    return (
      <div className="activity-map">
        <img
          className="activity-map__image"
          src={activity.mapImage}
          alt=""
          loading="lazy"
          decoding="async"
        />
      </div>
    );
  }

  const track = activity.track;
  const path = track ? projectTrack(track.lat ?? [], track.lon ?? [], MAP_WIDTH, MAP_HEIGHT) : null;
  if (!path) return null;

  return (
    <div className="activity-map">
      <svg
        className="activity-map__svg"
        viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
        role="img"
        aria-label="Streckenverlauf"
      >
        <path d={path} fill="none" stroke="currentColor" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}
