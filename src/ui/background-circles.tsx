import './background-circles.css';

/**
 * Fixed decorative layer behind every route's ground (S3 of #828, issue #829;
 * three ambient lights added in issue #904). Presentational only — no props,
 * no state, no client JS; the per-route arrangement/gait live entirely in
 * background-circles.css via `:has()` (the lights carry none, #904 AK2).
 */
export function BackgroundCircles() {
  return (
    <div className="bg-layer" aria-hidden="true">
      <span className="bg-light" />
      <span className="bg-light" />
      <span className="bg-light" />
      <span className="bg-circle" />
      <span className="bg-circle" />
      <span className="bg-circle" />
      <span className="bg-circle" />
      {/* Last child so plain DOM order — no z-index — stacks it above the
          circles within the layer (issue #919). */}
      <div className="bg-layer__veil" />
    </div>
  );
}
