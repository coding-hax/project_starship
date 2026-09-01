import './background-arcs.css';

/**
 * Fixed decorative layer behind every route's ground (S3 of #828, issue #829;
 * replaced by three stacked, independently pulsing arcs in the "Foto-Rezept"
 * colour scheme, issue #991). Presentational only — no props, no state, no
 * client JS; the per-route tones live entirely in globals.css, the shared
 * geometry/motion in background-arcs.css via `:has()`.
 */
export function BackgroundArcs() {
  return (
    <div className="bg-layer" aria-hidden="true">
      <span className="bg-arc" />
      <span className="bg-arc" />
      <span className="bg-arc" />
    </div>
  );
}
