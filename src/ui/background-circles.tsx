import './background-circles.css';

/**
 * Fixed decorative layer behind every route's ground (S3 of #828, issue #829).
 * Presentational only — no props, no state, no client JS; the per-route
 * arrangement and gait live entirely in background-circles.css via `:has()`.
 */
export function BackgroundCircles() {
  return (
    <div className="bg-layer" aria-hidden="true">
      <span className="bg-circle" />
      <span className="bg-circle" />
      <span className="bg-circle" />
      <span className="bg-circle" />
    </div>
  );
}
