import './background-arcs.css';

/**
 * Fixed decorative layer behind every route's ground (S3 of #828, issue #829;
 * replaced by three stacked, independently pulsing arcs in the "Foto-Rezept"
 * colour scheme, issue #991). Presentational only — no state, no client JS;
 * the per-route tones live entirely in globals.css, the shared geometry/motion
 * in background-arcs.css via `:has()`.
 *
 * `variant="nav"` mounts the identical arcs a second time inside the mobile
 * nav row (issue #1006), where they stand in for the flat fill that used to
 * hide scrolled content there — same elements, same keyframes, so the copy
 * can never drift from the background it stands in for. Everything that
 * differs is CSS (`.bg-layer--nav`).
 */
export function BackgroundArcs({ variant }: { variant?: 'nav' }) {
  return (
    <div className={variant === 'nav' ? 'bg-layer bg-layer--nav' : 'bg-layer'} aria-hidden="true">
      <span className="bg-arc" />
      <span className="bg-arc" />
      <span className="bg-arc" />
    </div>
  );
}
